import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from '../lib/password.js';
import { db } from '../db/client.js';
import {
  users,
  organizations,
  scoreSnapshots,
  partnerOffers,
  insurerRequests,
  emailTokens,
  benefitClaims,
  shareTokens,
  type ShareTokenMetadata,
} from '../db/schema.js';
import { env } from '../env.js';
import { computeScore, evaluateHoldingPeriod, type SnapshotHistoryItem } from '../score/index.js';
import { issueEmailToken } from '../lib/emailTokens.js';
import { sendMail } from '../lib/mail.js';
import { insurerInviteTemplate, insurerRequestReceivedTemplate } from '../lib/emailTemplates.js';
import { requireRole, requireUser, getUserSamples, getVerifiedUserSamples } from './helpers.js';
import { signTokenPayload, buildTokenPayload, getActivePrivateKey } from '../lib/signing.js';
import '../types.js';

export async function insurerRoutes(app: FastifyInstance) {
  app.get('/insurer/overview', async (req, reply) => {
    const user = await requireRole(req, reply, ['insurer_admin', 'insurer_staff']);
    if (!user) return;
    if (!user.organizationId) return reply.status(404).send({ title: 'Keine Organisation zugeordnet.' });

    const members = await db.select({ id: users.id, birthDate: users.birthDate, sex: users.sex })
      .from(users)
      .where(and(eq(users.organizationId, user.organizationId), eq(users.role, 'b2c')));

    const memberIds = members.map((m) => m.id);
    const activeMemberCount = memberIds.length;

    let averageScore: number | null = null;
    let averageCoverage: number | null = null;
    let membersWithScoreCount = 0;

    if (memberIds.length > 0) {
      const latestPerMember = await db
        .select({
          userId: scoreSnapshots.userId,
          score: scoreSnapshots.score,
          coverage: scoreSnapshots.coverage,
          computedFor: scoreSnapshots.computedFor,
        })
        .from(scoreSnapshots)
        .where(inArray(scoreSnapshots.userId, memberIds))
        .orderBy(desc(scoreSnapshots.computedFor));

      const latestByUser = new Map<string, { score: number; coverage: number }>();
      for (const row of latestPerMember) {
        if (!latestByUser.has(row.userId)) {
          latestByUser.set(row.userId, { score: row.score, coverage: row.coverage });
        }
      }

      const scores = [...latestByUser.values()];
      membersWithScoreCount = scores.length;
      if (scores.length > 0) {
        averageScore = Math.round((scores.reduce((sum, s) => sum + s.score, 0) / scores.length) * 10) / 10;
        averageCoverage = Math.round((scores.reduce((sum, s) => sum + s.coverage, 0) / scores.length) * 100) / 100;
      }
    }

    const [org] = await db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);

    return {
      organizationName: org?.name ?? null,
      joinCode: org?.joinCode ?? null,
      activeMemberCount,
      averageScore,
      averageCoverage,
      membersWithScoreCount,
    };
  });

  const partnerOffersHandler = async (req: FastifyRequest) => {
    const now = new Date();
    const rows = await db.select().from(partnerOffers).orderBy(partnerOffers.sortOrder);
    const userId = req.session.userId;

    let band = { low: 0, high: 100 };
    let snapshots: SnapshotHistoryItem[] = [];
    let userOrganizationId: string | null = null;
    const claimByOfferId = new Map<string, { status: string; submittedAt: Date }>();
    if (userId) {
      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (user) {
        userOrganizationId = user.organizationId;
        const userSamples = await getUserSamples(userId);
        const score = computeScore({
          profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
          samples: userSamples,
          now,
        });
        band = score.band;
        snapshots = await db.select({
          computedFor: scoreSnapshots.computedFor,
          score: scoreSnapshots.score,
        }).from(scoreSnapshots)
          .where(eq(scoreSnapshots.userId, userId))
          .orderBy(desc(scoreSnapshots.computedFor));

        const claims = await db.select({
          offerId: benefitClaims.offerId,
          status: benefitClaims.status,
          submittedAt: benefitClaims.submittedAt,
        }).from(benefitClaims)
          .where(eq(benefitClaims.userId, userId))
          .orderBy(desc(benefitClaims.submittedAt));
        // Most recent claim per offer wins (a rejected claim can be resubmitted).
        for (const c of claims) {
          if (!claimByOfferId.has(c.offerId)) claimByOfferId.set(c.offerId, c);
        }
      }
    }

    return rows
      .filter(o => (!o.validFrom || o.validFrom <= now) && (!o.validUntil || o.validUntil >= now))
      // A members-only offer is exclusive to its issuing organization's own
      // verified members (issue #84) — everyone else must not even see it,
      // regardless of whether their score would otherwise qualify.
      .filter(o => !o.organizationId || !o.membersOnly || o.organizationId === userOrganizationId)
      .map(o => {
        const holding = evaluateHoldingPeriod({
          currentBand: band,
          minBand: o.minBand,
          minMonths: o.minMonths,
          snapshots,
          now,
        });
        const claim = claimByOfferId.get(o.id);
        return {
          id: o.id,
          organizationId: o.organizationId,
          partnerName: o.partnerName,
          title: o.title,
          description: o.description,
          minBand: o.minBand,
          minMonths: o.minMonths ?? null,
          valueLabel: o.valueLabel,
          isDemo: o.isDemo,
          membersOnly: o.membersOnly,
          qualified: holding.qualified,
          daysHeld: holding.daysHeld,
          daysRemaining: holding.daysRemaining,
          claimStatus: claim?.status ?? null,
          claimSubmittedAt: claim?.submittedAt.toISOString() ?? null,
        };
      });
  };

  app.get('/partner-offers', partnerOffersHandler);
  app.get('/offers', partnerOffersHandler);

  app.get('/insurer/offers', async (req, reply) => {
    const user = await requireRole(req, reply, ['insurer_admin', 'insurer_staff']);
    if (!user) return;
    if (!user.organizationId) return reply.status(404).send({ title: 'Keine Organisation zugeordnet.' });

    const rows = await db.select().from(partnerOffers)
      .where(eq(partnerOffers.organizationId, user.organizationId))
      .orderBy(partnerOffers.sortOrder);

    return rows.map(o => ({
      id: o.id,
      title: o.title,
      description: o.description,
      minBand: o.minBand,
      minMonths: o.minMonths ?? null,
      valueLabel: o.valueLabel,
      validFrom: o.validFrom?.toISOString() ?? null,
      validUntil: o.validUntil?.toISOString() ?? null,
      membersOnly: o.membersOnly,
    }));
  });

  app.post('/insurer/offers', async (req, reply) => {
    const user = await requireRole(req, reply, ['insurer_admin', 'insurer_staff']);
    if (!user) return;
    if (!user.organizationId) return reply.status(404).send({ title: 'Keine Organisation zugeordnet.' });

    const body = req.body as {
      title?: string;
      description?: string;
      minBand?: number;
      minMonths?: number;
      valueLabel?: string;
      validFrom?: string;
      validUntil?: string;
      membersOnly?: boolean;
    };
    const { title, description, minBand, minMonths, valueLabel, validFrom, validUntil, membersOnly } = body;

    if (!title || !description || minBand === undefined || !valueLabel) {
      return reply.status(400).send({ title: 'Pflichtfelder fehlen.' });
    }
    if (minBand < 0 || minBand > 100) {
      return reply.status(400).send({ title: 'Mindest-Score-Band muss zwischen 0 und 100 liegen.' });
    }
    if (minMonths !== undefined && (minMonths < 0 || minMonths > 36)) {
      return reply.status(400).send({ title: 'Mindesthaltedauer muss zwischen 0 und 36 Monaten liegen.' });
    }

    const [org] = await db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);

    const [offer] = await db.insert(partnerOffers).values({
      organizationId: user.organizationId,
      partnerName: org?.name ?? 'Krankenkasse',
      title,
      description,
      minBand,
      minMonths: minMonths ?? 0,
      valueLabel,
      validFrom: validFrom ? new Date(validFrom) : null,
      validUntil: validUntil ? new Date(validUntil) : null,
      isDemo: false,
      membersOnly: membersOnly ?? true,
    }).returning();

    return reply.status(201).send({
      id: offer.id,
      title: offer.title,
      description: offer.description,
      minBand: offer.minBand,
      minMonths: offer.minMonths ?? null,
      valueLabel: offer.valueLabel,
      validFrom: offer.validFrom?.toISOString() ?? null,
      validUntil: offer.validUntil?.toISOString() ?? null,
      membersOnly: offer.membersOnly,
    });
  });

  app.patch('/insurer/offers/:id', async (req, reply) => {
    const user = await requireRole(req, reply, ['insurer_admin', 'insurer_staff']);
    if (!user) return;
    if (!user.organizationId) return reply.status(404).send({ title: 'Keine Organisation zugeordnet.' });

    const { id } = req.params as { id: string };
    const body = req.body as {
      title?: string;
      description?: string;
      minBand?: number;
      minMonths?: number | null;
      valueLabel?: string;
      validFrom?: string | null;
      validUntil?: string | null;
      membersOnly?: boolean;
    };

    if (body.minBand !== undefined && (body.minBand < 0 || body.minBand > 100)) {
      return reply.status(400).send({ title: 'Mindest-Score-Band muss zwischen 0 und 100 liegen.' });
    }
    if (body.minMonths !== undefined && body.minMonths !== null && (body.minMonths < 0 || body.minMonths > 36)) {
      return reply.status(400).send({ title: 'Mindesthaltedauer muss zwischen 0 und 36 Monaten liegen.' });
    }

    const [existing] = await db.select().from(partnerOffers)
      .where(and(eq(partnerOffers.id, id), eq(partnerOffers.organizationId, user.organizationId)))
      .limit(1);
    if (!existing) return reply.status(404).send({ title: 'Angebot nicht gefunden.' });

    const [updated] = await db.update(partnerOffers).set({
      ...(body.title !== undefined && { title: body.title }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.minBand !== undefined && { minBand: body.minBand }),
      ...(body.minMonths !== undefined && { minMonths: body.minMonths }),
      ...(body.valueLabel !== undefined && { valueLabel: body.valueLabel }),
      ...(body.validFrom !== undefined && { validFrom: body.validFrom ? new Date(body.validFrom) : null }),
      ...(body.validUntil !== undefined && { validUntil: body.validUntil ? new Date(body.validUntil) : null }),
      ...(body.membersOnly !== undefined && { membersOnly: body.membersOnly }),
    }).where(eq(partnerOffers.id, id)).returning();

    return {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      minBand: updated.minBand,
      minMonths: updated.minMonths ?? null,
      valueLabel: updated.valueLabel,
      validFrom: updated.validFrom?.toISOString() ?? null,
      validUntil: updated.validUntil?.toISOString() ?? null,
      membersOnly: updated.membersOnly,
    };
  });

  app.delete('/insurer/offers/:id', async (req, reply) => {
    const user = await requireRole(req, reply, ['insurer_admin', 'insurer_staff']);
    if (!user) return;
    if (!user.organizationId) return reply.status(404).send({ title: 'Keine Organisation zugeordnet.' });

    const { id } = req.params as { id: string };
    await db.delete(partnerOffers)
      .where(and(eq(partnerOffers.id, id), eq(partnerOffers.organizationId, user.organizationId)));
    return reply.status(204).send();
  });

  app.post('/offers/:id/claim', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const { id: offerId } = req.params as { id: string };
    const [offer] = await db.select().from(partnerOffers).where(eq(partnerOffers.id, offerId)).limit(1);
    if (!offer) return reply.status(404).send({ title: 'Angebot nicht gefunden.' });
    if (!offer.organizationId) {
      return reply.status(400).send({ title: 'Dieses Angebot unterstützt keine direkte Einreichung.' });
    }
    if (offer.membersOnly && offer.organizationId !== user.organizationId) {
      return reply.status(403).send({ title: 'Dieses Angebot ist nur für Mitglieder der ausstellenden Krankenkasse verfügbar.' });
    }

    const now = new Date();
    const userSamples = await getUserSamples(user.id);
    const score = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples: userSamples,
      now,
    });
    const snapshots = await db.select({
      computedFor: scoreSnapshots.computedFor,
      score: scoreSnapshots.score,
    }).from(scoreSnapshots)
      .where(eq(scoreSnapshots.userId, user.id))
      .orderBy(desc(scoreSnapshots.computedFor));

    const holding = evaluateHoldingPeriod({
      currentBand: score.band,
      minBand: offer.minBand,
      minMonths: offer.minMonths,
      snapshots,
      now,
    });
    if (!holding.qualified) {
      return reply.status(400).send({ title: 'Anspruchsvoraussetzungen für dieses Angebot sind nicht erfüllt.' });
    }

    const [existingActive] = await db.select().from(benefitClaims)
      .where(and(
        eq(benefitClaims.userId, user.id),
        eq(benefitClaims.offerId, offerId),
        inArray(benefitClaims.status, ['submitted', 'accepted']),
      ))
      .limit(1);
    if (existingActive) {
      return reply.status(409).send({ title: 'Für dieses Angebot liegt bereits eine Einreichung vor.' });
    }

    const sampleData = await getVerifiedUserSamples(user.id);
    const privateKey = getActivePrivateKey();
    if (!privateKey) return reply.status(500).send({ title: 'Signierschlüssel nicht konfiguriert.' });

    const tokenId = randomUUID();
    const issuedAt = now;
    const expiresAt = new Date(issuedAt.getTime() + 90 * 24 * 60 * 60 * 1000);
    const payload = buildTokenPayload(tokenId, score.band.low, score.band.high, expiresAt.toISOString());
    const signature = signTokenPayload(payload, privateKey);
    const metadata: ShareTokenMetadata = {
      verifiedOnly: false,
      trustLevel: sampleData.trustLevel,
      verifiedSources: sampleData.verifiedSources,
      totalSampleCount: sampleData.totalSampleCount,
      excludedSampleCount: sampleData.excludedSampleCount,
      activeDays: sampleData.activeDays,
      certificateType: 'Standard Score-Nachweis',
    };

    await db.insert(shareTokens).values({
      id: tokenId,
      userId: user.id,
      bandLow: score.band.low,
      bandHigh: score.band.high,
      issuedAt,
      expiresAt,
      signature,
      metadata,
    });

    const [claim] = await db.insert(benefitClaims).values({
      userId: user.id,
      offerId,
      organizationId: offer.organizationId,
      shareTokenId: tokenId,
      bandLow: score.band.low,
      bandHigh: score.band.high,
    }).returning();

    return reply.status(201).send({
      id: claim.id,
      status: claim.status,
      submittedAt: claim.submittedAt.toISOString(),
    });
  });

  app.get('/insurer/claims', async (req, reply) => {
    const user = await requireRole(req, reply, ['insurer_admin', 'insurer_staff']);
    if (!user) return;
    if (!user.organizationId) return reply.status(404).send({ title: 'Keine Organisation zugeordnet.' });

    const rows = await db.select({
      id: benefitClaims.id,
      status: benefitClaims.status,
      bandLow: benefitClaims.bandLow,
      bandHigh: benefitClaims.bandHigh,
      submittedAt: benefitClaims.submittedAt,
      decidedAt: benefitClaims.decidedAt,
      shareTokenId: benefitClaims.shareTokenId,
      offerTitle: partnerOffers.title,
      userEmail: users.email,
      userDisplayName: users.displayName,
    }).from(benefitClaims)
      .innerJoin(partnerOffers, eq(benefitClaims.offerId, partnerOffers.id))
      .innerJoin(users, eq(benefitClaims.userId, users.id))
      .where(eq(benefitClaims.organizationId, user.organizationId))
      .orderBy(desc(benefitClaims.submittedAt));

    return rows.map(r => ({
      id: r.id,
      status: r.status,
      bandLow: r.bandLow,
      bandHigh: r.bandHigh,
      submittedAt: r.submittedAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      offerTitle: r.offerTitle,
      userEmail: r.userEmail,
      userDisplayName: r.userDisplayName,
      verifyUrl: `/verify/${r.shareTokenId}`,
    }));
  });

  app.post('/insurer/claims/:id/decide', async (req, reply) => {
    const user = await requireRole(req, reply, ['insurer_admin', 'insurer_staff']);
    if (!user) return;
    if (!user.organizationId) return reply.status(404).send({ title: 'Keine Organisation zugeordnet.' });

    const { id } = req.params as { id: string };
    const body = req.body as { decision?: 'accepted' | 'rejected' };
    if (body.decision !== 'accepted' && body.decision !== 'rejected') {
      return reply.status(400).send({ title: 'Ungültige Entscheidung.' });
    }

    const [existing] = await db.select().from(benefitClaims)
      .where(and(eq(benefitClaims.id, id), eq(benefitClaims.organizationId, user.organizationId)))
      .limit(1);
    if (!existing) return reply.status(404).send({ title: 'Einreichung nicht gefunden.' });
    if (existing.status !== 'submitted') {
      return reply.status(409).send({ title: 'Über diese Einreichung wurde bereits entschieden.' });
    }

    const [updated] = await db.update(benefitClaims).set({
      status: body.decision,
      decidedAt: new Date(),
      decidedBy: user.id,
    }).where(eq(benefitClaims.id, id)).returning();

    return {
      id: updated.id,
      status: updated.status,
      decidedAt: updated.decidedAt?.toISOString() ?? null,
    };
  });

  app.post('/contact/insurer', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        errorResponseBuilder: () => ({ statusCode: 429, title: 'Zu viele Anfragen. Bitte in 15 Minuten erneut versuchen.' }),
      },
    },
  }, async (req, reply) => {
    const body = req.body as { company?: string; name?: string; email?: string; message?: string };
    const { company, name, email, message } = body;

    if (!company || !name || !email) {
      return reply.status(400).send({ title: 'Pflichtfelder fehlen.' });
    }

    const [request] = await db.insert(insurerRequests).values({
      company,
      contactName: name,
      contactEmail: email,
      message: message ?? null,
    }).returning();

    try {
      await sendMail({ to: email, ...insurerRequestReceivedTemplate(company) });
    } catch (err) {
      req.log.error(err, 'Bestätigungs-E-Mail für Krankenkassen-Anfrage konnte nicht gesendet werden');
    }

    return reply.status(201).send({ id: request.id });
  });

  app.get('/admin/insurer-requests', async (req, reply) => {
    const user = await requireRole(req, reply, ['platform_admin']);
    if (!user) return;

    const rows = await db.select().from(insurerRequests).orderBy(desc(insurerRequests.createdAt));
    return rows.map(r => ({
      id: r.id,
      company: r.company,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      message: r.message,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
  });

  app.post('/admin/insurer-requests/:id/approve', async (req, reply) => {
    const admin = await requireRole(req, reply, ['platform_admin']);
    if (!admin) return;

    const { id } = req.params as { id: string };
    const [request] = await db.select().from(insurerRequests).where(eq(insurerRequests.id, id)).limit(1);
    if (!request) return reply.status(404).send({ title: 'Anfrage nicht gefunden.' });
    if (request.status !== 'pending') return reply.status(400).send({ title: 'Anfrage wurde bereits bearbeitet.' });

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, request.contactEmail)).limit(1);
    if (existing.length > 0) {
      return reply.status(409).send({ title: 'E-Mail bereits als Nutzer registriert.' });
    }

    const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

    const { org, token } = await db.transaction(async (tx) => {
      const [org] = await tx.insert(organizations).values({
        name: request.company,
        contactEmail: request.contactEmail,
        status: 'pending',
        joinCode: randomBytes(6).toString('hex'),
      }).returning();

      const unusablePasswordHash = await hashPassword(randomBytes(32).toString('base64url'));
      const [insurerUser] = await tx.insert(users).values({
        email: request.contactEmail,
        passwordHash: unusablePasswordHash,
        birthDate: '1970-01-01',
        sex: 'm',
        role: 'insurer_admin',
        organizationId: org.id,
      }).returning();

      const token = randomBytes(32).toString('base64url');
      await tx.insert(emailTokens).values({
        id: token,
        userId: insurerUser.id,
        purpose: 'insurer_invite',
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      });

      await tx.update(insurerRequests).set({
        status: 'approved',
        organizationId: org.id,
        decidedAt: new Date(),
        decidedBy: admin.id,
      }).where(eq(insurerRequests.id, id));

      return { org, token };
    });

    const baseUrl = env.PUBLIC_BASE_URL ?? 'http://localhost:5173';
    const inviteUrl = `${baseUrl}/insurer-invite/${token}`;
    try {
      await sendMail({ to: request.contactEmail, ...insurerInviteTemplate(request.company, inviteUrl) });
    } catch (err) {
      req.log.error(err, 'Einladungs-E-Mail für Krankenkasse konnte nicht gesendet werden');
    }

    return reply.status(200).send({ ok: true, organizationId: org.id });
  });

  app.post('/admin/insurer-requests/:id/reject', async (req, reply) => {
    const admin = await requireRole(req, reply, ['platform_admin']);
    if (!admin) return;

    const { id } = req.params as { id: string };
    const [request] = await db.select().from(insurerRequests).where(eq(insurerRequests.id, id)).limit(1);
    if (!request) return reply.status(404).send({ title: 'Anfrage nicht gefunden.' });
    if (request.status !== 'pending') return reply.status(400).send({ title: 'Anfrage wurde bereits bearbeitet.' });

    await db.update(insurerRequests).set({
      status: 'rejected',
      decidedAt: new Date(),
      decidedBy: admin.id,
    }).where(eq(insurerRequests.id, id));

    return reply.status(200).send({ ok: true });
  });

  app.post('/admin/insurer-requests/:id/resend-invite', async (req, reply) => {
    const admin = await requireRole(req, reply, ['platform_admin']);
    if (!admin) return;

    const { id } = req.params as { id: string };
    const [request] = await db.select().from(insurerRequests).where(eq(insurerRequests.id, id)).limit(1);
    if (!request) return reply.status(404).send({ title: 'Anfrage nicht gefunden.' });
    if (request.status !== 'approved') return reply.status(400).send({ title: 'Nur angenommene Anfragen können erneut eingeladen werden.' });

    const [insurerUser] = await db.select().from(users).where(eq(users.email, request.contactEmail)).limit(1);
    if (!insurerUser) return reply.status(404).send({ title: 'Zugehöriger Nutzer nicht gefunden.' });

    const token = await issueEmailToken(insurerUser.id, 'insurer_invite', 7 * 24 * 60 * 60 * 1000);
    const baseUrl = env.PUBLIC_BASE_URL ?? 'http://localhost:5173';
    const inviteUrl = `${baseUrl}/insurer-invite/${token}`;
    try {
      await sendMail({ to: request.contactEmail, ...insurerInviteTemplate(request.company, inviteUrl) });
    } catch (err) {
      req.log.error(err, 'Einladungs-E-Mail (Resend) für Krankenkasse konnte nicht gesendet werden');
      return reply.status(502).send({ title: 'E-Mail konnte nicht gesendet werden. Bitte SMTP-Konfiguration prüfen.' });
    }

    return reply.status(200).send({ ok: true });
  });

  app.delete('/admin/insurer-requests/:id', async (req, reply) => {
    const admin = await requireRole(req, reply, ['platform_admin']);
    if (!admin) return;

    const { id } = req.params as { id: string };
    const [request] = await db.select({ id: insurerRequests.id, status: insurerRequests.status }).from(insurerRequests).where(eq(insurerRequests.id, id)).limit(1);
    if (!request) return reply.status(404).send({ title: 'Anfrage nicht gefunden.' });
    if (request.status === 'pending') return reply.status(400).send({ title: 'Offene Anfragen können nicht gelöscht werden.' });

    await db.delete(insurerRequests).where(eq(insurerRequests.id, id));

    return reply.status(204).send();
  });
}
