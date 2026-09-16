import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';

const ADMIN_EMAIL = 'admin@longevity.app';
const ADMIN_PASSWORD = 'admin-longevity-2026';

async function run() {
  console.log('Seeding platform admin test user…');

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, ADMIN_EMAIL)).limit(1);
  if (existing.length > 0) {
    console.log('Admin user already exists, skipping.');
    process.exit(0);
  }

  const passwordHash = await hash(ADMIN_PASSWORD);
  await db.insert(users).values({
    email: ADMIN_EMAIL,
    passwordHash,
    birthDate: '1990-01-01',
    sex: 'm',
    displayName: 'Platform Admin',
    role: 'platform_admin',
    emailVerifiedAt: new Date(),
  });

  console.log(`Admin user created: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
