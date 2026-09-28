import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { db } from '../../db/client.js';
import { sources, samples, users } from '../../db/schema.js';
import { env } from '../../env.js';
import { parseAppleHealthXml } from '../../adapters/appleHealth.js';
import { looksLikeZip, extractExportXml, AppleHealthZipError } from '../../adapters/appleHealthZip.js';
import { parseHealthAutoExport, type HaePayload } from '../../adapters/healthAutoExport.js';
import { parseFhirBundle } from '../../adapters/fhir.js';
import type { Sample } from '../../score/types.js';
import { requireUser, invalidateTodaySnapshot } from '../helpers.js';
import '../../types.js';

const QUESTIONNAIRE_METRICS = new Set(['smoking', 'alcohol_units']);

export async function sourcesImportRoutes(app: FastifyInstance) {
  app.post('/sources/apple-health/upload', {
    config: {
      rateLimit: {
        max: env.NODE_ENV === 'test' || env.NODE_ENV === 'development' || !!process.env.CI ? 200 : 5,
        timeWindow: '15 minutes',
        errorResponseBuilder: () => ({ statusCode: 429, title: 'Zu viele Uploads. Bitte in 15 Minuten erneut versuchen.' }),
      },
    },
  }, async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const data = await req.file();
    if (!data) return reply.status(400).send({ title: 'Keine Datei hochgeladen.' });

    const buffer = await data.toBuffer();

    let xmlStream: Readable;
    if (looksLikeZip(buffer)) {
      try {
        xmlStream = await extractExportXml(buffer);
      } catch (err) {
        const message = err instanceof AppleHealthZipError ? err.message : 'Das ZIP-Archiv konnte nicht verarbeitet werden.';
        return reply.status(400).send({ title: message });
      }
    } else {
      xmlStream = Readable.from(buffer);
    }

    let parsedSamples: Sample[];
    try {
      parsedSamples = await parseAppleHealthXml(xmlStream, { birthDate: user.birthDate });
    } catch (err) {
      return reply.status(400).send({
        title: (err as Error).message || 'Die XML-Datei konnte nicht verarbeitet werden.',
      });
    }

    if (parsedSamples.length === 0) {
      return reply.status(400).send({
        title: 'Keine bekannten Apple-Health-Metriken in der Datei gefunden. Bitte export.xml oder das vollständige ZIP-Archiv aus der Health-App hochladen.',
      });
    }

    let [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'apple_health')))
      .limit(1);

    if (!src) {
      [src] = await db.insert(sources).values({
        userId: user.id,
        kind: 'apple_health',
        adapter: 'upload',
        enabled: true,
        consentAt: new Date(),
        lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, src.id));
    }

    let inserted = 0;
    for (const s of parsedSamples) {
      await db.insert(samples).values({
        userId: user.id,
        sourceId: src.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing();
      inserted++;
    }

    await invalidateTodaySnapshot(user.id);
    return { inserted, sourceId: src.id };
  });

  async function ingestHealthAutoExport(user: { id: string; birthDate: string }, payload: HaePayload) {
    const parsedSamples = parseHealthAutoExport(payload, { birthDate: user.birthDate });

    let [src] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'apple_health')))
      .limit(1);

    if (!src) {
      [src] = await db.insert(sources).values({
        userId: user.id,
        kind: 'apple_health',
        adapter: 'health_auto_export',
        enabled: true,
        consentAt: new Date(),
        lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ adapter: 'health_auto_export', lastSyncAt: new Date(), enabled: true }).where(eq(sources.id, src.id));
    }

    let inserted = 0;
    for (const s of parsedSamples) {
      const rows = await db.insert(samples).values({
        userId: user.id,
        sourceId: src.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing().returning({ id: samples.id });
      if (rows.length > 0) inserted++;
    }

    await invalidateTodaySnapshot(user.id);
    return { inserted, sourceId: src.id };
  }

  // Token-authenticated webhook (URL parameter :secret, no session cookie required)
  app.post('/sources/health-auto-export/webhook/:secret', async (req, reply) => {
    const { secret } = req.params as { secret: string };
    if (!secret || secret.trim() === '') {
      return reply.status(401).send({ title: 'Ungültiges Webhook-Secret.' });
    }

    const [user] = await db.select().from(users).where(eq(users.webhookSecret, secret.trim())).limit(1);
    if (!user) {
      return reply.status(401).send({ title: 'Ungültiges Webhook-Secret.' });
    }

    const payload = req.body as HaePayload;
    const result = await ingestHealthAutoExport(user, payload);
    return reply.status(200).send(result);
  });

  // Dual-mode webhook: accepts secret via query parameter, header x-webhook-secret, or session cookie
  app.post('/sources/health-auto-export/webhook', async (req, reply) => {
    const querySecret = (req.query as { secret?: string })?.secret;
    const headerSecret = req.headers['x-webhook-secret'] as string | undefined;
    const secret = querySecret || headerSecret;

    if (secret) {
      const [user] = await db.select().from(users).where(eq(users.webhookSecret, secret.trim())).limit(1);
      if (!user) {
        return reply.status(401).send({ title: 'Ungültiges Webhook-Secret.' });
      }
      const payload = req.body as HaePayload;
      const result = await ingestHealthAutoExport(user, payload);
      return reply.status(200).send(result);
    }

    const user = await requireUser(req, reply);
    if (!user) return;

    const payload = req.body as HaePayload;
    const result = await ingestHealthAutoExport(user, payload);
    return reply.status(200).send(result);
  });

  // Retrieve current webhook secret and URL
  app.get('/sources/health-auto-export/secret', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    return {
      webhookSecret: user.webhookSecret,
      webhookUrl: `${baseUrl}/api/sources/health-auto-export/webhook/${user.webhookSecret}`,
    };
  });

  // Regenerate / rotate webhook secret
  app.post('/sources/health-auto-export/secret/rotate', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const newSecret = crypto.randomBytes(32).toString('hex');
    await db.update(users).set({ webhookSecret: newSecret }).where(eq(users.id, user.id));

    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    return reply.status(200).send({
      webhookSecret: newSecret,
      webhookUrl: `${baseUrl}/api/sources/health-auto-export/webhook/${newSecret}`,
    });
  });

  async function handleQuestionnaireSubmission(
    user: { id: string },
    body: { values?: Array<{ metric: string; value: number; unit: string; measuredAt?: string }> },
    reply: FastifyReply,
  ) {
    if (!Array.isArray(body.values) || body.values.length === 0) {
      return reply.status(400).send({ title: 'values-Array erforderlich.' });
    }

    let [questSource] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'questionnaire')))
      .limit(1);

    if (!questSource) {
      [questSource] = await db.insert(sources).values({
        userId: user.id,
        kind: 'questionnaire',
        adapter: 'manual',
        enabled: true,
        consentAt: new Date(),
        lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ lastSyncAt: new Date(), enabled: true }).where(eq(sources.id, questSource.id));
    }

    const now = new Date();
    const inserted: string[] = [];
    for (const entry of body.values) {
      if (!entry.metric || entry.value === undefined || !entry.unit) continue;
      const measuredAt = entry.measuredAt ? new Date(entry.measuredAt) : now;
      await db.insert(samples).values({
        userId: user.id,
        sourceId: questSource.id,
        metric: entry.metric,
        value: entry.value,
        unit: entry.unit,
        measuredAt,
      }).onConflictDoUpdate({
        target: [samples.userId, samples.metric, samples.measuredAt],
        set: { value: entry.value, unit: entry.unit, sourceId: questSource.id },
      });
      inserted.push(entry.metric);
    }

    await invalidateTodaySnapshot(user.id);
    return reply.status(201).send({ inserted, sourceId: questSource.id });
  }

  app.post('/questionnaire', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return handleQuestionnaireSubmission(user, (req.body as { values?: Array<{ metric: string; value: number; unit: string; measuredAt?: string }> }) || {}, reply);
  });

  app.post('/lifestyle', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return handleQuestionnaireSubmission(user, (req.body as { values?: Array<{ metric: string; value: number; unit: string; measuredAt?: string }> }) || {}, reply);
  });

  app.post('/labs', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const body = req.body as { values?: Array<{ metric: string; value: number; unit: string; measuredAt?: string }> };
    if (!Array.isArray(body.values) || body.values.length === 0) {
      return reply.status(400).send({ title: 'values-Array erforderlich.' });
    }

    let [labSource] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'lab')))
      .limit(1);

    if (!labSource) {
      [labSource] = await db.insert(sources).values({
        userId: user.id,
        kind: 'lab',
        adapter: 'manual',
        enabled: true,
        consentAt: new Date(),
        lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, labSource.id));
    }

    let questSource: typeof labSource | null = null;
    const now = new Date();
    const inserted: string[] = [];
    for (const entry of body.values) {
      if (!entry.metric || entry.value === undefined || !entry.unit) continue;
      const measuredAt = entry.measuredAt ? new Date(entry.measuredAt) : now;

      let targetSourceId = labSource.id;
      if (QUESTIONNAIRE_METRICS.has(entry.metric)) {
        if (!questSource) {
          const [existingQuest] = await db.select().from(sources)
            .where(and(eq(sources.userId, user.id), eq(sources.kind, 'questionnaire')))
            .limit(1);
          if (existingQuest) {
            questSource = existingQuest;
            await db.update(sources).set({ lastSyncAt: new Date(), enabled: true }).where(eq(sources.id, questSource.id));
          } else {
            const [newQuest] = await db.insert(sources).values({
              userId: user.id,
              kind: 'questionnaire',
              adapter: 'manual',
              enabled: true,
              consentAt: new Date(),
              lastSyncAt: new Date(),
            }).returning();
            questSource = newQuest;
          }
        }
        targetSourceId = questSource.id;
      }

      await db.insert(samples).values({
        userId: user.id,
        sourceId: targetSourceId,
        metric: entry.metric,
        value: entry.value,
        unit: entry.unit,
        measuredAt,
      }).onConflictDoUpdate({
        target: [samples.userId, samples.metric, samples.measuredAt],
        set: { value: entry.value, unit: entry.unit, sourceId: targetSourceId },
      });
      inserted.push(entry.metric);
    }

    await invalidateTodaySnapshot(user.id);
    return reply.status(201).send({ inserted, sourceId: labSource.id });
  });

  app.post('/sources/fhir/upload', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    let parsedSamples: Sample[];
    try {
      parsedSamples = parseFhirBundle(req.body);
    } catch (err) {
      return reply.status(400).send({ title: (err as Error).message || 'Ungültiges FHIR-Dokument.' });
    }
    if (parsedSamples.length === 0) {
      return reply.status(400).send({ title: 'Keine bekannten LOINC-Metriken im FHIR-Bundle gefunden.' });
    }

    let [labSource] = await db.select().from(sources)
      .where(and(eq(sources.userId, user.id), eq(sources.kind, 'lab')))
      .limit(1);

    if (!labSource) {
      [labSource] = await db.insert(sources).values({
        userId: user.id,
        kind: 'lab',
        adapter: 'fhir',
        enabled: true,
        consentAt: new Date(),
        lastSyncAt: new Date(),
      }).returning();
    } else {
      await db.update(sources).set({ lastSyncAt: new Date() }).where(eq(sources.id, labSource.id));
    }

    let inserted = 0;
    for (const s of parsedSamples) {
      const rows = await db.insert(samples).values({
        userId: user.id,
        sourceId: labSource.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoUpdate({
        target: [samples.userId, samples.metric, samples.measuredAt],
        set: { value: s.value, unit: s.unit },
      }).returning({ id: samples.id });
      if (rows.length > 0) inserted++;
    }

    await invalidateTodaySnapshot(user.id);
    return reply.status(201).send({ inserted, sourceId: labSource.id });
  });
}
