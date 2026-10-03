import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../lib/password.js';

const ADMIN_EMAIL = 'admin@longevity.app';
const ADMIN_PASSWORD = 'admin-longevity-2026';

async function run() {
  console.log('Seeding platform admin test user…');

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, ADMIN_EMAIL)).limit(1);
  if (existing.length > 0) {
    const passwordHash = await hashPassword(ADMIN_PASSWORD);
    await db.update(users).set({
      passwordHash,
      role: 'platform_admin',
      emailVerifiedAt: new Date(),
    }).where(eq(users.id, existing[0].id));
    console.log(`Admin user already exists, updated password to ${ADMIN_PASSWORD}.`);
    process.exit(0);
  }

  const passwordHash = await hashPassword(ADMIN_PASSWORD);
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
