import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { computeScore } from '../score/index.js';
import type { Metric, SourceKind } from '../score/types.js';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Demo user seed harmonization (#49) — integration', () => {
  let db: typeof import('../db/client.js').db;
  let schema: typeof import('../db/schema.js');
  let seedDemoUser: typeof import('../seed/demo.js').run;

  beforeAll(async () => {
    const clientMod = await import('../db/client.js');
    const schemaMod = await import('../db/schema.js');
    const seedMod = await import('../seed/demo.js');

    db = clientMod.db;
    schema = schemaMod;
    seedDemoUser = seedMod.run;
  });

  it('seeds demo user with 4 sources, seed 20260909, and exact score 78 ± 0.5', async () => {
    await seedDemoUser();

    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, 'demo@longevity.app'));
    expect(user).toBeDefined();
    expect(user.birthDate).toBe('1997-03-14');
    expect(user.sex).toBe('m');

    const userSources = await db.select().from(schema.sources).where(eq(schema.sources.userId, user.id));
    expect(userSources).toHaveLength(4);
    const sourceKinds = userSources.map(s => s.kind).sort();
    expect(sourceKinds).toEqual(['apple_health', 'lab', 'oura', 'questionnaire']);

    const userSamples = await db.select().from(schema.samples).where(eq(schema.samples.userId, user.id));
    expect(userSamples.length).toBeGreaterThan(500);

    const scoreResult = computeScore({
      profile: { birthDate: user.birthDate, sex: user.sex as 'm' | 'f' },
      now: new Date(),
      samples: userSamples.map(s => ({
        metric: s.metric as Metric,
        value: s.value,
        unit: s.unit,
        measuredAt: s.measuredAt.toISOString(),
        sourceKind: (userSources.find(src => src.id === s.sourceId)?.kind || 'apple_health') as SourceKind,
      })),
    });

    expect(scoreResult.score).toBeGreaterThanOrEqual(77.5);
    expect(scoreResult.score).toBeLessThanOrEqual(78.5);
    expect(scoreResult.coverage).toBeGreaterThanOrEqual(0.80);
    expect(scoreResult.coverage).toBeLessThanOrEqual(0.84);
    expect(scoreResult.bioAge).toBeGreaterThanOrEqual(scoreResult.chronoAge - 15);
    expect(scoreResult.bioAge).toBeLessThanOrEqual(scoreResult.chronoAge + 15);
  });

  it('is idempotent and can be re-run without duplicate key errors', async () => {
    const res = await seedDemoUser();
    expect(res).toBeDefined();
    expect(res.sampleCount).toBeGreaterThan(500);
    const count = await db.select().from(schema.users).where(eq(schema.users.email, 'demo@longevity.app'));
    expect(count).toHaveLength(1);
  });
});
