import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, desc, and, sql } from 'drizzle-orm';
import { CURRENT_HEALTH_DATA_CONSENT_VERSION, HEALTH_DATA_CONSENT_TEXT } from '../lib/consent.js';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('GDPR Art. 9 Health Data Consent — integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  let testUserId: string;

  beforeAll(async () => {
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const [user] = await db.insert(tables.users).values({
      email: `consent-test-${Date.now()}@test.local`,
      passwordHash: 'secret-hash',
      birthDate: '1992-05-15',
      sex: 'm',
      displayName: 'Consent Test User',
    }).returning();
    testUserId = user.id;
  });

  afterAll(async () => {
    if (testUserId) {
      await db.delete(tables.users).where(eq(tables.users.id, testUserId));
    }
  });

  it('provides official consent constants for Art. 9 DSGVO', () => {
    expect(CURRENT_HEALTH_DATA_CONSENT_VERSION).toBe('2026-09-v1');
    expect(HEALTH_DATA_CONSENT_TEXT).toContain('Art. 9 Abs. 2 lit. a DSGVO');
    expect(HEALTH_DATA_CONSENT_TEXT).toContain('Freiwilligkeit und Widerrufsrecht');
    expect(HEALTH_DATA_CONSENT_TEXT).toContain('/datenschutz');
  });

  it('starts with hasConsented = false and null consent fields', async () => {
    const [user] = await db.select().from(tables.users).where(eq(tables.users.id, testUserId));
    expect(user.healthDataConsentAt).toBeNull();
    expect(user.healthDataConsentVersion).toBeNull();

    const consents = await db.select().from(tables.healthDataConsents).where(eq(tables.healthDataConsents.userId, testUserId));
    expect(consents).toHaveLength(0);
  });

  it('records consent on user and inserts audit log row with timestamp & version', async () => {
    const now = new Date();
    const version = CURRENT_HEALTH_DATA_CONSENT_VERSION;

    await db.transaction(async (tx: typeof db) => {
      await tx.update(tables.users).set({
        healthDataConsentAt: now,
        healthDataConsentVersion: version,
      }).where(eq(tables.users.id, testUserId));

      await tx.insert(tables.healthDataConsents).values({
        userId: testUserId,
        version,
        grantedAt: now,
        ipAddress: '127.0.0.1',
        userAgent: 'Vitest/Test-Agent',
      });
    });

    const [user] = await db.select().from(tables.users).where(eq(tables.users.id, testUserId));
    expect(user.healthDataConsentAt).toBeTruthy();
    expect(user.healthDataConsentVersion).toBe('2026-09-v1');

    const consents = await db.select().from(tables.healthDataConsents).where(eq(tables.healthDataConsents.userId, testUserId));
    expect(consents).toHaveLength(1);
    expect(consents[0].version).toBe('2026-09-v1');
    expect(consents[0].revokedAt).toBeNull();
    expect(consents[0].ipAddress).toBe('127.0.0.1');
  });

  it('revokes consent by clearing user fields and stamping revokedAt in audit row', async () => {
    const revokeTime = new Date();

    await db.transaction(async (tx: typeof db) => {
      await tx.update(tables.users).set({
        healthDataConsentAt: null,
        healthDataConsentVersion: null,
      }).where(eq(tables.users.id, testUserId));

      await tx.update(tables.healthDataConsents).set({
        revokedAt: revokeTime,
      }).where(and(
        eq(tables.healthDataConsents.userId, testUserId),
        sql`revoked_at IS NULL`
      ));
    });

    const [user] = await db.select().from(tables.users).where(eq(tables.users.id, testUserId));
    expect(user.healthDataConsentAt).toBeNull();
    expect(user.healthDataConsentVersion).toBeNull();

    const [consent] = await db.select().from(tables.healthDataConsents)
      .where(eq(tables.healthDataConsents.userId, testUserId))
      .orderBy(desc(tables.healthDataConsents.grantedAt));
    expect(consent.revokedAt).toBeTruthy();
  });
});
