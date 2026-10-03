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

describe.skipIf(!HAS_DB)('Issue #130: End-to-End Flow für Krankenkassen-Vorteile & Prämien-Einlösung', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;

  let orgId: string;
  let insurerUserId: string;
  let insurerCookie: string;
  let insurerCsrfToken: string;

  let memberUserId: string;
  let memberCookie: string;
  let memberCsrfToken: string;

  let outsiderUserId: string;
  let outsiderCookie: string;
  let outsiderCsrfToken: string;

  let payoutOfferId: string;
  let publicPayoutOfferId: string;
  let voucherOfferId: string;
  let certOfferId: string;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    app = await buildApp();

    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const [org] = await db.insert(tables.organizations).values({
      name: 'TK Partnerkasse Demo',
      contactEmail: 'partnerkasse@demo.de',
      joinCode: `tk-demo-${Date.now()}`,
    }).returning();
    orgId = org.id;

    const insurerPasswordHash = await hash('Insurer-Pass-2026!');
    const [insurer] = await db.insert(tables.users).values({
      email: `insurer-130-${Date.now()}@test.local`,
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
      payload: { email: insurer.email, password: 'Insurer-Pass-2026!' },
    });
    expect(insurerLogin.statusCode).toBe(200);
    insurerCookie = extractCookieHeader(insurerLogin.headers['set-cookie']);
    insurerCsrfToken = extractCsrfToken(insurerLogin.headers['set-cookie']);

    // Member user (linked to orgId)
    const memberEmail = `member-130-${Date.now()}@test.local`;
    const memberReg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: memberEmail, password: 'MemberPass-2026!', birthDate: '1992-05-15', sex: 'm' },
    });
    expect(memberReg.statusCode).toBe(201);
    memberCookie = extractCookieHeader(memberReg.headers['set-cookie']);
    memberCsrfToken = extractCsrfToken(memberReg.headers['set-cookie']);
    const [memberUser] = await db.select().from(tables.users).where(eq(tables.users.email, memberEmail));
    memberUserId = memberUser.id;
    await db.update(tables.users)
      .set({ organizationId: orgId, organizationVerifiedAt: new Date(), displayName: 'Max Mustermann' })
      .where(eq(tables.users.id, memberUserId));

    // Outsider user (not linked to orgId)
    const outsiderEmail = `outsider-130-${Date.now()}@test.local`;
    const outsiderReg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: outsiderEmail, password: 'OutsiderPass-2026!', birthDate: '1995-10-20', sex: 'f' },
    });
    expect(outsiderReg.statusCode).toBe(201);
    outsiderCookie = extractCookieHeader(outsiderReg.headers['set-cookie']);
    outsiderCsrfToken = extractCsrfToken(outsiderReg.headers['set-cookie']);
    const [outsiderUser] = await db.select().from(tables.users).where(eq(tables.users.email, outsiderEmail));
    outsiderUserId = outsiderUser.id;
    await db.update(tables.users)
      .set({ displayName: 'Erika Musterfrau' })
      .where(eq(tables.users.id, outsiderUserId));
  });

  afterAll(async () => {
    if (memberUserId) {
      await db.delete(tables.benefitClaims).where(eq(tables.benefitClaims.userId, memberUserId));
      await db.delete(tables.shareTokens).where(eq(tables.shareTokens.userId, memberUserId));
      await db.delete(tables.users).where(eq(tables.users.id, memberUserId));
    }
    if (outsiderUserId) {
      await db.delete(tables.benefitClaims).where(eq(tables.benefitClaims.userId, outsiderUserId));
      await db.delete(tables.shareTokens).where(eq(tables.shareTokens.userId, outsiderUserId));
      await db.delete(tables.users).where(eq(tables.users.id, outsiderUserId));
    }
    if (insurerUserId) await db.delete(tables.users).where(eq(tables.users.id, insurerUserId));
    if (payoutOfferId) await db.delete(tables.partnerOffers).where(eq(tables.partnerOffers.id, payoutOfferId));
    if (publicPayoutOfferId) await db.delete(tables.partnerOffers).where(eq(tables.partnerOffers.id, publicPayoutOfferId));
    if (voucherOfferId) await db.delete(tables.partnerOffers).where(eq(tables.partnerOffers.id, voucherOfferId));
    if (certOfferId) await db.delete(tables.partnerOffers).where(eq(tables.partnerOffers.id, certOfferId));
    if (orgId) await db.delete(tables.organizations).where(eq(tables.organizations.id, orgId));
    await app.close();
  });

  it('allows insurer to create offers with specific benefitType, voucherCode, and membersOnly options', async () => {
    // 1. Members-only cash payout offer
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/insurer/offers',
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: {
        title: '100 € Gesundheitsbonus für Mitglieder',
        description: 'Exklusiv für unsere Mitglieder ab Band 50',
        minBand: 50,
        minMonths: 0,
        valueLabel: '100 € Bonus',
        membersOnly: true,
        benefitType: 'payout',
      },
    });
    expect(res1.statusCode).toBe(201);
    const body1 = JSON.parse(res1.payload);
    expect(body1.benefitType).toBe('payout');
    expect(body1.membersOnly).toBe(true);
    payoutOfferId = body1.id;

    // 2. Public cash payout offer ("Alle Mitglieder / Alle Nutzer")
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/insurer/offers',
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: {
        title: '50 € Willkommensprämie für alle',
        description: 'Offen für alle Versicherten',
        minBand: 0,
        minMonths: 0,
        valueLabel: '50 € Prämie',
        membersOnly: false,
        benefitType: 'payout',
      },
    });
    expect(res2.statusCode).toBe(201);
    const body2 = JSON.parse(res2.payload);
    expect(body2.membersOnly).toBe(false);
    publicPayoutOfferId = body2.id;

    // 3. Voucher offer with custom promo code
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/insurer/offers',
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: {
        title: 'Sport-Gutschein 20 €',
        description: 'Sofort einlösbar im Partnershop',
        minBand: 0,
        minMonths: 0,
        valueLabel: '20 € Gutschein',
        membersOnly: false,
        benefitType: 'voucher',
        voucherCode: 'TK-SPORT-2026',
        partnerUrl: 'https://shop.partner.de',
      },
    });
    expect(res3.statusCode).toBe(201);
    const body3 = JSON.parse(res3.payload);
    expect(body3.benefitType).toBe('voucher');
    expect(body3.voucherCode).toBe('TK-SPORT-2026');
    voucherOfferId = body3.id;

    // 4. Certificate offer (§ 65a SGB V)
    const res4 = await app.inject({
      method: 'POST',
      url: '/api/insurer/offers',
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: {
        title: 'Kassen-Zertifikat § 65a SGB V',
        description: 'Zur Vorlage bei jeder gesetzlichen Kasse',
        minBand: 0,
        minMonths: 0,
        valueLabel: 'Offizieller Nachweis',
        membersOnly: false,
        benefitType: 'certificate',
      },
    });
    expect(res4.statusCode).toBe(201);
    const body4 = JSON.parse(res4.payload);
    expect(body4.benefitType).toBe('certificate');
    certOfferId = body4.id;
  });

  it('shows the public offer to a non-member outsider in /offers with benefitType metadata', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/offers',
      headers: { cookie: outsiderCookie, 'x-csrf-token': outsiderCsrfToken },
    });
    expect(res.statusCode).toBe(200);
    const offers = JSON.parse(res.payload);
    const pub = offers.find((o: { id: string }) => o.id === publicPayoutOfferId);
    expect(pub).toBeDefined();
    expect(pub.benefitType).toBe('payout');
    expect(pub.membersOnly).toBe(false);

    // Members-only offer must NOT be visible to outsider
    const priv = offers.find((o: { id: string }) => o.id === payoutOfferId);
    expect(priv).toBeUndefined();
  });

  it('allows a non-member to claim a public payout offer with bank transfer (Girokonto IBAN)', async () => {
    // Attempting contribution_offset should fail for non-members
    const failRes = await app.inject({
      method: 'POST',
      url: `/api/offers/${publicPayoutOfferId}/claim`,
      headers: { cookie: outsiderCookie, 'x-csrf-token': outsiderCsrfToken },
      payload: {
        payoutMethod: 'contribution_offset',
      },
    });
    expect(failRes.statusCode).toBe(400);

    // Claiming with bank_transfer and valid IBAN succeeds directly
    const successRes = await app.inject({
      method: 'POST',
      url: `/api/offers/${publicPayoutOfferId}/claim`,
      headers: { cookie: outsiderCookie, 'x-csrf-token': outsiderCsrfToken },
      payload: {
        payoutMethod: 'bank_transfer',
        iban: 'DE89 3705 0198 0000 0123 45',
        accountHolder: 'Erika Musterfrau',
      },
    });
    expect(successRes.statusCode).toBe(201);
    const claim = JSON.parse(successRes.payload);
    expect(claim.status).toBe('submitted');
    expect(claim.payoutMethod).toBe('bank_transfer');
    expect(claim.payoutIbanMasked).toBe('DE89 •••• •••• •••• 2345');
  });

  it('allows a user to claim a voucher offer and immediately receive their promo code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/offers/${voucherOfferId}/claim`,
      headers: { cookie: memberCookie, 'x-csrf-token': memberCsrfToken },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const claim = JSON.parse(res.payload);
    expect(claim.status).toBe('accepted');
    expect(claim.payoutMethod).toBe('voucher');
    expect(claim.rewardPayload?.voucherCode).toBe('TK-SPORT-2026');
  });

  it('allows a member to claim their insurer offer with contribution_offset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/offers/${payoutOfferId}/claim`,
      headers: { cookie: memberCookie, 'x-csrf-token': memberCsrfToken },
      payload: {
        payoutMethod: 'contribution_offset',
      },
    });
    expect(res.statusCode).toBe(201);
    const claim = JSON.parse(res.payload);
    expect(claim.status).toBe('submitted');
    expect(claim.payoutMethod).toBe('contribution_offset');
  });

  let outsiderClaimId: string;

  it('displays claims in the insurer B2B portal with masked IBAN and payout details', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/insurer/claims',
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
    });
    expect(res.statusCode).toBe(200);
    const claims = JSON.parse(res.payload);
    const outsiderClaim = claims.find((c: { offerTitle: string }) => c.offerTitle === '50 € Willkommensprämie für alle');
    expect(outsiderClaim).toBeDefined();
    expect(outsiderClaim.payoutMethod).toBe('bank_transfer');
    expect(outsiderClaim.payoutIbanMasked).toBe('DE89 •••• •••• •••• 2345');
    expect(outsiderClaim.payoutAccountHolder).toBe('Erika Musterfrau');
    outsiderClaimId = outsiderClaim.id;
  });

  it('lets the insurer accept the claim with a transactionRef and payout note', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/insurer/claims/${outsiderClaimId}/decide`,
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: {
        decision: 'accepted',
        transactionRef: 'TK-2026-8812',
        note: 'Zur Überweisung am nächsten Zahltag vorgemerkt.',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('accepted');
    expect(body.rewardPayload?.transactionRef).toBe('TK-2026-8812');
    expect(body.rewardPayload?.note).toBe('Zur Überweisung am nächsten Zahltag vorgemerkt.');
  });

  it('lets the user view their claims under /me/claims with complete fulfillment info', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me/claims',
      headers: { cookie: outsiderCookie, 'x-csrf-token': outsiderCsrfToken },
    });
    expect(res.statusCode).toBe(200);
    const myClaims = JSON.parse(res.payload);
    expect(myClaims.length).toBeGreaterThanOrEqual(1);
    const c = myClaims.find((item: { id: string }) => item.id === outsiderClaimId);
    expect(c).toBeDefined();
    expect(c.status).toBe('accepted');
    expect(c.rewardPayload?.transactionRef).toBe('TK-2026-8812');
    expect(c.rewardPayload?.note).toBe('Zur Überweisung am nächsten Zahltag vorgemerkt.');
    expect(c.payoutIbanMasked).toBe('DE89 •••• •••• •••• 2345');
    expect(c.offer.title).toBe('50 € Willkommensprämie für alle');
  });

  it('generates an official payment receipt via /claims/:id/receipt', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/claims/${outsiderClaimId}/receipt`,
      headers: { cookie: outsiderCookie, 'x-csrf-token': outsiderCsrfToken },
    });
    expect(res.statusCode).toBe(200);
    const receipt = JSON.parse(res.payload);
    expect(receipt.receiptNumber).toMatch(/^REC-/);
    expect(receipt.status).toBe('accepted');
    expect(receipt.transactionRef).toBe('TK-2026-8812');
    expect(receipt.payoutIbanMasked).toBe('DE89 •••• •••• •••• 2345');
  });

  it('allows user to track self-submitted claims and set a 14-day reminder', async () => {
    // First claim certificate offer
    const certClaimRes = await app.inject({
      method: 'POST',
      url: `/api/offers/${certOfferId}/claim`,
      headers: { cookie: outsiderCookie, 'x-csrf-token': outsiderCsrfToken },
      payload: { payoutMethod: 'self_submitted' },
    });
    expect(certClaimRes.statusCode).toBe(201);
    const certClaim = JSON.parse(certClaimRes.payload);
    // Certificate is immediately issued and valid (status: accepted)
    expect(certClaim.status).toBe('accepted');

    // Attempting to decide on a self-submitted PDF certificate in insurer portal must be rejected (400)
    const decideRes = await app.inject({
      method: 'POST',
      url: `/api/insurer/claims/${certClaim.id}/decide`,
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: { decision: 'accepted' },
    });
    expect(decideRes.statusCode).toBe(400);

    // Update with 14-day reminder
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/me/claims/${certClaim.id}`,
      headers: { cookie: outsiderCookie, 'x-csrf-token': outsiderCsrfToken },
      payload: {
        selfSubmitted: true,
        reminderDays: 14,
      },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = JSON.parse(patchRes.payload);
    expect(patched.selfSubmittedAt).toBeDefined();
    expect(patched.reminderAt).toBeDefined();

    // Insurer can view the issued certificate and selfSubmittedAt in audit list
    const insurerListRes = await app.inject({
      method: 'GET',
      url: '/api/insurer/claims',
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
    });
    expect(insurerListRes.statusCode).toBe(200);
    const insurerClaims = JSON.parse(insurerListRes.payload);
    const foundCert = insurerClaims.find((c: { id: string }) => c.id === certClaim.id);
    expect(foundCert).toBeDefined();
    expect(foundCert.payoutMethod).toBe('self_submitted');
    expect(foundCert.selfSubmittedAt).toBeDefined();
  });

  it('allows mass import of voucher codes and atomic claiming from code pool', async () => {
    // 1. Create a code-pool voucher offer
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/insurer/offers',
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: {
        title: 'Gym-Monatsabo via Code-Pool',
        description: 'Exklusiver Zugang für fleißige Mitglieder',
        minBand: 0,
        minMonths: 0,
        valueLabel: '1 Monat gratis',
        membersOnly: false,
        benefitType: 'voucher',
        voucherDelivery: 'code_pool',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const poolOffer = JSON.parse(createRes.payload);

    // 2. Mass import codes
    const importRes = await app.inject({
      method: 'POST',
      url: `/api/insurer/offers/${poolOffer.id}/voucher-codes`,
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: {
        codes: ['POOL-CODE-AAA', 'POOL-CODE-BBB', 'POOL-CODE-CCC'],
      },
    });
    expect(importRes.statusCode).toBe(201);
    const importBody = JSON.parse(importRes.payload);
    expect(importBody.inserted).toBe(3);
    expect(importBody.availableCodesCount).toBe(3);

    // 3. Check pool stats
    const statsRes = await app.inject({
      method: 'GET',
      url: `/api/insurer/offers/${poolOffer.id}/voucher-codes`,
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
    });
    expect(statsRes.statusCode).toBe(200);
    const stats = JSON.parse(statsRes.payload);
    expect(stats.total).toBe(3);
    expect(stats.available).toBe(3);
    expect(stats.claimed).toBe(0);

    // 4. User claims an item from pool
    const claimRes = await app.inject({
      method: 'POST',
      url: `/api/offers/${poolOffer.id}/claim`,
      headers: { cookie: memberCookie, 'x-csrf-token': memberCsrfToken },
      payload: {},
    });
    expect(claimRes.statusCode).toBe(201);
    const claim = JSON.parse(claimRes.payload);
    expect(claim.status).toBe('accepted');
    expect(claim.rewardPayload?.voucherCode).toBe('POOL-CODE-AAA');
    expect(claim.rewardPayload?.voucherDelivery).toBe('code_pool');

    // 5. Verify available count decremented
    const statsAfter = await app.inject({
      method: 'GET',
      url: `/api/insurer/offers/${poolOffer.id}/voucher-codes`,
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
    });
    const statsAfterJson = JSON.parse(statsAfter.payload);
    expect(statsAfterJson.available).toBe(2);
    expect(statsAfterJson.claimed).toBe(1);
  });

  it('supports partner email vouchers with contactEmail and multi-stage insurer processing', async () => {
    // 1. Create an email delivery voucher offer
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/insurer/offers',
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: {
        title: 'Partner HelloFresh Kochbox',
        description: 'Vom Partner direkt per Mail versendet',
        minBand: 0,
        minMonths: 0,
        valueLabel: '40 € Kochbox',
        membersOnly: false,
        benefitType: 'voucher',
        voucherDelivery: 'email',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const emailOffer = JSON.parse(createRes.payload);

    // 2. User claims with contactEmail
    const claimRes = await app.inject({
      method: 'POST',
      url: `/api/offers/${emailOffer.id}/claim`,
      headers: { cookie: memberCookie, 'x-csrf-token': memberCsrfToken },
      payload: {
        contactEmail: 'gutschein-empfaenger@beispiel.de',
      },
    });
    expect(claimRes.statusCode).toBe(201);
    const claim = JSON.parse(claimRes.payload);
    expect(claim.status).toBe('submitted');
    expect(claim.contactEmail).toBe('gutschein-empfaenger@beispiel.de');
    expect(claim.rewardPayload?.voucherDelivery).toBe('email');

    // 3. Insurer marks status as 'processing'
    const procRes = await app.inject({
      method: 'POST',
      url: `/api/insurer/claims/${claim.id}/decide`,
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: {
        decision: 'processing',
        note: 'Gutscheincode bei Partner angefragt',
      },
    });
    expect(procRes.statusCode).toBe(200);
    const procBody = JSON.parse(procRes.payload);
    expect(procBody.status).toBe('processing');

    // 4. Insurer marks status as 'accepted'
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/api/insurer/claims/${claim.id}/decide`,
      headers: { cookie: insurerCookie, 'x-csrf-token': insurerCsrfToken },
      payload: {
        decision: 'accepted',
        note: 'Code per E-Mail an gutschein-empfaenger@beispiel.de versendet',
      },
    });
    expect(acceptRes.statusCode).toBe(200);
    const acceptBody = JSON.parse(acceptRes.payload);
    expect(acceptBody.status).toBe('accepted');
  });

  it('allows claiming payout with KVNR without forcing IBAN input', async () => {
    // Member claims payout without entering IBAN, providing KVNR
    const res = await app.inject({
      method: 'POST',
      url: `/api/offers/${publicPayoutOfferId}/claim`,
      headers: { cookie: memberCookie, 'x-csrf-token': memberCsrfToken },
      payload: {
        payoutMethod: 'bank_transfer',
        kvnr: 'T123456789',
      },
    });
    expect(res.statusCode).toBe(201);
    const claim = JSON.parse(res.payload);
    expect(claim.status).toBe('submitted');
    expect(claim.kvnr).toBe('T123456789');
    expect(claim.payoutIbanMasked).toBeNull();
  });
});
