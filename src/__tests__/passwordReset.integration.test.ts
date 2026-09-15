import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { verify as argon2Verify } from '@node-rs/argon2';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Password reset tokens — integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let issueEmailToken: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consumeEmailToken: any;
  let userId: string;
  let originalPasswordHash: string;

  beforeAll(async () => {
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    const tokenModule = await import('../lib/emailTokens.js');
    db = clientModule.db;
    tables = schemaModule;
    issueEmailToken = tokenModule.issueEmailToken;
    consumeEmailToken = tokenModule.consumeEmailToken;

    originalPasswordHash = await import('@node-rs/argon2').then(m => m.hash('original-password-123'));
    const [user] = await db.insert(tables.users).values({
      email: `reset-test-${Date.now()}@test.local`,
      passwordHash: originalPasswordHash,
      birthDate: '1990-01-01',
      sex: 'm',
    }).returning();
    userId = user.id;
  });

  afterAll(async () => {
    if (userId) await db.delete(tables.users).where(eq(tables.users.id, userId));
  });

  it('issues a reset_password token that does not verify as verify_email', async () => {
    const token = await issueEmailToken(userId, 'reset_password');
    const wrongPurpose = await consumeEmailToken(token, 'verify_email');
    expect(wrongPurpose.ok).toBe(false);
    if (!wrongPurpose.ok) expect(wrongPurpose.reason).toBe('not_found');
  });

  it('consumes a reset_password token exactly once and updates the password hash', async () => {
    const token = await issueEmailToken(userId, 'reset_password');

    const result = await consumeEmailToken(token, 'reset_password');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const newHash = await import('@node-rs/argon2').then(m => m.hash('brand-new-password-456'));
    await db.update(tables.users).set({ passwordHash: newHash }).where(eq(tables.users.id, userId));

    const [updated] = await db.select().from(tables.users).where(eq(tables.users.id, userId));
    expect(await argon2Verify(updated.passwordHash, 'brand-new-password-456')).toBe(true);
    expect(await argon2Verify(updated.passwordHash, 'original-password-123')).toBe(false);

    const replay = await consumeEmailToken(token, 'reset_password');
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('used');
  });
});
