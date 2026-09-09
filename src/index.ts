import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import rateLimit from '@fastify/rate-limit';
import { env } from './env.js';
import { db } from './db/client.js';
import { users, sources, samples, shareTokens, partnerOffers } from './db/schema.js';
import { eq, desc, and } from 'drizzle-orm';
import { hash, verify as argon2Verify } from '@node-rs/argon2';
import { computeScore, suggestLevers } from './score/index.js';
import { generate } from './mock/generate.js';
import { isWeakPassword } from './lib/weakPasswords.js';
import { signTokenPayload, verifyTokenSignature, buildTokenPayload } from './lib/signing.js';
import type { Sample } from './score/types.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface Session {
    userId?: string;
  }
}

async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const userId = req.session.userId;
  if (!userId) {
    reply.status(401).send({ title: 'Nicht angemeldet.' });
    return null;
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    reply.status(401).send({ title: 'Benutzer nicht gefunden.' });
    return null;
  }
  return user;
}

async function getUserSamples(userId: string): Promise<Sample[]> {
  const rows = await db.select().from(samples).where(eq(samples.userId, userId));
  return rows.map(r => ({
    metric: r.metric as Sample['metric'],
    value: r.value,
    unit: r.unit,
    measuredAt: r.measuredAt.toISOString(),
    sourceKind: 'apple_health' as Sample['sourceKind'],
  }));
}

const start = async () => {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true,
  });

  await app.register(rateLimit, {
    global: false,
  });

  await app.register(cookie);
  await app.register(session, {
    secret: env.SESSION_SECRET,
    cookie: {
      // Cloudflare terminates TLS — the API only sees HTTP from the tunnel.
      // Setting secure:true would suppress Set-Cookie on HTTP connections.
      // The cookie travels browser→Cloudflare over HTTPS, which is sufficient.
      secure: false,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
    saveUninitialized: true,
  });

  // ── Health ────────────────────────────────────────────────────────────────────

  app.get('/api/healthz', async () => {
    await db.execute('select 1');
    return { ok: true, db: true, engineVersion: '0.1.0', commit: env.COMMIT_SHA };
  });

  // ── Auth ──────────────────────────────────────────────────────────────────────

  app.post('/api/auth/register', async (req, reply) => {
    const body = req.body as { email?: string; password?: string; birthDate?: string; sex?: string; displayName?: string };
    const { email, password, birthDate, sex, displayName } = body;

    if (!email || !password || !birthDate || !sex) {
      return reply.status(400).send({ title: 'Pflichtfelder fehlen.' });
    }
    if (password.length < 10) {
      return reply.status(400).send({ title: 'Passwort muss mindestens 10 Zeichen haben.' });
    }
    if (isWeakPassword(password)) {
      return reply.status(400).send({ title: 'Dieses Passwort ist zu häufig. Bitte wähle ein sichereres Passwort.' });
    }
    if (sex !== 'm' && sex !== 'f') {
      return reply.status(400).send({ title: 'Ungültiges Geschlecht.' });
    }

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      return reply.status(409).send({ title: 'E-Mail bereits vergeben.' });
    }

    const passwordHash = await hash(password);
    const [user] = await db.insert(users).values({
      email, passwordHash, birthDate, sex, displayName: displayName ?? null,
    }).returning();

    const [src] = await db.insert(sources).values({
      userId: user.id, kind: 'apple_health', adapter: 'mock', enabled: true, lastSyncAt: new Date(),
    }).returning();

    const mockSamples = generate(user.id.charCodeAt(0) * 31 + 7, 90);
    if (mockSamples.length > 0) {
      await db.insert(samples).values(mockSamples.map(s => ({
        userId: user.id, sourceId: src.id,
        metric: s.metric, value: s.value, unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      })));
    }

    req.session.userId = user.id;
    return reply.status(201).send({ id: user.id, email: user.email });
  });

  app.post('/api/auth/login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        errorResponseBuilder: () => ({ title: 'Zu viele Login-Versuche. Bitte in 15 Minuten erneut versuchen.' }),
      },
    },
  }, async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      return reply.status(400).send({ title: 'E-Mail und Passwort erforderlich.' });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return reply.status(401).send({ title: 'E-Mail oder Passwort falsch.' });

    const ok = await argon2Verify(user.passwordHash, password);
    if (!ok) return reply.status(401).send({ title: 'E-Mail oder Passwort falsch.' });

    req.session.userId = user.id;
    return reply.status(200).send({ ok: true });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await req.session.destroy();
    return reply.status(204).send();
  });

  // ── Me ────────────────────────────────────────────────────────────────────────

  app.get('/api/me', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const now = new Date();
    const chronoAge = (now.getTime() - new Date(user.birthDate).getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    return {
      id: user.id, email: user.email, displayName: user.displayName,
      birthDate: user.birthDate, sex: user.sex,
      chronoAge: Math.round(chronoAge * 10) / 10,
    };
  });

  // ── Score ─────────────────────────────────────────────────────────────────────

  app.get('/api/score/current', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const userSamples = await getUserSamples(user.id);
    return computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples: userSamples,
      now: new Date(),
    });
  });

  app.get('/api/score/levers', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const userSamples = await getUserSamples(user.id);
    return suggestLevers({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples: userSamples,
      now: new Date(),
    });
  });

  // ── Sources ───────────────────────────────────────────────────────────────────

  app.get('/api/sources', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const rows = await db.select().from(sources).where(eq(sources.userId, user.id));
    const allSamples = await db.select({ sourceId: samples.sourceId }).from(samples).where(eq(samples.userId, user.id));

    const countMap = new Map<string, number>();
    for (const s of allSamples) countMap.set(s.sourceId, (countMap.get(s.sourceId) ?? 0) + 1);

    return rows.map(s => ({
      id: s.id, kind: s.kind, adapter: s.adapter, enabled: s.enabled,
      lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
      sampleCount: countMap.get(s.id) ?? 0,
    }));
  });

  // ── Share tokens ──────────────────────────────────────────────────────────────

  app.get('/api/share-tokens', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const rows = await db.select().from(shareTokens)
      .where(eq(shareTokens.userId, user.id))
      .orderBy(desc(shareTokens.issuedAt));

    return rows.map(t => ({
      id: t.id, bandLow: t.bandLow, bandHigh: t.bandHigh,
      issuedAt: t.issuedAt.toISOString(), expiresAt: t.expiresAt.toISOString(),
      revokedAt: t.revokedAt?.toISOString() ?? null, partnerRef: t.partnerRef,
    }));
  });

  app.post('/api/share-tokens', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const userSamples = await getUserSamples(user.id);
    const score = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples: userSamples, now: new Date(),
    });

    const { days: daysReq } = req.body as { days?: number };
    const validDays = [30, 90, 180].includes(daysReq ?? 0) ? (daysReq ?? 90) : 90;

    const id = crypto.randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + validDays * 24 * 60 * 60 * 1000);

    const payload = buildTokenPayload(id, score.band.low, score.band.high, expiresAt.toISOString());
    const signature = env.SIGNING_KEY_PRIVATE
      ? signTokenPayload(payload, env.SIGNING_KEY_PRIVATE)
      : id;

    const [token] = await db.insert(shareTokens).values({
      id, userId: user.id,
      bandLow: score.band.low, bandHigh: score.band.high,
      issuedAt, expiresAt, signature,
    }).returning();

    return reply.status(201).send({
      id: token.id, bandLow: token.bandLow, bandHigh: token.bandHigh,
      issuedAt: token.issuedAt.toISOString(), expiresAt: token.expiresAt.toISOString(),
      revokedAt: null, partnerRef: null,
    });
  });

  app.delete('/api/share-tokens/:id', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await db.update(shareTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareTokens.id, id), eq(shareTokens.userId, user.id)));
    return reply.status(204).send();
  });

  // ── Verify (public) ───────────────────────────────────────────────────────────

  app.get('/api/verify/:id', async (req) => {
    const { id } = req.params as { id: string };
    const [token] = await db.select().from(shareTokens).where(eq(shareTokens.id, id)).limit(1);

    if (!token) return { valid: false, reason: 'not_found' };
    if (token.revokedAt) return { valid: false, reason: 'revoked' };
    if (new Date() > token.expiresAt) return { valid: false, reason: 'expired' };

    // Verify Ed25519 signature when key is configured; fall back gracefully for legacy tokens
    if (env.SIGNING_KEY_PUBLIC && token.signature !== token.id) {
      const payload = buildTokenPayload(token.id, token.bandLow, token.bandHigh, token.expiresAt.toISOString());
      const valid = verifyTokenSignature(payload, token.signature, env.SIGNING_KEY_PUBLIC);
      if (!valid) return { valid: false, reason: 'invalid_signature' };
    }

    return {
      valid: true,
      band: { low: token.bandLow, high: token.bandHigh },
      issuedAt: token.issuedAt.toISOString(),
      expiresAt: token.expiresAt.toISOString(),
    };
  });

  // ── Partner offers ────────────────────────────────────────────────────────────

  app.get('/api/partner-offers', async (req) => {
    const rows = await db.select().from(partnerOffers).orderBy(partnerOffers.sortOrder);
    const userId = req.session.userId;

    let band = { low: 0, high: 100 };
    if (userId) {
      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (user) {
        const userSamples = await getUserSamples(userId);
        const score = computeScore({
          profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
          samples: userSamples, now: new Date(),
        });
        band = score.band;
      }
    }

    return rows.map(o => ({
      id: o.id, partnerName: o.partnerName, title: o.title,
      description: o.description, minBand: o.minBand,
      valueLabel: o.valueLabel, isDemo: o.isDemo,
      qualified: band.low >= o.minBand,
    }));
  });

  try {
    await app.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
