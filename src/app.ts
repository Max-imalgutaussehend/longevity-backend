import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import csrf from '@fastify/csrf-protection';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from './env.js';
import { PgSessionStore } from './lib/pgSessionStore.js';
import { isCsrfExempt } from './lib/csrf.js';
import { authRoutes } from './routes/auth.js';
import { scoreRoutes } from './routes/score.js';
import { accountRoutes } from './routes/account.js';
import { sourcesRoutes } from './routes/sources.js';
import { reportRoutes } from './routes/reports.js';
import { shareRoutes } from './routes/share.js';
import { insurerRoutes } from './routes/insurer.js';
import { captureException } from './lib/sentry.js';
import './types.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true,
  });

  // ── Global error hook: forward 5xx errors to Sentry ─────────────────────────
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      captureException(error, {
        adapter: (request.routerPath ?? '').split('/')[3], // e.g. /api/sources/sync → 'sync'
      });
    }
    reply.status(statusCode).send({ title: error.message });
  });

  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } }); // 500 MB cap for AH exports (ZIP or raw XML)

  await app.register(cookie);
  await app.register(session, {
    secret: env.SESSION_SECRET,
    store: new PgSessionStore(),
    cookie: {
      // With trustProxy: true, 'auto' detects HTTPS via X-Forwarded-Proto header.
      // In production and over HTTPS connections, the cookie is marked Secure.
      secure: 'auto',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
    saveUninitialized: false,
  });

  await app.register(csrf, {
    cookieKey: '_csrf',
    cookieOpts: {
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
      secure: 'auto',
    },
    getToken: (req) => {
      const body = req.body as Record<string, unknown> | null | undefined;
      const csrfFromBody = typeof body?._csrf === 'string' ? body._csrf : undefined;
      return (
        csrfFromBody ||
        (req.headers['x-csrf-token'] as string | undefined) ||
        (req.headers['csrf-token'] as string | undefined) ||
        (req.headers['xsrf-token'] as string | undefined) ||
        (req.headers['x-xsrf-token'] as string | undefined)
      );
    },
  });

  app.addHook('preValidation', (req, reply, done) => {
    if (isCsrfExempt(req.url, req.method)) {
      return done();
    }
    // In test environment, skip CSRF validation unless CSRF is explicitly enforced or tested
    if (env.NODE_ENV === 'test' && !req.headers['x-enforce-csrf'] && !req.cookies._csrf) {
      return done();
    }
    app.csrfProtection(req, reply, done);
  });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (typeof body !== 'string' || body.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // ── OpenAPI spec ────────────────────────────────────────────────────────────
  const openApiPath = resolve(process.cwd(), 'openapi.json');
  app.get('/api/openapi.json', { config: {} }, async (req, reply) => {
    if (!existsSync(openApiPath)) {
      return reply.status(404).send({ title: 'OpenAPI specification not found' });
    }
    const content = readFileSync(openApiPath, 'utf-8');
    reply.type('application/json');
    return reply.send(content);
  });

  // ── Healthcheck ─────────────────────────────────────────────────────────────
  app.get('/api/healthz', async () => {
    return { ok: true };
  });

  // ── Modular Routes ──────────────────────────────────────────────────────────
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(scoreRoutes, { prefix: '/api/score' });
  await app.register(reportRoutes, { prefix: '/api/report' });
  await app.register(accountRoutes, { prefix: '/api' });
  await app.register(sourcesRoutes, { prefix: '/api' });
  await app.register(shareRoutes, { prefix: '/api' });
  await app.register(insurerRoutes, { prefix: '/api' });

  return app;
}
