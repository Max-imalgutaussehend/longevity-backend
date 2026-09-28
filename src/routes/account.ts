import type { FastifyInstance } from 'fastify';
import { eq, desc, and, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { verifyPassword } from '../lib/password.js';
import { db } from '../db/client.js';
import {
  users,
  organizations,
  sources,
  samples,
  sessions,
  scoreSnapshots,
  shareTokens,
  healthDataConsents,
} from '../db/schema.js';
import { CURRENT_HEALTH_DATA_CONSENT_VERSION, HEALTH_DATA_CONSENT_TEXT } from '../lib/consent.js';
import { validateKvnr, hashKvnr } from '../lib/kvnr.js';
import { requireUser, requireRole } from './helpers.js';
import { setCsrfCookies } from '../lib/csrf.js';
import '../types.js';

export async function accountRoutes(app: FastifyInstance) {
  app.get('/me', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    setCsrfCookies(reply);

    const now = new Date();
    const chronoAge = (now.getTime() - new Date(user.birthDate).getTime()) / (1000 * 60 * 60 * 24 * 365.25);

    let organization: { id: string; name: string; verifiedAt: string | null } | null = null;
    if (user.organizationId) {
      const [org] = await db
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, user.organizationId))
        .limit(1);
      if (org) {
        organization = {
          id: org.id,
          name: org.name,
          verifiedAt: user.organizationVerifiedAt?.toISOString() ?? null,
        };
      }
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      birthDate: user.birthDate,
      sex: user.sex,
      chronoAge: Math.round(chronoAge * 10) / 10,
      role: user.role,
      organizationId: user.organizationId,
      organization,
      organizationVerifiedAt: user.organizationVerifiedAt?.toISOString() ?? null,
      emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      healthDataConsentAt: user.healthDataConsentAt?.toISOString() ?? null,
      healthDataConsentVersion: user.healthDataConsentVersion ?? null,
      webhookSecret: user.webhookSecret,
    };
  });

  app.get('/organizations/public-list', async () => {
    const rows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.status, 'active'))
      .orderBy(organizations.name);
    return rows;
  });

  app.post('/organizations/join', async (req, reply) => {
    const user = await requireRole(req, reply, ['b2c']);
    if (!user) return;

    const { joinCode, organizationId, kvnr } = (req.body as {
      joinCode?: string;
      organizationId?: string;
      kvnr?: string;
    }) || {};

    if (!joinCode && (!organizationId || !kvnr)) {
      return reply.status(400).send({
        title: 'Krankenkasse und Krankenversichertennummer (KVNR) oder Beitrittscode erforderlich.',
      });
    }

    // Pfad A: KVNR-basierte Verifikation der Mitgliedschaft
    if (organizationId && kvnr) {
      const kvnrResult = validateKvnr(kvnr);
      if (!kvnrResult.valid || !kvnrResult.normalized) {
        return reply.status(400).send({
          title: kvnrResult.error || 'Ungültige Krankenversichertennummer.',
        });
      }

      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      if (!org || org.status !== 'active') {
        return reply.status(404).send({ title: 'Krankenkasse nicht gefunden oder nicht aktiv.' });
      }

      const hashed = hashKvnr(kvnrResult.normalized);

      // Verhindert Mehrfachanmeldungen mit derselben KVNR
      const existingWithHash = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.kvnrHash, hashed), ne(users.id, user.id)))
        .limit(1);

      if (existingWithHash.length > 0) {
        return reply.status(409).send({
          title: 'Diese Krankenversichertennummer ist bereits mit einem anderen Konto verknüpft.',
        });
      }

      const now = new Date();
      await db
        .update(users)
        .set({
          organizationId: org.id,
          organizationVerifiedAt: now,
          kvnrHash: hashed,
        })
        .where(eq(users.id, user.id));

      return reply.status(200).send({
        ok: true,
        organizationName: org.name,
        verifiedAt: now.toISOString(),
      });
    }

    // Pfad B: Abwärtskompatibler Beitrittscode
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.joinCode, joinCode!))
      .limit(1);

    if (!org || org.status !== 'active') {
      const isKvnr = validateKvnr(joinCode).valid;
      if (isKvnr) {
        return reply.status(400).send({
          title: 'Dies ist eine Krankenversichertennummer (KVNR), kein Beitrittscode. Bitte wähle deine Krankenkasse aus und nutze die KVNR-Verifikation.',
        });
      }
      return reply.status(404).send({ title: 'Ungültiger Beitrittscode.' });
    }

    const now = new Date();
    await db
      .update(users)
      .set({
        organizationId: org.id,
        organizationVerifiedAt: now,
      })
      .where(eq(users.id, user.id));

    return reply.status(200).send({
      ok: true,
      organizationName: org.name,
      verifiedAt: now.toISOString(),
    });
  });

  app.post('/organizations/leave', async (req, reply) => {
    const user = await requireRole(req, reply, ['b2c']);
    if (!user) return;
    await db
      .update(users)
      .set({
        organizationId: null,
        organizationVerifiedAt: null,
        kvnrHash: null,
      })
      .where(eq(users.id, user.id));
    return reply.status(204).send();
  });

  app.get('/account/export', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const [userSources, userSamples, userSnapshots, userShareTokens, userConsents] = await Promise.all([
      db.select().from(sources).where(eq(sources.userId, user.id)),
      db.select().from(samples).where(eq(samples.userId, user.id)),
      db.select().from(scoreSnapshots).where(eq(scoreSnapshots.userId, user.id)),
      db.select().from(shareTokens).where(eq(shareTokens.userId, user.id)),
      db.select().from(healthDataConsents).where(eq(healthDataConsents.userId, user.id)).orderBy(desc(healthDataConsents.grantedAt)),
    ]);

    const exportData = {
      user: {
        email: user.email,
        displayName: user.displayName,
        birthDate: user.birthDate,
        sex: user.sex,
        createdAt: user.createdAt.toISOString(),
      },
      consent: {
        current: {
          consentedAt: user.healthDataConsentAt?.toISOString() ?? null,
          version: user.healthDataConsentVersion ?? null,
        },
        history: userConsents.map((c) => ({
          version: c.version,
          grantedAt: c.grantedAt.toISOString(),
          revokedAt: c.revokedAt?.toISOString() ?? null,
        })),
      },
      sources: userSources.map((s) => ({
        id: s.id,
        kind: s.kind,
        adapter: s.adapter,
        enabled: s.enabled,
        consentAt: s.consentAt?.toISOString() ?? null,
        lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
      })),
      samples: userSamples.map((s) => ({
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: s.measuredAt.toISOString(),
      })),
      scoreSnapshots: userSnapshots.map((s) => ({
        computedFor: s.computedFor,
        score: s.score,
        coverage: s.coverage,
        bioAge: s.bioAge,
        breakdown: s.breakdown,
        engineVersion: s.engineVersion,
      })),
      shareTokens: userShareTokens.map((t) => ({
        bandLow: t.bandLow,
        bandHigh: t.bandHigh,
        issuedAt: t.issuedAt.toISOString(),
        expiresAt: t.expiresAt.toISOString(),
        revokedAt: t.revokedAt?.toISOString() ?? null,
        partnerRef: t.partnerRef,
      })),
    };

    const date = new Date().toISOString().slice(0, 10);
    reply.header('Content-Disposition', `attachment; filename="longevity-export-${date}.json"`);
    return reply.type('application/json').send(exportData);
  });

  app.get('/account/consent', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    return {
      hasConsented: Boolean(user.healthDataConsentAt),
      consentAt: user.healthDataConsentAt?.toISOString() ?? null,
      version: user.healthDataConsentVersion ?? null,
      latestVersion: CURRENT_HEALTH_DATA_CONSENT_VERSION,
      consentText: HEALTH_DATA_CONSENT_TEXT,
    };
  });

  const consentBodySchema = z.object({
    version: z.string().min(1).default(CURRENT_HEALTH_DATA_CONSENT_VERSION),
  });

  app.post('/account/consent', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const parsed = consentBodySchema.safeParse(req.body ?? {});
    const version = parsed.success ? parsed.data.version : CURRENT_HEALTH_DATA_CONSENT_VERSION;
    const now = new Date();

    const ipAddress = req.ip || (req.headers['x-forwarded-for'] as string) || null;
    const userAgent = (req.headers['user-agent'] as string) || null;

    await db.transaction(async (tx) => {
      await tx.update(users).set({
        healthDataConsentAt: now,
        healthDataConsentVersion: version,
      }).where(eq(users.id, user.id));

      await tx.insert(healthDataConsents).values({
        userId: user.id,
        version,
        grantedAt: now,
        ipAddress: ipAddress ? String(ipAddress).slice(0, 255) : null,
        userAgent: userAgent ? String(userAgent).slice(0, 500) : null,
      });
    });

    return {
      ok: true,
      consentAt: now.toISOString(),
      version,
    };
  });

  app.post('/account/consent/revoke', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.update(users).set({
        healthDataConsentAt: null,
        healthDataConsentVersion: null,
      }).where(eq(users.id, user.id));

      await tx.update(healthDataConsents).set({
        revokedAt: now,
      }).where(and(
        eq(healthDataConsents.userId, user.id),
        sql`revoked_at IS NULL`
      ));
    });

    return { ok: true, revokedAt: now.toISOString() };
  });

  /**
   * DELETE /account — DSGVO Art. 17 Recht auf Löschung
   *
   * Cascade via DB FK (onDelete: 'cascade'):
   *   emailTokens, sources, samples, scoreSnapshots, shareTokens,
   *   healthDataConsents, insurerRequests
   *
   * Explicitly handled here:
   *   sessions (no FK cascade — purge all active sessions for this user)
   *
   * Requires password confirmation to prevent accidental / CSRF-triggered deletion.
   */
  app.delete('/account', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const body = req.body as { password?: string };
    if (!body.password) {
      return reply.status(400).send({ title: 'Passwort erforderlich.' });
    }

    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) return reply.status(401).send({ title: 'Falsches Passwort.' });

    // Destroy the current session first so the cookie is cleared
    await req.session.destroy();

    // Purge ALL sessions for this user (covers multi-device logins)
    await db.delete(sessions).where(eq(sessions.userId, user.id));

    // Deleting the user row triggers cascade deletion of all health data
    await db.delete(users).where(eq(users.id, user.id));
    return reply.status(204).send();
  });
}
