process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const HAS_DB = !!process.env.DATABASE_URL;

function extractCookieHeader(setCookie: string | string[] | undefined): string {
  const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie as string];
  return cookieArray.map((c) => c.split(';')[0]).join('; ');
}

function extractCsrfToken(setCookie: string | string[] | undefined): string {
  const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie as string];
  const xsrfCookie = cookieArray.find((c) => c.startsWith('XSRF-TOKEN='));
  return xsrfCookie ? xsrfCookie.split(';')[0].replace('XSRF-TOKEN=', '') : '';
}

// Issue #84: a partner offer belonging to an organization must not be visible
// to, qualifiable by, or claimable by users who are not verified members of
// that organization — previously every offer from every organization was
// shown to every user regardless of membership.
describe.skipIf(!HAS_DB)('Issue #84: members-only partner offers', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;

  let orgId: string;
  let membersOnlyOfferId: string;
  let publicOfferId: string;
  let noOrgOfferId: string;

  let memberUserId: string;
  let memberCookie: string;
  let memberCsrfToken: string;

  let outsiderUserId: string;
  let outsiderCookie: string;
  let outsiderCsrfToken: string;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    app = await buildApp();

    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const [org] = await db.insert(tables.organizations).values({
      name: 'Members-Only Testkasse',
      contactEmail: 'members-only@testkasse.de',
      joinCode: `members-only-${Date.now()}`,
    }).returning();
    orgId = org.id;

    const [membersOnlyOffer] = await db.insert(tables.partnerOffers).values({
      organizationId: orgId,
      partnerName: 'Members-Only Testkasse',
      title: 'Exklusiver Mitgliederbonus',
      description: 'Nur fuer Mitglieder',
      minBand: 0,
      minMonths: 0,
      valueLabel: '20€ Bonus',
      isDemo: false,
      membersOnly: true,
    }).returning();
    membersOnlyOfferId = membersOnlyOffer.id;

    const [publicOffer] = await db.insert(tables.partnerOffers).values({
      organizationId: orgId,
      partnerName: 'Members-Only Testkasse',
      title: 'Öffentliche Werbeaktion',
      description: 'Fuer alle sichtbar',
      minBand: 0,
      minMonths: 0,
      valueLabel: '5€ Gutschein',
      isDemo: false,
      membersOnly: false,
    }).returning();
    publicOfferId = publicOffer.id;

    const [noOrgOffer] = await db.insert(tables.partnerOffers).values({
      organizationId: null,
      partnerName: 'Demo Partner',
      title: 'Demo-Angebot ohne Organisation',
      description: 'Kein Members-Only anwendbar',
      minBand: 0,
      minMonths: 0,
      valueLabel: 'Demo',
      isDemo: true,
    }).returning();
    noOrgOfferId = noOrgOffer.id;

    const memberEmail = `member-${Date.now()}@test.local`;
    const memberReg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: memberEmail, password: 'MemberTest-2026', birthDate: '1990-01-01', sex: 'm' },
    });
    expect(memberReg.statusCode).toBe(201);
    memberCookie = extractCookieHeader(memberReg.headers['set-cookie']);
    memberCsrfToken = extractCsrfToken(memberReg.headers['set-cookie']);
    const [memberUser] = await db.select().from(tables.users).where(eq(tables.users.email, memberEmail));
    memberUserId = memberUser.id;
    await db.update(tables.users)
      .set({ organizationId: orgId, organizationVerifiedAt: new Date() })
      .where(eq(tables.users.id, memberUserId));

    const outsiderEmail = `outsider-${Date.now()}@test.local`;
    const outsiderReg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: outsiderEmail, password: 'OutsiderTest-2026', birthDate: '1990-01-01', sex: 'm' },
    });
    expect(outsiderReg.statusCode).toBe(201);
    outsiderCookie = extractCookieHeader(outsiderReg.headers['set-cookie']);
    outsiderCsrfToken = extractCsrfToken(outsiderReg.headers['set-cookie']);
    const [outsiderUser] = await db.select().from(tables.users).where(eq(tables.users.email, outsiderEmail));
    outsiderUserId = outsiderUser.id;
  });

  afterAll(async () => {
    if (outsiderUserId) {
      await db.delete(tables.benefitClaims).where(eq(tables.benefitClaims.userId, outsiderUserId));
      await db.delete(tables.users).where(eq(tables.users.id, outsiderUserId));
    }
    if (memberUserId) {
      await db.delete(tables.benefitClaims).where(eq(tables.benefitClaims.userId, memberUserId));
      await db.delete(tables.shareTokens).where(eq(tables.shareTokens.userId, memberUserId));
      await db.delete(tables.users).where(eq(tables.users.id, memberUserId));
    }
    if (membersOnlyOfferId) await db.delete(tables.partnerOffers).where(eq(tables.partnerOffers.id, membersOnlyOfferId));
    if (publicOfferId) await db.delete(tables.partnerOffers).where(eq(tables.partnerOffers.id, publicOfferId));
    if (noOrgOfferId) await db.delete(tables.partnerOffers).where(eq(tables.partnerOffers.id, noOrgOfferId));
    if (orgId) await db.delete(tables.organizations).where(eq(tables.organizations.id, orgId));
    await app.close();
  });

  it('hides a members-only offer entirely from a non-member', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/offers',
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.find((o: { id: string }) => o.id === membersOnlyOfferId)).toBeUndefined();
  });

  it('shows a members-only offer to a verified member of the organization', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/offers',
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const offer = body.find((o: { id: string }) => o.id === membersOnlyOfferId);
    expect(offer).toBeDefined();
    expect(offer.qualified).toBe(true);
  });

  it('shows a non-members-only offer to everyone regardless of membership', async () => {
    const memberRes = await app.inject({ method: 'GET', url: '/api/offers', headers: { cookie: memberCookie } });
    const outsiderRes = await app.inject({ method: 'GET', url: '/api/offers', headers: { cookie: outsiderCookie } });
    const memberBody = JSON.parse(memberRes.payload);
    const outsiderBody = JSON.parse(outsiderRes.payload);
    expect(memberBody.find((o: { id: string }) => o.id === publicOfferId)).toBeDefined();
    expect(outsiderBody.find((o: { id: string }) => o.id === publicOfferId)).toBeDefined();
  });

  it('always shows an organization-less offer regardless of the membersOnly default', async () => {
    const outsiderRes = await app.inject({ method: 'GET', url: '/api/offers', headers: { cookie: outsiderCookie } });
    const outsiderBody = JSON.parse(outsiderRes.payload);
    expect(outsiderBody.find((o: { id: string }) => o.id === noOrgOfferId)).toBeDefined();
  });

  it('rejects a non-member submitting a members-only offer with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/offers/${membersOnlyOfferId}/claim`,
      headers: { cookie: outsiderCookie, 'x-csrf-token': outsiderCsrfToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows a verified member to submit the members-only offer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/offers/${membersOnlyOfferId}/claim`,
      headers: { cookie: memberCookie, 'x-csrf-token': memberCsrfToken },
    });
    expect(res.statusCode).toBe(201);
  });
});
