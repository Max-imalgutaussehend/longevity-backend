process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

describe('Application Factory & Route Plugin Architecture (app.ts)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    app = await buildApp();
  });

  describe('Server Baseline', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/non-existent-route',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('Auth Routes Validation (/api/auth)', () => {
    it('rejects registration when mandatory fields are missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'test@example.com' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.title).toBe('Pflichtfelder fehlen.');
    });

    it('rejects registration with short password (< 10 chars)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'test@example.com',
          password: 'short',
          birthDate: '1990-01-01',
          sex: 'm',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.title).toBe('Passwort muss mindestens 10 Zeichen haben.');
    });

    it('rejects registration with invalid sex value', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'test@example.com',
          password: 'aVerySecurePassword123!',
          birthDate: '1990-01-01',
          sex: 'x',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.title).toBe('Ungültiges Geschlecht.');
    });

    it('rejects login when credentials are missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.title).toBe('E-Mail und Passwort erforderlich.');
    });

    it('rejects verify-email when token is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-email',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.title).toBe('Token fehlt.');
    });

    it('rejects password reset request when email is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/request-password-reset',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.title).toBe('E-Mail erforderlich.');
    });
  });

  describe('OAuth Probe Routes (/api)', () => {
    it('responds to HEAD probes on Google OAuth callback', async () => {
      const res = await app.inject({
        method: 'HEAD',
        url: '/api/sources/google/callback',
      });
      expect(res.statusCode).toBe(200);
    });

    it('responds to GET reachability probes on Google OAuth callback', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sources/google/callback',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
    });
  });

  describe('Authentication Enforcement across Protected Route Plugins', () => {
    const protectedGetEndpoints = [
      { name: 'account (/api/me)', url: '/api/me' },
      { name: 'score current (/api/score/current)', url: '/api/score/current' },
      { name: 'score breakdown (/api/score/breakdown)', url: '/api/score/breakdown' },
      { name: 'score levers (/api/score/levers)', url: '/api/score/levers' },
      { name: 'report weekly (/api/report/weekly)', url: '/api/report/weekly' },
      { name: 'share tokens (/api/share-tokens)', url: '/api/share-tokens' },
      { name: 'insurer overview (/api/insurer/overview)', url: '/api/insurer/overview' },
      { name: 'sources (/api/sources)', url: '/api/sources' },
      { name: 'samples summary (/api/samples/summary)', url: '/api/samples/summary' },
    ];

    for (const endpoint of protectedGetEndpoints) {
      it(`enforces 401 Unauthorized for unauthenticated ${endpoint.name}`, async () => {
        const res = await app.inject({
          method: 'GET',
          url: endpoint.url,
        });
        expect(res.statusCode).toBe(401);
        const body = JSON.parse(res.payload);
        expect(body.title).toBe('Nicht angemeldet.');
      });
    }
  });
});
