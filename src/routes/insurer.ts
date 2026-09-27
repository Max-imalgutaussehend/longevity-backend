import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { db } from '../db/client.js';
import {
  users,
  organizations,
  scoreSnapshots,
  partnerOffers,
  insurerRequests,
  emailTokens,
} from '../db/schema.js';
import { env } from '../env.js';
import { computeScore } from '../score/index.js';
import { issueEmailToken } from '../lib/emailTokens.js';
import { sendMail } from '../lib/mail.js';
import { insurerInviteTemplate, insurerRequestReceivedTemplate } from '../lib/emailTemplates.js';
import { requireRole, getUserSamples } from './helpers.js';
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
    if (userId) {
      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (user) {
        const userSamples = await getUserSamples(userId);
        const score = computeScore({
          profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
          samples: userSamples,
          now,
        });
        band = score.band;
      }
    }

    return rows
      .filter(o => (!o.validFrom || o.validFrom <= now) && (!o.validUntil || o.validUntil >= now))
      .map(o => ({
        id: o.id,
        partnerName: o.partnerName,
        title: o.title,
        description: o.description,
        minBand: o.minBand,
        valueLabel: o.valueLabel,
        isDemo: o.isDemo,
        qualified: band.low >= o.minBand,
      }));
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
      valueLabel: o.valueLabel,
      validFrom: o.validFrom?.toISOString() ?? null,
      validUntil: o.validUntil?.toISOString() ?? null,
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
      valueLabel?: string;
      validFrom?: string;
      validUntil?: string;
    };
    const { title, description, minBand, valueLabel, validFrom, validUntil } = body;

    if (!title || !description || minBand === undefined || !valueLabel) {
      return reply.status(400).send({ title: 'Pflichtfelder fehlen.' });
    }
    if (minBand < 0 || minBand > 100) {
      return reply.status(400).send({ title: 'Mindest-Score-Band muss zwischen 0 und 100 liegen.' });
    }

    const [org] = await db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1);

    const [offer] = await db.insert(partnerOffers).values({
      organizationId: user.organizationId,
      partnerName: org?.name ?? 'Krankenkasse',
      title,
      description,
      minBand,
      valueLabel,
      validFrom: validFrom ? new Date(validFrom) : null,
      validUntil: validUntil ? new Date(validUntil) : null,
      isDemo: false,
    }).returning();

    return reply.status(201).send({
      id: offer.id,
      title: offer.title,
      description: offer.description,
      minBand: offer.minBand,
      valueLabel: offer.valueLabel,
      validFrom: offer.validFrom?.toISOString() ?? null,
      validUntil: offer.validUntil?.toISOString() ?? null,
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
      valueLabel?: string;
      validFrom?: string | null;
      validUntil?: string | null;
    };

    if (body.minBand !== undefined && (body.minBand < 0 || body.minBand > 100)) {
      return reply.status(400).send({ title: 'Mindest-Score-Band muss zwischen 0 und 100 liegen.' });
    }

    const [existing] = await db.select().from(partnerOffers)
      .where(and(eq(partnerOffers.id, id), eq(partnerOffers.organizationId, user.organizationId)))
      .limit(1);
    if (!existing) return reply.status(404).send({ title: 'Angebot nicht gefunden.' });

    const [updated] = await db.update(partnerOffers).set({
      ...(body.title !== undefined && { title: body.title }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.minBand !== undefined && { minBand: body.minBand }),
      ...(body.valueLabel !== undefined && { valueLabel: body.valueLabel }),
      ...(body.validFrom !== undefined && { validFrom: body.validFrom ? new Date(body.validFrom) : null }),
      ...(body.validUntil !== undefined && { validUntil: body.validUntil ? new Date(body.validUntil) : null }),
    }).where(eq(partnerOffers.id, id)).returning();

    return {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      minBand: updated.minBand,
      valueLabel: updated.valueLabel,
      validFrom: updated.validFrom?.toISOString() ?? null,
      validUntil: updated.validUntil?.toISOString() ?? null,
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

  app.post('/contact/insurer', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        errorResponseBuilder: () => ({ title: 'Zu viele Anfragen. Bitte in 15 Minuten erneut versuchen.' }),
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

      const unusablePasswordHash = await hash(randomBytes(32).toString('base64url'));
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
