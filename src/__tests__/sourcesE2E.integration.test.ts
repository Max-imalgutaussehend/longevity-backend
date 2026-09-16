import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

import { parseAppleHealthXml } from '../adapters/appleHealth.js';
import { extractExportXml } from '../adapters/appleHealthZip.js';
import { parseHealthAutoExport } from '../adapters/healthAutoExport.js';
import { parseFhirBundle } from '../adapters/fhir.js';
import { parseWithingsMeasures, parseWithingsActivity, parseWithingsSleep } from '../adapters/withings.js';
import { parseGoogleFitAggregate, parseGoogleHealthV4DataPoints } from '../adapters/googleFit.js';
import { parseOuraSleep, parseOuraReadiness, parseOuraActivity } from '../adapters/oura.js';
import { countStrengthSessions, zone2MinutesFromZones } from '../adapters/strava.js';
import { computeScore } from '../score/index.js';
import type { Sample } from '../score/types.js';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Sources End-to-End Integration Suite — All 8 Adapters (#19)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let schema: any;
  const createdUserIds: string[] = [];

  const fixturesDir = resolve(__dirname, '__fixtures__');

  beforeAll(async () => {
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    schema = schemaModule;
  });

  afterAll(async () => {
    if (db && createdUserIds.length > 0) {
      for (const uid of createdUserIds) {
        await db.delete(schema.samples).where(eq(schema.samples.userId, uid));
        await db.delete(schema.sources).where(eq(schema.sources.userId, uid));
        await db.delete(schema.users).where(eq(schema.users.id, uid));
      }
    }
  });

  async function createTestUser(label: string) {
    const [user] = await db.insert(schema.users).values({
      email: `sources-e2e-${label}-${Date.now()}@test.local`,
      passwordHash: 'dummy-hash',
      birthDate: '1992-05-15',
      sex: 'm',
      displayName: `E2E Tester ${label}`,
    }).returning();
    createdUserIds.push(user.id);
    return user;
  }

  async function getUserSamples(userId: string): Promise<Sample[]> {
    const rows = await db
      .select({
        metric: schema.samples.metric,
        value: schema.samples.value,
        unit: schema.samples.unit,
        measuredAt: schema.samples.measuredAt,
        sourceKind: schema.sources.kind,
      })
      .from(schema.samples)
      .innerJoin(schema.sources, eq(schema.samples.sourceId, schema.sources.id))
      .where(and(eq(schema.samples.userId, userId), eq(schema.sources.enabled, true)));

    return rows.map((r: { metric: string; value: number; unit: string; measuredAt: Date; sourceKind: string }) => ({
      metric: r.metric as Sample['metric'],
      value: r.value,
      unit: r.unit,
      measuredAt: r.measuredAt.toISOString(),
      sourceKind: (r.sourceKind ?? 'apple_health') as Sample['sourceKind'],
    }));
  }

  // ── 1. Apple Health XML Import ──────────────────────────────────────────────
  it('1. Apple Health XML: parses export XML, persists samples and calculates score', async () => {
    const user = await createTestUser('ah-xml');
    const xmlContent = readFileSync(resolve(fixturesDir, 'apple_health_mini.xml'));
    const stream = Readable.from(xmlContent);
    const parsedSamples = await parseAppleHealthXml(stream, { birthDate: user.birthDate });

    expect(parsedSamples.length).toBeGreaterThan(0);
    const metrics = new Set(parsedSamples.map(s => s.metric));
    expect(metrics.has('steps')).toBe(true);
    expect(metrics.has('resting_hr')).toBe(true);

    const [src] = await db.insert(schema.sources).values({
      userId: user.id,
      kind: 'apple_health',
      adapter: 'upload',
      enabled: true,
      lastSyncAt: new Date(),
    }).returning();

    for (const s of parsedSamples) {
      await db.insert(schema.samples).values({
        userId: user.id,
        sourceId: src.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing();
    }

    const samples = await getUserSamples(user.id);
    const score = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples,
      now: new Date('2024-06-05T12:00:00Z'),
    });

    expect(score.score).toBeGreaterThan(0);
    expect(score.coverage).toBeGreaterThan(0);
    expect(score.domains.some(d => d.domain === 'activity' && d.score > 0)).toBe(true);
  });

  // ── 2. Apple Health ZIP Import ──────────────────────────────────────────────
  it('2. Apple Health ZIP: extracts Export.xml from archive, ingests samples and computes score', async () => {
    const user = await createTestUser('ah-zip');
    const zipBuffer = readFileSync(resolve(fixturesDir, 'apple_health_mini.zip'));
    const xmlStream = await extractExportXml(zipBuffer);
    const parsedSamples = await parseAppleHealthXml(xmlStream, { birthDate: user.birthDate });

    expect(parsedSamples.length).toBeGreaterThan(0);
    const metrics = new Set(parsedSamples.map(s => s.metric));
    expect(metrics.has('steps')).toBe(true);

    const [src] = await db.insert(schema.sources).values({
      userId: user.id,
      kind: 'apple_health',
      adapter: 'health_export_zip',
      enabled: true,
      lastSyncAt: new Date(),
    }).returning();

    for (const s of parsedSamples) {
      await db.insert(schema.samples).values({
        userId: user.id,
        sourceId: src.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing();
    }

    const samples = await getUserSamples(user.id);
    const score = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples,
      now: new Date('2024-06-05T12:00:00Z'),
    });

    expect(score.score).toBeGreaterThan(0);
  });

  // ── 3. Health Auto Export JSON Webhook ──────────────────────────────────────
  it('3. Health Auto Export: processes multi-metric payload + workouts into samples and score', async () => {
    const user = await createTestUser('hae');
    const payload = {
      metrics: [
        {
          name: 'StepCount',
          units: 'count',
          data: [{ date: '2026-09-14 18:00:00', qty: 10420 }],
        },
        {
          name: 'HeartRate',
          units: 'bpm',
          data: [{ date: '2026-09-14 08:30:00', qty: 58 }],
        },
        {
          name: 'HeartRateVariabilitySDNN',
          units: 'ms',
          data: [{ date: '2026-09-14 07:00:00', qty: 52 }],
        },
        {
          name: 'SleepAnalysis',
          units: 'hr',
          data: [
            { date: '2026-09-13 23:15:00', qty: 7.8 },
            { date: '2026-09-14 23:30:00', qty: 8.1 },
          ],
        },
        {
          name: 'VO2Max',
          units: 'ml/kg/min',
          data: [{ date: '2026-09-14 10:00:00', qty: 48.5 }],
        },
      ],
      workouts: [
        {
          name: 'Traditional Strength Training',
          start: '2026-09-14T15:00:00Z',
          duration: 3600,
        },
        {
          name: 'Outdoor Run',
          start: '2026-09-14T10:00:00Z',
          duration: 2700,
          heartRateAvg: 125, // Zone 2
        },
      ],
    };

    const parsedSamples = parseHealthAutoExport(payload, { birthDate: user.birthDate });
    expect(parsedSamples.length).toBeGreaterThanOrEqual(6);

    const metrics = new Set(parsedSamples.map(s => s.metric));
    expect(metrics.has('steps')).toBe(true);
    expect(metrics.has('resting_hr')).toBe(true);
    expect(metrics.has('hrv_rmssd')).toBe(true);
    expect(metrics.has('sleep_duration')).toBe(true);
    expect(metrics.has('sleep_consistency')).toBe(true);
    expect(metrics.has('strength_sessions')).toBe(true);
    expect(metrics.has('zone2_minutes')).toBe(true);

    const [src] = await db.insert(schema.sources).values({
      userId: user.id,
      kind: 'apple_health',
      adapter: 'health_auto_export',
      enabled: true,
      lastSyncAt: new Date(),
    }).returning();

    for (const s of parsedSamples) {
      await db.insert(schema.samples).values({
        userId: user.id,
        sourceId: src.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing();
    }

    const samples = await getUserSamples(user.id);
    const score = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples,
      now: new Date('2026-09-15T12:00:00Z'),
    });

    expect(score.score).toBeGreaterThan(0);
    expect(score.domains.some(d => d.domain === 'recovery' && d.score > 0)).toBe(true);
    expect(score.domains.some(d => d.domain === 'activity' && d.score > 0)).toBe(true);
  });

  // ── 4. FHIR Electronic Health Records ───────────────────────────────────────
  it('4. FHIR: extracts LOINC lab values from bundle, normalizes units and scores cardiometabolic domain', async () => {
    const user = await createTestUser('fhir');
    const bundleContent = JSON.parse(readFileSync(resolve(fixturesDir, 'fhir_bundle.json'), 'utf-8'));
    const parsedSamples = parseFhirBundle(bundleContent);

    expect(parsedSamples.length).toBeGreaterThanOrEqual(4);
    const metrics = new Set(parsedSamples.map(s => s.metric));
    expect(metrics.has('ldl')).toBe(true);
    expect(metrics.has('hdl')).toBe(true);
    expect(metrics.has('hba1c')).toBe(true);
    expect(metrics.has('systolic_bp')).toBe(true);

    const [src] = await db.insert(schema.sources).values({
      userId: user.id,
      kind: 'lab',
      adapter: 'fhir',
      enabled: true,
      lastSyncAt: new Date(),
    }).returning();

    for (const s of parsedSamples) {
      await db.insert(schema.samples).values({
        userId: user.id,
        sourceId: src.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing();
    }

    const samples = await getUserSamples(user.id);
    const score = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples,
      now: new Date('2024-06-05T12:00:00Z'),
    });

    expect(score.score).toBeGreaterThan(0);
    const cardio = score.domains.find(d => d.domain === 'cardiometabolic');
    expect(cardio).toBeDefined();
    expect(cardio!.metrics.some(m => m.metric === 'ldl' && m.available)).toBe(true);
    expect(cardio!.metrics.some(m => m.metric === 'hdl' && m.available)).toBe(true);
    expect(cardio!.metrics.some(m => m.metric === 'hba1c' && m.available)).toBe(true);
  });

  // ── 5. Withings API Adapter ────────────────────────────────────────────────
  it('5. Withings: parses measure groups, activity and sleep into samples and persists them', async () => {
    const user = await createTestUser('withings');
    const rawMeasures = JSON.parse(readFileSync(resolve(fixturesDir, 'withings_getmeas.json'), 'utf-8'));
    const measureSamples = parseWithingsMeasures(rawMeasures);
    const activitySamples = parseWithingsActivity({
      status: 0,
      body: { activities: [{ date: '2024-06-01', steps: 9150 }] },
    });
    const sleepSamples = parseWithingsSleep({
      status: 0,
      body: { series: [{ startdate: 1717200000, enddate: 1717200000 + 8 * 3600 }] },
    });

    const allSamples = [...measureSamples, ...activitySamples, ...sleepSamples];
    expect(allSamples.length).toBeGreaterThanOrEqual(4);

    const [src] = await db.insert(schema.sources).values({
      userId: user.id,
      kind: 'withings',
      adapter: 'oauth',
      enabled: true,
      lastSyncAt: new Date(),
    }).returning();

    for (const s of allSamples) {
      await db.insert(schema.samples).values({
        userId: user.id,
        sourceId: src.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing();
    }

    const samples = await getUserSamples(user.id);
    const score = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples,
      now: new Date('2024-06-05T12:00:00Z'),
    });

    expect(score.score).toBeGreaterThan(0);
    expect(samples.some(s => s.sourceKind === 'withings' && s.metric === 'systolic_bp')).toBe(true);
    expect(samples.some(s => s.sourceKind === 'withings' && s.metric === 'steps')).toBe(true);
    expect(samples.some(s => s.sourceKind === 'withings' && s.metric === 'sleep_duration')).toBe(true);
  });

  // ── 6. Google Fit & Health Connect Adapter ──────────────────────────────────
  it('6. Google Health Connect & Fit: processes REST aggregate and intraday records with deduplication', async () => {
    const user = await createTestUser('google');
    // Test both REST aggregate and Health Connect records
    const rawAggregate = JSON.parse(readFileSync(resolve(fixturesDir, 'google_fit_aggregate.json'), 'utf-8'));
    const aggregateSamples = parseGoogleFitAggregate(rawAggregate);

    const healthConnectRecords = [
      {
        dataSourceId: 'raw:com.google.step_count.delta:com.google.android.apps.fitness:',
        metadata: { dataOrigin: { packageName: 'com.google.android.apps.fitness' } },
        steps: {
          count: 8500,
          interval: { startTime: '2026-09-14T00:00:00Z', endTime: '2026-09-14T23:59:59Z' },
        },
      },
      {
        dataSourceId: 'raw:com.google.step_count.delta:com.fitbit.FitbitMobile:',
        metadata: { dataOrigin: { packageName: 'com.fitbit.FitbitMobile' } },
        steps: {
          count: 8400, // duplicate from lower priority tracker
          interval: { startTime: '2026-09-14T00:00:00Z', endTime: '2026-09-14T23:59:59Z' },
        },
      },
    ];

    const v4StepSamples = parseGoogleHealthV4DataPoints('steps', healthConnectRecords);
    // Deduplication should ensure only highest-priority origin survives
    expect(v4StepSamples).toHaveLength(1);
    expect(v4StepSamples[0].value).toBe(8500);

    const allSamples = [...aggregateSamples, ...v4StepSamples];

    const [src] = await db.insert(schema.sources).values({
      userId: user.id,
      kind: 'google_fit',
      adapter: 'oauth',
      enabled: true,
      lastSyncAt: new Date(),
    }).returning();

    for (const s of allSamples) {
      await db.insert(schema.samples).values({
        userId: user.id,
        sourceId: src.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing();
    }

    const samples = await getUserSamples(user.id);
    const score = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples,
      now: new Date('2026-09-15T12:00:00Z'),
    });

    expect(score.score).toBeGreaterThan(0);
    expect(samples.some(s => s.sourceKind === 'google_fit' && s.metric === 'steps')).toBe(true);
  });

  // ── 7. Oura API Adapter ────────────────────────────────────────────────────
  it('7. Oura: ingests sleep, readiness and activity with continuous midnight sleep consistency', async () => {
    const user = await createTestUser('oura');
    const rawSleep = JSON.parse(readFileSync(resolve(fixturesDir, 'oura_sleep.json'), 'utf-8'));
    const rawReadiness = JSON.parse(readFileSync(resolve(fixturesDir, 'oura_readiness.json'), 'utf-8'));
    const rawActivity = JSON.parse(readFileSync(resolve(fixturesDir, 'oura_activity.json'), 'utf-8'));

    const sleepSamples = parseOuraSleep(rawSleep);
    const readinessSamples = parseOuraReadiness(rawReadiness);
    const activitySamples = parseOuraActivity(rawActivity);

    const allSamples = [...sleepSamples, ...readinessSamples, ...activitySamples];
    expect(allSamples.length).toBeGreaterThanOrEqual(6);

    const metrics = new Set(allSamples.map(s => s.metric));
    expect(metrics.has('sleep_duration')).toBe(true);
    expect(metrics.has('sleep_consistency')).toBe(true);
    expect(metrics.has('hrv_rmssd')).toBe(true);
    expect(metrics.has('resting_hr')).toBe(true);
    expect(metrics.has('steps')).toBe(true);
    expect(metrics.has('zone2_minutes')).toBe(true);

    const [src] = await db.insert(schema.sources).values({
      userId: user.id,
      kind: 'oura',
      adapter: 'oauth',
      enabled: true,
      lastSyncAt: new Date(),
    }).returning();

    for (const s of allSamples) {
      await db.insert(schema.samples).values({
        userId: user.id,
        sourceId: src.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing();
    }

    const samples = await getUserSamples(user.id);
    const score = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples,
      now: new Date('2024-06-05T12:00:00Z'),
    });

    expect(score.score).toBeGreaterThan(0);
    const recovery = score.domains.find(d => d.domain === 'recovery');
    expect(recovery).toBeDefined();
    expect(recovery!.metrics.some(m => m.metric === 'hrv_rmssd' && m.available)).toBe(true);
    expect(recovery!.metrics.some(m => m.metric === 'sleep_duration' && m.available)).toBe(true);
  });

  // ── 8. Strava API Adapter ──────────────────────────────────────────────────
  it('8. Strava: aggregates weekly strength sessions and zone 2 cardio minutes', async () => {
    const user = await createTestUser('strava');
    const rawActivities = JSON.parse(readFileSync(resolve(fixturesDir, 'strava_activities.json'), 'utf-8'));
    const strengthSamples = countStrengthSessions(rawActivities);
    const zone2Sample = zone2MinutesFromZones({
      heart_rate: {
        distribution_buckets: [
          { min: 0, max: 110, time: 300 },
          { min: 110, max: 135, time: 2400 }, // 40 minutes in Zone 2
          { min: 135, max: 160, time: 600 },
        ],
      },
    }, '2024-06-04T07:00:00Z');

    const allSamples = [...strengthSamples];
    if (zone2Sample) allSamples.push(zone2Sample);

    expect(allSamples.length).toBeGreaterThanOrEqual(2);
    expect(allSamples.some(s => s.metric === 'strength_sessions')).toBe(true);
    expect(allSamples.some(s => s.metric === 'zone2_minutes')).toBe(true);

    const [src] = await db.insert(schema.sources).values({
      userId: user.id,
      kind: 'strava',
      adapter: 'oauth',
      enabled: true,
      lastSyncAt: new Date(),
    }).returning();

    for (const s of allSamples) {
      await db.insert(schema.samples).values({
        userId: user.id,
        sourceId: src.id,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        measuredAt: new Date(s.measuredAt),
      }).onConflictDoNothing();
    }

    const samples = await getUserSamples(user.id);
    const score = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      samples,
      now: new Date('2024-06-05T12:00:00Z'),
    });

    expect(score.score).toBeGreaterThan(0);
    const activity = score.domains.find(d => d.domain === 'activity');
    expect(activity).toBeDefined();
    expect(activity!.metrics.some(m => m.metric === 'strength_sessions' && m.available)).toBe(true);
    expect(activity!.metrics.some(m => m.metric === 'zone2_minutes' && m.available)).toBe(true);
  });
});
