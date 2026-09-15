import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Email verification tokens — integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let issueEmailToken: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consumeEmailToken: any;
  let userId: string;

  beforeAll(async () => {
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    const tokenModule = await import('../lib/emailTokens.js');
    db = clientModule.db;
    tables = schemaModule;
    issueEmailToken = tokenModule.issueEmailToken;
    consumeEmailToken = tokenModule.consumeEmailToken;

    const [user] = await db.insert(tables.users).values({
      email: `verify-test-${Date.now()}@test.local`,
      passwordHash: 'secret-hash',
      birthDate: '1990-01-01',
      sex: 'm',
    }).returning();
    userId = user.id;
  });

  afterAll(async () => {
    if (userId) await db.delete(tables.users).where(eq(tables.users.id, userId));
  });

  it('issues a token that can be consumed exactly once', async () => {
    const token = await issueEmailToken(userId, 'verify_email');

    const first = await consumeEmailToken(token, 'verify_email');
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.userId).toBe(userId);

    const second = await consumeEmailToken(token, 'verify_email');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('used');
  });

  it('rejects an unknown token', async () => {
    const result = await consumeEmailToken('does-not-exist', 'verify_email');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('rejects a token consumed under the wrong purpose', async () => {
    const token = await issueEmailToken(userId, 'verify_email');
    const result = await consumeEmailToken(token, 'reset_password');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('rejects an expired token', async () => {
    const token = await issueEmailToken(userId, 'verify_email');
    await db.update(tables.emailTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(tables.emailTokens.id, token));

    const result = await consumeEmailToken(token, 'verify_email');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });
});
