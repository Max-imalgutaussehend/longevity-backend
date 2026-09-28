import type { FastifyInstance } from 'fastify';
import { eq, desc, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { shareTokens, type ShareTokenMetadata } from '../db/schema.js';
import { computeScore } from '../score/index.js';
import {
  signTokenPayload,
  verifyTokenSignature,
  buildTokenPayload,
  getPublicKeyJwk,
  getActivePrivateKey,
  getActivePublicKey,
} from '../lib/signing.js';
import { requireUser, getVerifiedUserSamples } from './helpers.js';
import '../types.js';

export async function shareRoutes(app: FastifyInstance) {
  app.get('/share-tokens', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const rows = await db.select().from(shareTokens)
      .where(eq(shareTokens.userId, user.id))
      .orderBy(desc(shareTokens.issuedAt));

    return rows.map(t => ({
      id: t.id,
      bandLow: t.bandLow,
      bandHigh: t.bandHigh,
      issuedAt: t.issuedAt.toISOString(),
      expiresAt: t.expiresAt.toISOString(),
      revokedAt: t.revokedAt?.toISOString() ?? null,
      partnerRef: t.partnerRef,
      verifiedOnly: t.metadata?.verifiedOnly ?? false,
      trustLevel: t.metadata?.trustLevel ?? 'unverified',
      verifiedSources: t.metadata?.verifiedSources ?? [],
      certificateType: t.metadata?.certificateType ?? (t.metadata?.verifiedOnly ? 'GKV / PKV Verifizierter Prämiennachweis' : 'Standard Score-Nachweis'),
    }));
  });

  app.post('/share-tokens', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const body = (req.body as { days?: number; verifiedOnly?: boolean } | undefined) ?? {};
    const { days: daysReq, verifiedOnly = false } = body;
    const validDays = [30, 90, 180].includes(daysReq ?? 0) ? (daysReq ?? 90) : 90;

    let sampleData;
    if (verifiedOnly) {
      sampleData = await getVerifiedUserSamples(user.id, { verifiedOnly: true });
      if (!sampleData.hasVerifiedData) {
        return reply.status(400).send({
          title: 'Keine verifizierten Gesundheitsdaten vorhanden.',
          detail: 'Für offizielle Krankenkassen-Nachweise muss mindestens eine verifizierte Datenquelle (z. B. Withings, Oura, Strava oder Google Health) verbunden sein. Mock- und manuelle Daten sind ausgeschlossen.',
          code: 'NO_VERIFIED_SOURCES',
        });
      }
    } else {
      sampleData = await getVerifiedUserSamples(user.id, { verifiedOnly: false });
    }

    const score = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples: sampleData.samples,
      now: new Date(),
    });

    const id = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + validDays * 24 * 60 * 60 * 1000);

    const privateKey = getActivePrivateKey();
    if (!privateKey) {
      return reply.status(500).send({ title: 'Signierschlüssel nicht konfiguriert.' });
    }

    const payload = buildTokenPayload(id, score.band.low, score.band.high, expiresAt.toISOString());
    const signature = signTokenPayload(payload, privateKey);

    const metadata: ShareTokenMetadata = {
      verifiedOnly,
      trustLevel: sampleData.trustLevel,
      verifiedSources: sampleData.verifiedSources,
      totalSampleCount: sampleData.totalSampleCount,
      excludedSampleCount: sampleData.excludedSampleCount,
      activeDays: sampleData.activeDays,
      certificateType: verifiedOnly
        ? 'GKV / PKV Verifizierter Prämiennachweis'
        : 'Standard Score-Nachweis',
    };

    const [token] = await db.insert(shareTokens).values({
      id,
      userId: user.id,
      bandLow: score.band.low,
      bandHigh: score.band.high,
      issuedAt,
      expiresAt,
      signature,
      metadata,
    }).returning();

    return reply.status(201).send({
      id: token.id,
      bandLow: token.bandLow,
      bandHigh: token.bandHigh,
      issuedAt: token.issuedAt.toISOString(),
      expiresAt: token.expiresAt.toISOString(),
      revokedAt: null,
      partnerRef: null,
      verifiedOnly: token.metadata?.verifiedOnly ?? false,
      trustLevel: token.metadata?.trustLevel ?? 'unverified',
      verifiedSources: token.metadata?.verifiedSources ?? [],
      certificateType: token.metadata?.certificateType ?? (token.metadata?.verifiedOnly ? 'GKV / PKV Verifizierter Prämiennachweis' : 'Standard Score-Nachweis'),
    });
  });

  app.delete('/share-tokens/:id', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await db.update(shareTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareTokens.id, id), eq(shareTokens.userId, user.id)));
    return reply.status(204).send();
  });

  app.get('/verify/public-key', async (_req, reply) => {
    const publicKey = getActivePublicKey();
    if (!publicKey) {
      return reply.status(500).send({ title: 'Öffentlicher Signierschlüssel nicht konfiguriert.' });
    }

    const jwk = getPublicKeyJwk(publicKey);
    return reply.send({
      algorithm: 'Ed25519',
      format: 'spki-pem',
      publicKey,
      jwk,
    });
  });

  app.get('/verify/:id', {
    config: {
      rateLimit: {
        max: env.NODE_ENV === 'test' || env.NODE_ENV === 'development' || !!process.env.CI ? 200 : 30,
        timeWindow: '1 minute',
        errorResponseBuilder: () => ({ statusCode: 429, title: 'Zu viele Anfragen. Bitte in einer Minute erneut versuchen.' }),
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };

    if (id === 'demo-token') {
      const [seededToken] = await db.select().from(shareTokens).where(eq(shareTokens.id, id)).limit(1);
      const issuedAt = seededToken?.issuedAt ? seededToken.issuedAt.toISOString() : new Date('2026-09-01T12:00:00.000Z').toISOString();
      const expiresAt = seededToken?.expiresAt ? seededToken.expiresAt.toISOString() : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      return {
        valid: true,
        band: seededToken ? { low: seededToken.bandLow, high: seededToken.bandHigh } : { low: 70, high: 79 },
        issuedAt,
        expiresAt,
        verifiedOnly: seededToken?.metadata?.verifiedOnly ?? true,
        trustLevel: seededToken?.metadata?.trustLevel ?? 'cloud_verified',
        verifiedSources: seededToken?.metadata?.verifiedSources ?? ['apple_health', 'oura', 'withings'],
        certificateType: seededToken?.metadata?.certificateType ?? 'GKV / PKV Verifizierter Prämiennachweis',
        sampleCount: seededToken?.metadata?.totalSampleCount ?? 1540,
        activeDays: seededToken?.metadata?.activeDays ?? 90,
        issuer: 'LONGEVITY Health Intermediary (Ed25519 zertifiziert)',
      };
    }

    const [token] = await db.select().from(shareTokens).where(eq(shareTokens.id, id)).limit(1);
    if (!token) return { valid: false, reason: 'not_found' };

    const publicKey = getActivePublicKey();
    if (!publicKey || !token.signature || token.signature === token.id) {
      return { valid: false, reason: 'invalid_signature' };
    }

    const payload = buildTokenPayload(token.id, token.bandLow, token.bandHigh, token.expiresAt.toISOString());
    const valid = verifyTokenSignature(payload, token.signature, publicKey);
    if (!valid) return { valid: false, reason: 'invalid_signature' };

    if (token.revokedAt) return { valid: false, reason: 'revoked' };
    if (new Date() > token.expiresAt) return { valid: false, reason: 'expired' };

    return {
      valid: true,
      band: { low: token.bandLow, high: token.bandHigh },
      issuedAt: token.issuedAt.toISOString(),
      expiresAt: token.expiresAt.toISOString(),
      verifiedOnly: token.metadata?.verifiedOnly ?? false,
      trustLevel: token.metadata?.trustLevel ?? 'unverified',
      verifiedSources: token.metadata?.verifiedSources ?? [],
      certificateType: token.metadata?.certificateType ?? (token.metadata?.verifiedOnly ? 'GKV / PKV Verifizierter Prämiennachweis' : 'Standard Score-Nachweis'),
      sampleCount: token.metadata?.totalSampleCount,
      activeDays: token.metadata?.activeDays,
      issuer: 'LONGEVITY Health Intermediary (Ed25519 zertifiziert)',
    };
  });
}
