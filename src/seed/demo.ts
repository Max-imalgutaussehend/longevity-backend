import { db } from '../db/client.js';
import { users, sources, samples } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import { generate } from '../mock/generate.js';
import demoFixture from '../score/__tests__/__fixtures__/demo.json';

const DEMO_EMAIL = 'demo@longevity.app';
const DEMO_PASSWORD = 'demo-longevity-2026';
const DEMO_SEED = 20260909;

export async function run() {
  console.log('Seeding demo user…');

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  if (existing.length > 0) {
    console.log('Demo user already exists, resetting user and relations…');
    await db.delete(users).where(eq(users.id, existing[0].id));
  }

  const passwordHash = await hash(DEMO_PASSWORD);
  const [user] = await db.insert(users).values({
    email: DEMO_EMAIL,
    passwordHash,
    birthDate: demoFixture.profile.birthDate,
    sex: demoFixture.profile.sex,
    displayName: 'Demo User',
    emailVerifiedAt: new Date(),
  }).returning();

  const [appleHealthSrc] = await db.insert(sources).values({
    userId: user.id,
    kind: 'apple_health',
    adapter: 'mock',
    enabled: true,
    lastSyncAt: new Date(),
  }).returning();

  const [ouraSrc] = await db.insert(sources).values({
    userId: user.id,
    kind: 'oura',
    adapter: 'mock',
    enabled: true,
    lastSyncAt: new Date(),
  }).returning();

  const [labSrc] = await db.insert(sources).values({
    userId: user.id,
    kind: 'lab',
    adapter: 'manual',
    enabled: true,
    lastSyncAt: new Date(),
  }).returning();

  const [questionnaireSrc] = await db.insert(sources).values({
    userId: user.id,
    kind: 'questionnaire',
    adapter: 'manual',
    enabled: true,
    lastSyncAt: new Date(),
  }).returning();

  const sourceMap: Record<string, string> = {
    apple_health: appleHealthSrc.id,
    oura: ouraSrc.id,
    lab: labSrc.id,
    questionnaire: questionnaireSrc.id,
  };

  const now = new Date();
  const fixtureNow = new Date(demoFixture.now).getTime();

  // 1. Overlay golden fixture samples with identical relative age to now
  const fixtureSamplesWithDate = demoFixture.samples.map(f => {
    const ageMs = fixtureNow - new Date(f.measuredAt).getTime();
    return {
      metric: f.metric,
      value: f.value,
      unit: f.unit,
      sourceKind: f.sourceKind,
      targetDate: new Date(now.getTime() - ageMs),
    };
  });

  const latestByMetric = new Map(fixtureSamplesWithDate.map(f => [f.metric, f.targetDate.getTime()]));

  // 2. Generate 90 days history with seed 20260909
  const rawMock = generate(DEMO_SEED, 90, now);
  // Keep only historical samples strictly older than the golden fixture targetDate so the golden fixture remains the latest
  const history = rawMock.filter(s => {
    const latestTime = latestByMetric.get(s.metric);
    return !latestTime || new Date(s.measuredAt).getTime() < latestTime;
  });

  const allSamples = [
    ...history.map(s => ({
      userId: user.id,
      sourceId: sourceMap[s.sourceKind] || appleHealthSrc.id,
      metric: s.metric,
      value: s.value,
      unit: s.unit,
      measuredAt: new Date(s.measuredAt),
    })),
    ...fixtureSamplesWithDate.map(f => ({
      userId: user.id,
      sourceId: sourceMap[f.sourceKind] || appleHealthSrc.id,
      metric: f.metric,
      value: f.value,
      unit: f.unit,
      measuredAt: f.targetDate,
    })),
  ];

  if (allSamples.length > 0) {
    // Insert in batches of 100 to stay well below parameter limits
    const BATCH_SIZE = 100;
    for (let i = 0; i < allSamples.length; i += BATCH_SIZE) {
      const batch = allSamples.slice(i, i + BATCH_SIZE);
      await db.insert(samples).values(batch);
    }
  }

  console.log(`Demo user created: ${DEMO_EMAIL} / ${DEMO_PASSWORD} with ${allSamples.length} samples across 4 sources.`);
  return { user, sampleCount: allSamples.length };
}

if (process.argv[1] && (process.argv[1].endsWith('demo.ts') || process.argv[1].endsWith('demo.js'))) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
