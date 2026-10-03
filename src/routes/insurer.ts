import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, desc, and, inArray, isNull, sql } from 'drizzle-orm';
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
  partnerOfferVoucherCodes,
  shareTokens,
  type ShareTokenMetadata,
  type BenefitType,
  type BenefitClaimStatus,
  type PayoutMethod,
  type RewardPayload,
} from '../db/schema.js';
import { computeScore, evaluateHoldingPeriod, type SnapshotHistoryItem } from '../score/index.js';
import { issueEmailToken } from '../lib/emailTokens.js';
import { sendMail } from '../lib/mail.js';
import { insurerInviteTemplate, insurerRequestReceivedTemplate } from '../lib/emailTemplates.js';
import { requireRole, requireUser, getUserSamples, getVerifiedUserSamples } from './helpers.js';
import { signTokenPayload, buildTokenPayload, getActivePrivateKey } from '../lib/signing.js';
import { buildFrontendUrl } from '../lib/urls.js';
import { isValidIban, maskIban } from '../lib/iban.js';
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

    const poolCounts = await db.select({
      offerId: partnerOfferVoucherCodes.offerId,
      count: sql<number>`count(*)::int`,
    }).from(partnerOfferVoucherCodes)
      .where(isNull(partnerOfferVoucherCodes.claimedByUserId))
      .groupBy(partnerOfferVoucherCodes.offerId);
    const poolMap = new Map<string, number>(poolCounts.map(p => [p.offerId, p.count]));

    let band = { low: 0, high: 100 };
    let snapshots: SnapshotHistoryItem[] = [];
    let userOrganizationId: string | null = null;
    const claimByOfferId = new Map<string, {
      id: string;
      status: string;
      submittedAt: Date;
      payoutMethod: string | null;
      payoutIbanMasked: string | null;
      contactEmail: string | null;
      kvnr: string | null;
      rewardPayload: RewardPayload | null;
      rejectionReason: string | null;
    }>();
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
          id: benefitClaims.id,
          offerId: benefitClaims.offerId,
          status: benefitClaims.status,
          submittedAt: benefitClaims.submittedAt,
          payoutMethod: benefitClaims.payoutMethod,
          payoutIbanMasked: benefitClaims.payoutIbanMasked,
          contactEmail: benefitClaims.contactEmail,
          kvnr: benefitClaims.kvnr,
          rewardPayload: benefitClaims.rewardPayload,
          rejectionReason: benefitClaims.rejectionReason,
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
          benefitType: o.benefitType,
          voucherDelivery: o.voucherDelivery,
          availableCodesCount: o.voucherDelivery === 'code_pool' ? (poolMap.get(o.id) ?? 0) : undefined,
          voucherCode: o.voucherCode,
          partnerUrl: o.partnerUrl,
          validFrom: o.validFrom?.toISOString() ?? null,
          validUntil: o.validUntil?.toISOString() ?? null,
          qualified: holding.qualified,
          daysHeld: holding.daysHeld,
          daysRemaining: holding.daysRemaining,
          claimId: claim?.id ?? null,
          claimStatus: claim?.status ?? null,
          claimSubmittedAt: claim?.submittedAt ? claim.submittedAt.toISOString() : null,
          payoutMethod: claim?.payoutMethod ?? null,
          payoutIbanMasked: claim?.payoutIbanMasked ?? null,
          contactEmail: claim?.contactEmail ?? null,
          kvnr: claim?.kvnr ?? null,
          rewardPayload: claim?.rewardPayload ?? null,
          rejectionReason: claim?.rejectionReason ?? null,
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

    const poolCounts = await db.select({
      offerId: partnerOfferVoucherCodes.offerId,
      count: sql<number>`count(*)::int`,
    }).from(partnerOfferVoucherCodes)
      .where(isNull(partnerOfferVoucherCodes.claimedByUserId))
      .groupBy(partnerOfferVoucherCodes.offerId);
    const poolMap = new Map<string, number>(poolCounts.map(p => [p.offerId, p.count]));

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
      benefitType: o.benefitType,
      voucherDelivery: o.voucherDelivery,
      availableCodesCount: o.voucherDelivery === 'code_pool' ? (poolMap.get(o.id) ?? 0) : undefined,
      voucherCode: o.voucherCode,
      partnerUrl: o.partnerUrl,
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
      benefitType?: BenefitType;
      voucherDelivery?: 'code_pool' | 'email';
      voucherCode?: string;
      partnerUrl?: string;
      voucherCodesText?: string;
      voucherCodes?: string[];
    };
    const { title, description, minBand, minMonths, valueLabel, validFrom, validUntil, membersOnly, benefitType, voucherDelivery, voucherCode, partnerUrl } = body;

    if (!title || !description || minBand === undefined || !valueLabel) {
      return reply.status(400).send({ title: 'Pflichtfelder fehlen.' });
    }
    if (minBand < 0 || minBand > 100) {
      return reply.status(400).send({ title: 'Mindest-Score-Band muss zwischen 0 und 100 liegen.' });
    }
    if (minMonths !== undefined && (minMonths < 0 || minMonths > 36)) {
      return reply.status(400).send({ title: 'Mindesthaltedauer muss zwischen 0 und 36 Monaten liegen.' });
    }
    if (benefitType && !['payout', 'voucher', 'certificate'].includes(benefitType)) {
      return reply.status(400).send({ title: 'Ungültige Art des Vorteils.' });
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
      benefitType: benefitType ?? 'payout',
      voucherDelivery: voucherDelivery ?? (voucherCode ? 'code_pool' : 'email'),
      voucherCode: voucherCode?.trim() || null,
      partnerUrl: partnerUrl?.trim() || null,
    }).returning();

    // Mass-import initial codes if provided
    let importedCount = 0;
    const initialCodes = [
      ...(Array.isArray(body.voucherCodes) ? body.voucherCodes : []),
      ...(typeof body.voucherCodesText === 'string' ? body.voucherCodesText.split(/[\n,;]+/) : []),
    ].map(c => c.trim()).filter(Boolean);

    if (initialCodes.length > 0) {
      await db.insert(partnerOfferVoucherCodes).values(
        initialCodes.map(code => ({ offerId: offer.id, code }))
      );
      importedCount = initialCodes.length;
    }

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
      benefitType: offer.benefitType,
      voucherDelivery: offer.voucherDelivery,
      availableCodesCount: importedCount,
      voucherCode: offer.voucherCode,
      partnerUrl: offer.partnerUrl,
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
      benefitType?: BenefitType;
      voucherDelivery?: 'code_pool' | 'email';
      voucherCode?: string | null;
      partnerUrl?: string | null;
      voucherCodesText?: string;
      voucherCodes?: string[];
    };

    if (body.minBand !== undefined && (body.minBand < 0 || body.minBand > 100)) {
      return reply.status(400).send({ title: 'Mindest-Score-Band muss zwischen 0 und 100 liegen.' });
    }
    if (body.minMonths !== undefined && body.minMonths !== null && (body.minMonths < 0 || body.minMonths > 36)) {
      return reply.status(400).send({ title: 'Mindesthaltedauer muss zwischen 0 und 36 Monaten liegen.' });
    }
    if (body.benefitType && !['payout', 'voucher', 'certificate'].includes(body.benefitType)) {
      return reply.status(400).send({ title: 'Ungültige Art des Vorteils.' });
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
      ...(body.benefitType !== undefined && { benefitType: body.benefitType }),
      ...(body.voucherDelivery !== undefined && { voucherDelivery: body.voucherDelivery }),
      ...(body.voucherCode !== undefined && { voucherCode: body.voucherCode ? body.voucherCode.trim() : null }),
      ...(body.partnerUrl !== undefined && { partnerUrl: body.partnerUrl ? body.partnerUrl.trim() : null }),
    }).where(eq(partnerOffers.id, id)).returning();

    // Mass-import additional codes if provided
    const newCodes = [
      ...(Array.isArray(body.voucherCodes) ? body.voucherCodes : []),
      ...(typeof body.voucherCodesText === 'string' ? body.voucherCodesText.split(/[\n,;]+/) : []),
    ].map(c => c.trim()).filter(Boolean);

    if (newCodes.length > 0) {
      await db.insert(partnerOfferVoucherCodes).values(
        newCodes.map(code => ({ offerId: updated.id, code }))
      );
    }

    const [availableRow] = await db.select({ count: sql<number>`count(*)::int` })
      .from(partnerOfferVoucherCodes)
      .where(and(eq(partnerOfferVoucherCodes.offerId, updated.id), isNull(partnerOfferVoucherCodes.claimedByUserId)));

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
      benefitType: updated.benefitType,
      voucherDelivery: updated.voucherDelivery,
      availableCodesCount: availableRow?.count ?? 0,
      voucherCode: updated.voucherCode,
      partnerUrl: updated.partnerUrl,
    };
  });

  app.post('/insurer/offers/:id/voucher-codes', async (req, reply) => {
    const user = await requireRole(req, reply, ['insurer_admin', 'insurer_staff']);
    if (!user) return;
    if (!user.organizationId) return reply.status(404).send({ title: 'Keine Organisation zugeordnet.' });

    const { id } = req.params as { id: string };
    const [offer] = await db.select().from(partnerOffers)
      .where(and(eq(partnerOffers.id, id), eq(partnerOffers.organizationId, user.organizationId)))
      .limit(1);
    if (!offer) return reply.status(404).send({ title: 'Angebot nicht gefunden.' });

    const body = req.body as { codes?: string[]; rawText?: string };
    const codesToInsert = [
      ...(Array.isArray(body?.codes) ? body.codes : []),
      ...(typeof body?.rawText === 'string' ? body.rawText.split(/[\n,;]+/) : []),
    ].map(c => c.trim()).filter(Boolean);

    if (codesToInsert.length === 0) {
      return reply.status(400).send({ title: 'Keine gültigen Gutscheincodes angegeben.' });
    }

    await db.insert(partnerOfferVoucherCodes).values(
      codesToInsert.map(code => ({ offerId: offer.id, code }))
    );

    const [availableRow] = await db.select({ count: sql<number>`count(*)::int` })
      .from(partnerOfferVoucherCodes)
      .where(and(eq(partnerOfferVoucherCodes.offerId, offer.id), isNull(partnerOfferVoucherCodes.claimedByUserId)));

    return reply.status(201).send({
      inserted: codesToInsert.length,
      availableCodesCount: availableRow?.count ?? 0,
    });
  });

  app.get('/insurer/offers/:id/voucher-codes', async (req, reply) => {
    const user = await requireRole(req, reply, ['insurer_admin', 'insurer_staff']);
    if (!user) return;
    if (!user.organizationId) return reply.status(404).send({ title: 'Keine Organisation zugeordnet.' });

    const { id } = req.params as { id: string };
    const [offer] = await db.select().from(partnerOffers)
      .where(and(eq(partnerOffers.id, id), eq(partnerOffers.organizationId, user.organizationId)))
      .limit(1);
    if (!offer) return reply.status(404).send({ title: 'Angebot nicht gefunden.' });

    const rows = await db.select().from(partnerOfferVoucherCodes).where(eq(partnerOfferVoucherCodes.offerId, offer.id));
    const available = rows.filter(r => !r.claimedByUserId).length;
    const claimed = rows.filter(r => !!r.claimedByUserId).length;

    return {
      total: rows.length,
      available,
      claimed,
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
    if (!offer.organizationId && offer.benefitType !== 'voucher' && offer.benefitType !== 'certificate') {
      return reply.status(400).send({ title: 'Dieses Angebot unterstützt keine direkte Einreichung.' });
    }
    // If the offer is members-only, user must belong to that organization
    if (offer.membersOnly && offer.organizationId && offer.organizationId !== user.organizationId) {
      return reply.status(403).send({ title: 'Dieses Angebot ist nur für Mitglieder der ausstellenden Krankenkasse verfügbar.' });
    }

    const body = (req.body as {
      payoutMethod?: PayoutMethod;
      iban?: string;
      accountHolder?: string;
      kvnr?: string;
      contactEmail?: string;
    }) || {};

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
        inArray(benefitClaims.status, ['submitted', 'processing', 'accepted']),
      ))
      .limit(1);
    if (existingActive) {
      return reply.status(409).send({ title: 'Für dieses Angebot liegt bereits eine Einreichung vor.' });
    }

    let chosenMethod: PayoutMethod = body.payoutMethod || (offer.benefitType === 'voucher' ? 'voucher' : offer.benefitType === 'certificate' ? 'self_submitted' : 'bank_transfer');
    let maskedIban: string | null = null;
    let accountHolder: string | null = null;
    let contactEmail: string | null = null;
    const kvnr: string | null = body.kvnr?.trim() || null;
    let rewardPayload: RewardPayload | null = null;
    let claimStatus: BenefitClaimStatus = 'submitted';
    let decidedAt: Date | null = null;

    if (offer.benefitType === 'voucher' || chosenMethod === 'voucher') {
      chosenMethod = 'voucher';
      if (offer.voucherDelivery === 'code_pool') {
        const [availCode] = await db.select().from(partnerOfferVoucherCodes)
          .where(and(
            eq(partnerOfferVoucherCodes.offerId, offer.id),
            isNull(partnerOfferVoucherCodes.claimedByUserId)
          ))
          .limit(1);

        if (availCode) {
          await db.update(partnerOfferVoucherCodes)
            .set({ claimedByUserId: user.id, claimedAt: now })
            .where(eq(partnerOfferVoucherCodes.id, availCode.id));
          claimStatus = 'accepted';
          decidedAt = now;
          rewardPayload = {
            voucherCode: availCode.code,
            voucherDelivery: 'code_pool',
            ...(offer.partnerUrl ? { partnerUrl: offer.partnerUrl } : {}),
          };
        } else if (offer.voucherCode) {
          claimStatus = 'accepted';
          decidedAt = now;
          rewardPayload = {
            voucherCode: offer.voucherCode,
            voucherDelivery: 'code_pool',
            ...(offer.partnerUrl ? { partnerUrl: offer.partnerUrl } : {}),
          };
        } else {
          return reply.status(400).send({ title: 'Der Gutschein-Pool ist aktuell erschöpft. Bitte wende dich an die Krankenkasse.' });
        }
      } else {
        contactEmail = body.contactEmail?.trim() || user.email;
        claimStatus = 'submitted';
        rewardPayload = {
          voucherDelivery: 'email',
          contactEmail,
          ...(offer.partnerUrl ? { partnerUrl: offer.partnerUrl } : {}),
        };
      }
    } else if (offer.benefitType === 'certificate' || chosenMethod === 'self_submitted') {
      chosenMethod = 'self_submitted';
      claimStatus = 'submitted';
      rewardPayload = {
        note: '§ 65a SGB V Nachweis eingereicht',
      };
    } else {
      claimStatus = 'submitted';
      if (chosenMethod === 'contribution_offset') {
        if (!offer.organizationId || user.organizationId !== offer.organizationId) {
          return reply.status(400).send({ title: 'Beitragsverrechnung ist nur für verifizierte Mitglieder dieser Krankenkasse verfügbar.' });
        }
      } else {
        if (body.iban) {
          if (!isValidIban(body.iban)) {
            return reply.status(400).send({ title: 'Bitte eine gültige IBAN angeben.' });
          }
          chosenMethod = 'bank_transfer';
          maskedIban = maskIban(body.iban);
          accountHolder = body.accountHolder?.trim() || user.displayName || user.email;
        } else {
          if (offer.organizationId && user.organizationId === offer.organizationId) {
            chosenMethod = 'contribution_offset';
          } else {
            chosenMethod = 'bank_transfer';
          }
        }
      }
      rewardPayload = {
        ...(kvnr ? { note: `KVNR: ${kvnr}` } : {}),
      };
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
      certificateType: chosenMethod === 'self_submitted' ? '§ 65a SGB V Kassen-Nachweis' : 'Standard Score-Nachweis',
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
      organizationId: offer.organizationId ?? null,
      shareTokenId: tokenId,
      bandLow: score.band.low,
      bandHigh: score.band.high,
      status: claimStatus,
      payoutMethod: chosenMethod,
      payoutIbanMasked: maskedIban,
      payoutAccountHolder: accountHolder,
      contactEmail,
      kvnr,
      rewardPayload,
      decidedAt,
      selfSubmittedAt: chosenMethod === 'self_submitted' ? now : null,
      reminderAt: chosenMethod === 'self_submitted' ? new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000) : null,
    }).returning();

    return reply.status(201).send({
      id: claim.id,
      status: claim.status,
      submittedAt: claim.submittedAt.toISOString(),
      payoutMethod: claim.payoutMethod,
      payoutIbanMasked: claim.payoutIbanMasked,
      contactEmail: claim.contactEmail,
      kvnr: claim.kvnr,
      rewardPayload: claim.rewardPayload,
      shareTokenId: tokenId,
      verifyUrl: `/verify/${tokenId}`,
    });
  });

  app.get('/me/claims', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const rows = await db.select({
      id: benefitClaims.id,
      offerId: benefitClaims.offerId,
      status: benefitClaims.status,
      bandLow: benefitClaims.bandLow,
      bandHigh: benefitClaims.bandHigh,
      payoutMethod: benefitClaims.payoutMethod,
      payoutIbanMasked: benefitClaims.payoutIbanMasked,
      payoutAccountHolder: benefitClaims.payoutAccountHolder,
      contactEmail: benefitClaims.contactEmail,
      kvnr: benefitClaims.kvnr,
      rewardPayload: benefitClaims.rewardPayload,
      rejectionReason: benefitClaims.rejectionReason,
      selfSubmittedAt: benefitClaims.selfSubmittedAt,
      reminderAt: benefitClaims.reminderAt,
      submittedAt: benefitClaims.submittedAt,
      decidedAt: benefitClaims.decidedAt,
      shareTokenId: benefitClaims.shareTokenId,
      offerTitle: partnerOffers.title,
      offerPartnerName: partnerOffers.partnerName,
      offerDescription: partnerOffers.description,
      offerValueLabel: partnerOffers.valueLabel,
      offerBenefitType: partnerOffers.benefitType,
      offerVoucherDelivery: partnerOffers.voucherDelivery,
      offerPartnerUrl: partnerOffers.partnerUrl,
    }).from(benefitClaims)
      .innerJoin(partnerOffers, eq(benefitClaims.offerId, partnerOffers.id))
      .where(eq(benefitClaims.userId, user.id))
      .orderBy(desc(benefitClaims.submittedAt));

    return rows.map(r => ({
      id: r.id,
      offerId: r.offerId,
      status: r.status,
      bandLow: r.bandLow,
      bandHigh: r.bandHigh,
      payoutMethod: r.payoutMethod,
      payoutIbanMasked: r.payoutIbanMasked,
      payoutAccountHolder: r.payoutAccountHolder,
      contactEmail: r.contactEmail,
      kvnr: r.kvnr,
      rewardPayload: r.rewardPayload,
      rejectionReason: r.rejectionReason,
      selfSubmittedAt: r.selfSubmittedAt?.toISOString() ?? null,
      reminderAt: r.reminderAt?.toISOString() ?? null,
      submittedAt: r.submittedAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      shareTokenId: r.shareTokenId,
      verifyUrl: `/verify/${r.shareTokenId}`,
      offer: {
        id: r.offerId,
        title: r.offerTitle,
        partnerName: r.offerPartnerName,
        description: r.offerDescription,
        valueLabel: r.offerValueLabel,
        benefitType: r.offerBenefitType,
        voucherDelivery: r.offerVoucherDelivery,
        partnerUrl: r.offerPartnerUrl,
      },
    }));
  });

  app.patch('/me/claims/:id', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const { id } = req.params as { id: string };
    const body = req.body as {
      selfSubmitted?: boolean;
      reminderDays?: number;
    };

    const [existing] = await db.select().from(benefitClaims)
      .where(and(eq(benefitClaims.id, id), eq(benefitClaims.userId, user.id)))
      .limit(1);

    if (!existing) return reply.status(404).send({ title: 'Einreichung nicht gefunden.' });

    const updateData: Partial<typeof benefitClaims.$inferInsert> = {};
    if (body.selfSubmitted) {
      updateData.selfSubmittedAt = new Date();
      const days = body.reminderDays ?? 14;
      updateData.reminderAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }

    const [updated] = await db.update(benefitClaims)
      .set(updateData)
      .where(eq(benefitClaims.id, id))
      .returning();

    return {
      id: updated.id,
      selfSubmittedAt: updated.selfSubmittedAt?.toISOString() ?? null,
      reminderAt: updated.reminderAt?.toISOString() ?? null,
    };
  });

  app.get('/claims/:id/receipt', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const { id } = req.params as { id: string };
    const [claim] = await db.select({
      id: benefitClaims.id,
      userId: benefitClaims.userId,
      organizationId: benefitClaims.organizationId,
      status: benefitClaims.status,
      bandLow: benefitClaims.bandLow,
      bandHigh: benefitClaims.bandHigh,
      payoutMethod: benefitClaims.payoutMethod,
      payoutIbanMasked: benefitClaims.payoutIbanMasked,
      payoutAccountHolder: benefitClaims.payoutAccountHolder,
      rewardPayload: benefitClaims.rewardPayload,
      submittedAt: benefitClaims.submittedAt,
      decidedAt: benefitClaims.decidedAt,
      offerTitle: partnerOffers.title,
      offerPartnerName: partnerOffers.partnerName,
      offerValueLabel: partnerOffers.valueLabel,
      userDisplayName: users.displayName,
      userEmail: users.email,
    }).from(benefitClaims)
      .innerJoin(partnerOffers, eq(benefitClaims.offerId, partnerOffers.id))
      .innerJoin(users, eq(benefitClaims.userId, users.id))
      .where(eq(benefitClaims.id, id))
      .limit(1);

    if (!claim) return reply.status(404).send({ title: 'Beleg nicht gefunden.' });
    if (claim.userId !== user.id && user.organizationId !== claim.organizationId && user.role !== 'platform_admin') {
      return reply.status(403).send({ title: 'Keine Berechtigung.' });
    }

    return {
      receiptNumber: `REC-${claim.id.slice(0, 8).toUpperCase()}`,
      claimId: claim.id,
      status: claim.status,
      userDisplayName: claim.userDisplayName ?? claim.userEmail,
      userEmail: claim.userEmail,
      offerTitle: claim.offerTitle,
      partnerName: claim.offerPartnerName,
      valueLabel: claim.offerValueLabel,
      payoutMethod: claim.payoutMethod,
      payoutIbanMasked: claim.payoutIbanMasked,
      payoutAccountHolder: claim.payoutAccountHolder,
      transactionRef: claim.rewardPayload?.transactionRef ?? null,
      note: claim.rewardPayload?.note ?? null,
      voucherCode: claim.rewardPayload?.voucherCode ?? null,
      submittedAt: claim.submittedAt.toISOString(),
      decidedAt: claim.decidedAt?.toISOString() ?? null,
    };
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
      payoutMethod: benefitClaims.payoutMethod,
      payoutIbanMasked: benefitClaims.payoutIbanMasked,
      payoutAccountHolder: benefitClaims.payoutAccountHolder,
      contactEmail: benefitClaims.contactEmail,
      kvnr: benefitClaims.kvnr,
      rewardPayload: benefitClaims.rewardPayload,
      rejectionReason: benefitClaims.rejectionReason,
      submittedAt: benefitClaims.submittedAt,
      decidedAt: benefitClaims.decidedAt,
      shareTokenId: benefitClaims.shareTokenId,
      offerTitle: partnerOffers.title,
      offerBenefitType: partnerOffers.benefitType,
      offerVoucherDelivery: partnerOffers.voucherDelivery,
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
      payoutMethod: r.payoutMethod,
      payoutIbanMasked: r.payoutIbanMasked,
      payoutAccountHolder: r.payoutAccountHolder,
      contactEmail: r.contactEmail,
      kvnr: r.kvnr,
      rewardPayload: r.rewardPayload,
      rejectionReason: r.rejectionReason,
      submittedAt: r.submittedAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      offerTitle: r.offerTitle,
      benefitType: r.offerBenefitType,
      voucherDelivery: r.offerVoucherDelivery,
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
    const body = req.body as {
      decision?: 'processing' | 'accepted' | 'rejected';
      note?: string;
      transactionRef?: string;
      rejectionReason?: string;
    };
    if (body.decision !== 'processing' && body.decision !== 'accepted' && body.decision !== 'rejected') {
      return reply.status(400).send({ title: 'Ungültige Entscheidung.' });
    }

    const [existing] = await db.select().from(benefitClaims)
      .where(and(eq(benefitClaims.id, id), eq(benefitClaims.organizationId, user.organizationId)))
      .limit(1);
    if (!existing) return reply.status(404).send({ title: 'Einreichung nicht gefunden.' });
    if (existing.status === 'accepted' || existing.status === 'rejected') {
      return reply.status(409).send({ title: 'Über diese Einreichung wurde bereits entschieden.' });
    }

    const rewardPayload = {
      ...(existing.rewardPayload || {}),
      ...(body.transactionRef ? { transactionRef: body.transactionRef.trim() } : {}),
      ...(body.note ? { note: body.note.trim() } : {}),
    };

    const isFinal = body.decision === 'accepted' || body.decision === 'rejected';
    const [updated] = await db.update(benefitClaims).set({
      status: body.decision,
      decidedAt: isFinal ? new Date() : existing.decidedAt,
      decidedBy: user.id,
      rejectionReason: body.decision === 'rejected' ? (body.rejectionReason?.trim() || null) : null,
      rewardPayload: Object.keys(rewardPayload).length > 0 ? rewardPayload : null,
    }).where(eq(benefitClaims.id, id)).returning();

    return {
      id: updated.id,
      status: updated.status,
      decidedAt: updated.decidedAt?.toISOString() ?? null,
      rejectionReason: updated.rejectionReason,
      rewardPayload: updated.rewardPayload,
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

    const inviteUrl = buildFrontendUrl(`/insurer-invite/${token}`, req);
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
    const inviteUrl = buildFrontendUrl(`/insurer-invite/${token}`, req);
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
