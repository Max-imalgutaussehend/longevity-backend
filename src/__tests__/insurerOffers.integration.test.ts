import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Insurer partner offers scoping — integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  let orgAId: string;
  let orgBId: string;
  let offerAId: string;

  beforeAll(async () => {
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const [orgA] = await db.insert(tables.organizations).values({
      name: 'Offers Org A', contactEmail: 'a@offers.test', status: 'active', joinCode: `offers-a-${Date.now()}`,
    }).returning();
    orgAId = orgA.id;

    const [orgB] = await db.insert(tables.organizations).values({
      name: 'Offers Org B', contactEmail: 'b@offers.test', status: 'active', joinCode: `offers-b-${Date.now()}`,
    }).returning();
    orgBId = orgB.id;

    const [offerA] = await db.insert(tables.partnerOffers).values({
      organizationId: orgAId, partnerName: 'Offers Org A',
      title: 'Bonus A', description: 'Test-Angebot A', minBand: 60, valueLabel: '10% Rabatt', isDemo: false,
    }).returning();
    offerAId = offerA.id;
  });

  afterAll(async () => {
    await db.delete(tables.partnerOffers).where(eq(tables.partnerOffers.organizationId, orgAId));
    await db.delete(tables.partnerOffers).where(eq(tables.partnerOffers.organizationId, orgBId));
    await db.delete(tables.organizations).where(eq(tables.organizations.id, orgAId));
    await db.delete(tables.organizations).where(eq(tables.organizations.id, orgBId));
  });

  it('scopes offer listing to the owning organization', async () => {
    const orgAOffers = await db.select().from(tables.partnerOffers).where(eq(tables.partnerOffers.organizationId, orgAId));
    const orgBOffers = await db.select().from(tables.partnerOffers).where(eq(tables.partnerOffers.organizationId, orgBId));
    expect(orgAOffers).toHaveLength(1);
    expect(orgBOffers).toHaveLength(0);
  });

  it('prevents updating an offer that belongs to a different organization', async () => {
    const wrongOrgUpdate = await db.update(tables.partnerOffers)
      .set({ title: 'Hijacked' })
      .where(and(eq(tables.partnerOffers.id, offerAId), eq(tables.partnerOffers.organizationId, orgBId)))
      .returning();
    expect(wrongOrgUpdate).toHaveLength(0);

    const [unchanged] = await db.select().from(tables.partnerOffers).where(eq(tables.partnerOffers.id, offerAId));
    expect(unchanged.title).toBe('Bonus A');
  });

  it('prevents deleting an offer that belongs to a different organization', async () => {
    const deleted = await db.delete(tables.partnerOffers)
      .where(and(eq(tables.partnerOffers.id, offerAId), eq(tables.partnerOffers.organizationId, orgBId)))
      .returning();
    expect(deleted).toHaveLength(0);

    const [stillThere] = await db.select().from(tables.partnerOffers).where(eq(tables.partnerOffers.id, offerAId));
    expect(stillThere).toBeDefined();
  });

  it('deletes the organization\'s own offers when the organization is deleted', async () => {
    const [tempOrg] = await db.insert(tables.organizations).values({
      name: 'Temp Offers Org', contactEmail: 'temp@offers.test', status: 'active', joinCode: `offers-temp-${Date.now()}`,
    }).returning();

    const [tempOffer] = await db.insert(tables.partnerOffers).values({
      organizationId: tempOrg.id, partnerName: 'Temp Offers Org',
      title: 'Temp Bonus', description: 'Wird gelöscht', minBand: 50, valueLabel: 'Test', isDemo: false,
    }).returning();

    await db.delete(tables.organizations).where(eq(tables.organizations.id, tempOrg.id));

    const remaining = await db.select().from(tables.partnerOffers).where(eq(tables.partnerOffers.id, tempOffer.id));
    expect(remaining).toHaveLength(0);
  });

  it('excludes offers outside their validity window from the public listing filter', () => {
    const now = new Date('2026-09-15T12:00:00Z');
    const expired = { validFrom: null, validUntil: new Date('2026-09-01T00:00:00Z') };
    const future = { validFrom: new Date('2026-10-01T00:00:00Z'), validUntil: null };
    const active = { validFrom: new Date('2026-09-01T00:00:00Z'), validUntil: new Date('2026-10-01T00:00:00Z') };
    const always = { validFrom: null, validUntil: null };

    const isVisible = (o: { validFrom: Date | null; validUntil: Date | null }) =>
      (!o.validFrom || o.validFrom <= now) && (!o.validUntil || o.validUntil >= now);

    expect(isVisible(expired)).toBe(false);
    expect(isVisible(future)).toBe(false);
    expect(isVisible(active)).toBe(true);
    expect(isVisible(always)).toBe(true);
  });
});
