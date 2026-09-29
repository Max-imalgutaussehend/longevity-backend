process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

// Victor's PR review on #92 flagged that benefitClaims.shareTokenId was
// `onDelete: 'restrict'` and benefitClaims.decidedBy had no onDelete at all.
// benefitClaims.userId already cascades from users, so account deletion itself
// did not actually hit the restrict constraint in practice (Postgres resolves
// the multi-path cascade before the restrict check fires) — but a `restrict`
// on shareTokenId would still leave a dangling/undeletable share_token behind
// if a claim ever needs to be deleted independently of its user, and
// `decided_by` with no onDelete would block deleting a staff member's own
// account once they've ever decided a claim. Both are fixed regardless
// (shareTokenId -> cascade, decidedBy -> set null); this test locks in that a
// user with an active claim, and separately an insurer staff member who
// decided one, can both be deleted cleanly.
describe('Account deletion with an existing benefit claim (#92 PR-review follow-up)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  let orgId: string | undefined;
  let userId: string | undefined;
  let decidingStaffId: string | undefined;

  afterAll(async () => {
    if (userId) await db.delete(tables.users).where(eq(tables.users.id, userId));
    if (decidingStaffId) await db.delete(tables.users).where(eq(tables.users.id, decidingStaffId));
    if (orgId) await db.delete(tables.organizations).where(eq(tables.organizations.id, orgId));
  });

  it('deletes the user (and cascades the share token + benefit claim) without a foreign key violation', async () => {
    const dbClient = await import('../db/client.js');
    const schema = await import('../db/schema.js');
    const { hashPassword } = await import('../lib/password.js');
    db = dbClient.db;
    tables = schema;

    const [org] = await db.insert(tables.organizations).values({
      name: `FK-Test-Kasse-${Date.now()}`,
      contactEmail: `fk-test-${Date.now()}@testkasse.de`,
      status: 'active',
      joinCode: `fk-test-${Date.now()}`,
    }).returning();
    orgId = org.id;

    const pwHash = await hashPassword('SecureTestPassword123!');
    const [user] = await db.insert(tables.users).values({
      id: randomUUID(),
      email: `fk-delete-test-${Date.now()}@example.com`,
      passwordHash: pwHash,
      birthDate: '1990-01-01',
      sex: 'm',
    }).returning();
    userId = user.id;

    const [staff] = await db.insert(tables.users).values({
      id: randomUUID(),
      email: `fk-delete-staff-${Date.now()}@example.com`,
      passwordHash: pwHash,
      birthDate: '1985-01-01',
      sex: 'f',
      role: 'insurer_staff',
      organizationId: org.id,
    }).returning();
    decidingStaffId = staff.id;

    const [offer] = await db.insert(tables.partnerOffers).values({
      organizationId: org.id,
      partnerName: 'Test Partner',
      title: 'Test Offer',
      description: 'Test',
      minBand: 70,
      valueLabel: '10 EUR',
    }).returning();

    const tokenId = randomUUID();
    await db.insert(tables.shareTokens).values({
      id: tokenId,
      userId: user.id,
      bandLow: 70,
      bandHigh: 79,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      signature: 'test-signature',
    });

    const [claim] = await db.insert(tables.benefitClaims).values({
      userId: user.id,
      offerId: offer.id,
      organizationId: org.id,
      shareTokenId: tokenId,
      bandLow: 70,
      bandHigh: 79,
      status: 'accepted',
      decidedAt: new Date(),
      decidedBy: staff.id,
    }).returning();

    // This is the exact operation account deletion performs — deleting the
    // user row and letting FK cascades take care of everything downstream.
    await expect(db.delete(tables.users).where(eq(tables.users.id, user.id))).resolves.not.toThrow();

    const [goneUser] = await db.select().from(tables.users).where(eq(tables.users.id, user.id)).limit(1);
    expect(goneUser).toBeUndefined();

    const [goneToken] = await db.select().from(tables.shareTokens).where(eq(tables.shareTokens.id, tokenId)).limit(1);
    expect(goneToken).toBeUndefined();

    const [goneClaim] = await db.select().from(tables.benefitClaims).where(eq(tables.benefitClaims.id, claim.id)).limit(1);
    expect(goneClaim).toBeUndefined();
    userId = undefined; // already deleted above

    // Directly test the decidedBy fix: create a second user + claim decided by
    // the staff member, then delete the staff member's own account. Must not
    // be blocked by the claim still referencing them as decider (set null).
    const [secondUser] = await db.insert(tables.users).values({
      id: randomUUID(),
      email: `fk-delete-second-${Date.now()}@example.com`,
      passwordHash: pwHash,
      birthDate: '1991-01-01',
      sex: 'f',
    }).returning();

    const secondTokenId = randomUUID();
    await db.insert(tables.shareTokens).values({
      id: secondTokenId,
      userId: secondUser.id,
      bandLow: 70,
      bandHigh: 79,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      signature: 'test-signature-2',
    });

    await db.insert(tables.benefitClaims).values({
      userId: secondUser.id,
      offerId: offer.id,
      organizationId: org.id,
      shareTokenId: secondTokenId,
      bandLow: 70,
      bandHigh: 79,
      status: 'accepted',
      decidedAt: new Date(),
      decidedBy: staff.id,
    });

    await expect(db.delete(tables.users).where(eq(tables.users.id, staff.id))).resolves.not.toThrow();
    decidingStaffId = undefined;

    const [claimAfterStaffDeleted] = await db.select().from(tables.benefitClaims)
      .where(eq(tables.benefitClaims.userId, secondUser.id)).limit(1);
    expect(claimAfterStaffDeleted.decidedBy).toBeNull();

    await db.delete(tables.users).where(eq(tables.users.id, secondUser.id));
  });
});
