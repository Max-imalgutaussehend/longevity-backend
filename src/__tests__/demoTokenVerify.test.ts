process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

describe('Public Demo Token Verification (#77)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/verify/demo-token returns valid: true with band 70-79', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/verify/demo-token',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.valid).toBe(true);
    expect(body.band).toEqual({ low: 70, high: 79 });
    expect(body.verifiedOnly).toBe(true);
    expect(body.trustLevel).toBe('cloud_verified');
    expect(body.certificateType).toBe('GKV / PKV Verifizierter Prämiennachweis');
    expect(body.issuer).toContain('Ed25519');
  });
});
