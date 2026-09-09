import { db } from '../db/client.js';
import { users, sources, samples } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import { generate } from '../mock/generate.js';

const DEMO_EMAIL = 'demo@longevity.app';
const DEMO_PASSWORD = 'demo-longevity-2026';

async function run() {
  console.log('Seeding demo user…');

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  if (existing.length > 0) {
    console.log('Demo user already exists, skipping.');
    process.exit(0);
  }

  const passwordHash = await hash(DEMO_PASSWORD);
  const [user] = await db.insert(users).values({
    email: DEMO_EMAIL,
    passwordHash,
    birthDate: '1990-04-15',
    sex: 'm',
    displayName: 'Demo User',
  }).returning();

  const [src] = await db.insert(sources).values({
    userId: user.id,
    kind: 'apple_health',
    adapter: 'mock',
    enabled: true,
    lastSyncAt: new Date(),
  }).returning();

  const mockSamples = generate(42, 90);
  if (mockSamples.length > 0) {
    await db.insert(samples).values(mockSamples.map(s => ({
      userId: user.id,
      sourceId: src.id,
      metric: s.metric,
      value: s.value,
      unit: s.unit,
      measuredAt: new Date(s.measuredAt),
    })));
  }

  console.log(`Demo user created: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
