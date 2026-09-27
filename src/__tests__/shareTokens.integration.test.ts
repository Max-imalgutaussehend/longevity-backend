import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  signTokenPayload,
  buildTokenPayload,
  getActivePrivateKey,
} from '../lib/signing.js';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('Share Tokens & Verification Endpoint Integration', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  let testUserId: string;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    app = await buildApp();

    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    const [user] = await db.insert(tables.users).values({
      email: `share-verify-test-${Date.now()}@test.local`,
      passwordHash: 'dummy-hash',
      birthDate: '1995-05-05',
      sex: 'm',
      displayName: 'Verify Tester',
    }).returning();
    testUserId = user.id;
  });

  afterAll(async () => {
    if (testUserId && db) {
      const { eq } = await import('drizzle-orm');
      await db.delete(tables.users).where(eq(tables.users.id, testUserId));
    }
  });

  it('rejects unknown token with not_found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/verify/${randomUUID()}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('not_found');
  });

  it('strictly rejects tokens with legacy insecure signature === id', async () => {
    const id = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(Date.now() + 86400000);

    await db.insert(tables.shareTokens).values({
      id,
      userId: testUserId,
      bandLow: 70,
      bandHigh: 85,
      issuedAt,
      expiresAt,
      signature: id, // legacy bypass signature === id
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/verify/${id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('invalid_signature');
  });

  it('strictly rejects tokens with invalid or tampered signature', async () => {
    const id = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(Date.now() + 86400000);

    await db.insert(tables.shareTokens).values({
      id,
      userId: testUserId,
      bandLow: 70,
      bandHigh: 85,
      issuedAt,
      expiresAt,
      signature: 'invalid-base64url-signature',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/verify/${id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('invalid_signature');
  });

  it('accepts tokens with valid Ed25519 signature', async () => {
    const id = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(Date.now() + 86400000);
    const bandLow = 70;
    const bandHigh = 85;

    const payload = buildTokenPayload(id, bandLow, bandHigh, expiresAt.toISOString());
    const signature = signTokenPayload(payload, getActivePrivateKey()!);

    await db.insert(tables.shareTokens).values({
      id,
      userId: testUserId,
      bandLow,
      bandHigh,
      issuedAt,
      expiresAt,
      signature,
      metadata: {
        verifiedOnly: true,
        trustLevel: 'cloud_verified',
        verifiedSources: ['withings'],
        totalSampleCount: 15,
        excludedSampleCount: 0,
        activeDays: 14,
        certificateType: 'GKV / PKV Verifizierter Prämiennachweis',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/verify/${id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.valid).toBe(true);
    expect(body.band).toEqual({ low: 70, high: 85 });
    expect(body.verifiedOnly).toBe(true);
    expect(body.trustLevel).toBe('cloud_verified');
    expect(body.issuer).toContain('Ed25519');
  });

  it('rejects revoked tokens even with valid signature', async () => {
    const id = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(Date.now() + 86400000);
    const bandLow = 60;
    const bandHigh = 75;

    const payload = buildTokenPayload(id, bandLow, bandHigh, expiresAt.toISOString());
    const signature = signTokenPayload(payload, getActivePrivateKey()!);

    await db.insert(tables.shareTokens).values({
      id,
      userId: testUserId,
      bandLow,
      bandHigh,
      issuedAt,
      expiresAt,
      revokedAt: new Date(),
      signature,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/verify/${id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('revoked');
  });

  it('rejects expired tokens even with valid signature', async () => {
    const id = randomUUID();
    const issuedAt = new Date(Date.now() - 100000);
    const expiresAt = new Date(Date.now() - 50000);
    const bandLow = 60;
    const bandHigh = 75;

    const payload = buildTokenPayload(id, bandLow, bandHigh, expiresAt.toISOString());
    const signature = signTokenPayload(payload, getActivePrivateKey()!);

    await db.insert(tables.shareTokens).values({
      id,
      userId: testUserId,
      bandLow,
      bandHigh,
      issuedAt,
      expiresAt,
      signature,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/verify/${id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('expired');
  });
});
