import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { db } from '../../db/client.js';
import { sources, samples } from '../../db/schema.js';
import { parseAppleHealthXml } from '../../adapters/appleHealth.js';
import { looksLikeZip, extractExportXml, AppleHealthZipError } from '../../adapters/appleHealthZip.js';
import { parseHealthAutoExport } from '../../adapters/healthAutoExport.js';
import { parseFhirBundle } from '../../adapters/fhir.js';
import { requireUser } from '../helpers.js';
import '../../types.js';

export async function sourcesImportRoutes(app: FastifyInstance) {
  app.post('/sources/apple-health/upload', async (req, reply) => {
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

    const parsedSamples = await parseAppleHealthXml(xmlStream, { birthDate: user.birthDate });

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

    return { inserted, sourceId: src.id };
  });

  app.post('/sources/health-auto-export/webhook', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = req.body as any;
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
      await db.update(sources).set({ adapter: 'health_auto_export', lastSyncAt: new Date() }).where(eq(sources.id, src.id));
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

    return reply.status(200).send({ inserted, sourceId: src.id });
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

    const now = new Date();
    const inserted: string[] = [];
    for (const entry of body.values) {
      if (!entry.metric || entry.value === undefined || !entry.unit) continue;
      const measuredAt = entry.measuredAt ? new Date(entry.measuredAt) : now;
      await db.insert(samples).values({
        userId: user.id,
        sourceId: labSource.id,
        metric: entry.metric,
        value: entry.value,
        unit: entry.unit,
        measuredAt,
      }).onConflictDoUpdate({
        target: [samples.userId, samples.metric, samples.measuredAt],
        set: { value: entry.value, unit: entry.unit },
      });
      inserted.push(entry.metric);
    }

    return reply.status(201).send({ inserted, sourceId: labSource.id });
  });

  app.post('/sources/fhir/upload', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const parsedSamples = parseFhirBundle(req.body);
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

    return reply.status(201).send({ inserted, sourceId: labSource.id });
  });
}
