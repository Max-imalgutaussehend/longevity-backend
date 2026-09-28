process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
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

// Issue #87: users can submit a qualified partner offer directly to the
// issuing insurer instead of only sharing a link, and the insurer can review
// and decide (accept/reject) the submission.
describe.skipIf(!HAS_DB)('Issue #87: direct benefit claim submission', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;

  let orgId: string;
  let otherOrgId: string;
  let offerId: string;
  let noOrgOfferId: string;

  let insurerUserId: string;
  let insurerCookie: string;
  let insurerCsrfToken: string;
  let otherInsurerUserId: string;
  let otherInsurerCookie: string;
  let otherInsurerCsrfToken: string;

  let b2cUserId: string;
  let b2cCookie: string;
  let b2cCsrfToken: string;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    app = await buildApp();

    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const [org] = await db.insert(tables.organizations).values({
      name: 'Testkasse Claims GmbH',
      contactEmail: 'claims-test@testkasse.de',
      joinCode: `claims-test-${Date.now()}`,
    }).returning();
    orgId = org.id;

    const [otherOrg] = await db.insert(tables.organizations).values({
      name: 'Andere Testkasse GmbH',
      contactEmail: 'other-claims-test@testkasse.de',
      joinCode: `other-claims-test-${Date.now()}`,
    }).returning();
    otherOrgId = otherOrg.id;

    const [offer] = await db.insert(tables.partnerOffers).values({
      organizationId: orgId,
      partnerName: 'Testkasse Claims GmbH',
      title: 'Fitness-Bonus',
      description: 'Direkt einreichbares Angebot',
      minBand: 0,
      minMonths: 0,
      valueLabel: '50€ Bonus',
      isDemo: false,
    }).returning();
    offerId = offer.id;

    const [noOrgOffer] = await db.insert(tables.partnerOffers).values({
      organizationId: null,
      partnerName: 'Demo Partner',
      title: 'Demo-Angebot ohne Organisation',
      description: 'Nur Link-Sharing',
      minBand: 0,
      minMonths: 0,
      valueLabel: 'Demo',
      isDemo: true,
    }).returning();
    noOrgOfferId = noOrgOffer.id;

    const insurerPasswordHash = await hash('insurer-claims-test-2026');
    const [insurer] = await db.insert(tables.users).values({
      email: `insurer-claims-test-${Date.now()}@test.local`,
      passwordHash: insurerPasswordHash,
      birthDate: '1980-01-01',
      sex: 'f',
      role: 'insurer_admin',
      organizationId: orgId,
    }).returning();
    insurerUserId = insurer.id;
    const insurerLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: insurer.email, password: 'insurer-claims-test-2026' },
    });
    expect(insurerLogin.statusCode).toBe(200);
    insurerCookie = extractCookieHeader(insurerLogin.headers['set-cookie']);
    insurerCsrfToken = extractCsrfToken(insurerLogin.headers['set-cookie']);

    const [otherInsurer] = await db.insert(tables.users).values({
      email: `other-insurer-claims-test-${Date.now()}@test.local`,
      passwordHash: insurerPasswordHash,
      birthDate: '1980-01-01',
      sex: 'f',
      role: 'insurer_admin',
      organizationId: otherOrgId,
    }).returning();
    otherInsurerUserId = otherInsurer.id;
    const otherInsurerLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: otherInsurer.email, password: 'insurer-claims-test-2026' },
    });
    expect(otherInsurerLogin.statusCode).toBe(200);
    otherInsurerCookie = extractCookieHeader(otherInsurerLogin.headers['set-cookie']);
    otherInsurerCsrfToken = extractCsrfToken(otherInsurerLogin.headers['set-cookie']);

    const b2cEmail = `b2c-claims-test-${Date.now()}@test.local`;
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: b2cEmail, password: 'B2cClaimsTest-2026', birthDate: '1990-01-01', sex: 'm' },
    });
    expect(regRes.statusCode).toBe(201);
    b2cCookie = extractCookieHeader(regRes.headers['set-cookie']);
    b2cCsrfToken = extractCsrfToken(regRes.headers['set-cookie']);
    const [b2cUser] = await db.select().from(tables.users).where(eq(tables.users.email, b2cEmail));
    b2cUserId = b2cUser.id;
  });

  afterAll(async () => {
    if (b2cUserId) {
      await db.delete(tables.benefitClaims).where(eq(tables.benefitClaims.userId, b2cUserId));
      await db.delete(tables.shareTokens).where(eq(tables.shareTokens.userId, b2cUserId));
      await db.delete(tables.users).where(eq(tables.users.id, b2cUserId));
    }
    if (insurerUserId) await db.delete(tables.users).where(eq(tables.users.id, insurerUserId));
    if (otherInsurerUserId) await db.delete(tables.users).where(eq(tables.users.id, otherInsurerUserId));
    if (noOrgOfferId) await db.delete(tables.partnerOffers).where(eq(tables.partnerOffers.id, noOrgOfferId));
    if (offerId) await db.delete(tables.partnerOffers).where(eq(tables.partnerOffers.id, offerId));
    if (orgId) await db.delete(tables.organizations).where(eq(tables.organizations.id, orgId));
    if (otherOrgId) await db.delete(tables.organizations).where(eq(tables.organizations.id, otherOrgId));
    await app.close();
  });

  it('rejects submission for an offer without an organization', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/offers/${noOrgOfferId}/claim`,
      headers: { cookie: b2cCookie, 'x-csrf-token': b2cCsrfToken },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication to submit a claim', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/offers/${offerId}/claim`,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  let claimId: string;

  it('submits a qualified claim and returns 201 with submitted status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/offers/${offerId}/claim`,
      headers: { cookie: b2cCookie, 'x-csrf-token': b2cCsrfToken },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('submitted');
    expect(body.id).toBeDefined();
    claimId = body.id;

    const [claim] = await db.select().from(tables.benefitClaims).where(eq(tables.benefitClaims.id, claimId));
    expect(claim.organizationId).toBe(orgId);
    expect(claim.userId).toBe(b2cUserId);

    const [token] = await db.select().from(tables.shareTokens).where(eq(tables.shareTokens.id, claim.shareTokenId));
    expect(token).toBeDefined();
  });

  it('rejects a duplicate submission for the same offer while one is pending', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/offers/${offerId}/claim`,
      headers: { cookie: b2cCookie, 'x-csrf-token': b2cCsrfToken },
    });
    expect(res.statusCode).toBe(409);
  });

  it('reflects claim status on the offers listing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/offers',
      headers: { cookie: b2cCookie, 'x-csrf-token': b2cCsrfToken },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const offer = body.find((o: { id: string }) => o.id === offerId);
    expect(offer.claimStatus).toBe('submitted');
    expect(offer.claimSubmittedAt).toBeDefined();
  });

  it('does not show claims from another organization in the insurer claims list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/insurer/claims',
      headers: { cookie: otherInsurerCookie, 'x-csrf-token': otherInsurerCsrfToken },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.find((c: { id: string }) => c.id === claimId)).toBeUndefined();
  });

  it('lets the owning insurer see the submitted claim', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/insurer/claims',
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const claim = body.find((c: { id: string }) => c.id === claimId);
    expect(claim).toBeDefined();
    expect(claim.status).toBe('submitted');
    expect(claim.offerTitle).toBe('Fitness-Bonus');
  });

  it('prevents another organization from deciding on the claim', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/insurer/claims/${claimId}/decide`,
      headers: { cookie: otherInsurerCookie, 'x-csrf-token': otherInsurerCsrfToken },
      payload: { decision: 'accepted' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lets the owning insurer accept the claim', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/insurer/claims/${claimId}/decide`,
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: { decision: 'accepted' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('accepted');
    expect(body.decidedAt).toBeDefined();
  });

  it('rejects deciding twice on the same claim', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/insurer/claims/${claimId}/decide`,
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: { decision: 'rejected' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('still blocks resubmission while the claim is accepted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/offers/${offerId}/claim`,
      headers: { cookie: b2cCookie, 'x-csrf-token': b2cCsrfToken },
    });
    expect(res.statusCode).toBe(409);
  });

  it('allows resubmission after a claim is rejected', async () => {
    await db.update(tables.benefitClaims).set({ status: 'rejected' }).where(eq(tables.benefitClaims.id, claimId));

    const res = await app.inject({
      method: 'POST',
      url: `/api/offers/${offerId}/claim`,
      headers: { cookie: b2cCookie, 'x-csrf-token': b2cCsrfToken },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.id).not.toBe(claimId);
  });
});
