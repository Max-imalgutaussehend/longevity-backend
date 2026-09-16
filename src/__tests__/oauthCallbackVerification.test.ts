process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import type { OAuthProvider } from '../lib/oauthTokens.js';

describe('OAuth Callback Verification (HEAD & Probe Requests) (#34)', () => {
  let oauthProviders: Record<string, OAuthProvider>;

  beforeAll(async () => {
    const mod = await import('../lib/oauthProviders.js');
    oauthProviders = mod.oauthProviders;
  });
  function createTestServer() {
    const app = Fastify();

    // HEAD handler for providers (e.g. Withings) that probe callback reachability
    app.head('/api/oauth/callback/:provider', async (req, reply) => {
      const { provider } = req.params as { provider: string };
      const oauthProvider = oauthProviders[provider];
      if (!oauthProvider) return reply.status(404).send();
      return reply.status(200).send();
    });

    app.get('/api/oauth/callback/:provider', async (req, reply) => {
      const { provider } = req.params as { provider: string };
      const { code, state } = req.query as { code?: string; state?: string };
      const oauthProvider = oauthProviders[provider];
      if (!oauthProvider) return reply.status(404).send({ title: 'Unbekannter Provider.' });

      // Withings and other OAuth providers ping callback URLs with empty GET/HEAD to verify reachability
      if (!code && !state) {
        return reply.status(200).send({ ok: true, message: 'OAuth callback endpoint ready.' });
      }
      if (!code || !state) return reply.status(400).send({ title: 'code oder state fehlt.' });

      return reply.status(200).send({ ok: true, code, state });
    });

    app.head('/api/sources/google/callback', async (_req, reply) => {
      return reply.status(200).send();
    });

    app.get('/api/sources/google/callback', async (req, reply) => {
      const { code, state } = req.query as { code?: string; state?: string };
      const oauthProvider = oauthProviders['google-fit'];
      if (!oauthProvider) return reply.status(404).send({ title: 'Unbekannter Provider.' });

      if (!code && !state) {
        return reply.status(200).send({ ok: true, message: 'OAuth callback endpoint ready.' });
      }
      if (!code || !state) return reply.status(400).send({ title: 'code oder state fehlt.' });

      return reply.status(200).send({ ok: true, code, state });
    });

    return app;
  }

  it('responds with 200 OK to HEAD /api/oauth/callback/withings', async () => {
    const app = createTestServer();
    const res = await app.inject({
      method: 'HEAD',
      url: '/api/oauth/callback/withings',
    });
    expect(res.statusCode).toBe(200);
  });

  it('responds with 200 OK to empty GET /api/oauth/callback/withings probe', async () => {
    const app = createTestServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/oauth/callback/withings',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.message).toContain('ready');
  });

  it('responds with 404 to HEAD /api/oauth/callback/unknown', async () => {
    const app = createTestServer();
    const res = await app.inject({
      method: 'HEAD',
      url: '/api/oauth/callback/nonexistent_provider',
    });
    expect(res.statusCode).toBe(404);
  });

  it('responds with 404 to empty GET /api/oauth/callback/unknown', async () => {
    const app = createTestServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/oauth/callback/nonexistent_provider',
    });
    expect(res.statusCode).toBe(404);
  });

  it('responds with 400 when only code is provided without state', async () => {
    const app = createTestServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/oauth/callback/withings?code=auth_code_123',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).title).toContain('code oder state fehlt');
  });

  it('responds with 400 when only state is provided without code', async () => {
    const app = createTestServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/oauth/callback/withings?state=state_123',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).title).toContain('code oder state fehlt');
  });

  it('responds with 200 OK to HEAD /api/sources/google/callback', async () => {
    const app = createTestServer();
    const res = await app.inject({
      method: 'HEAD',
      url: '/api/sources/google/callback',
    });
    expect(res.statusCode).toBe(200);
  });

  it('responds with 200 OK to empty GET /api/sources/google/callback', async () => {
    const app = createTestServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/sources/google/callback',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });
});
