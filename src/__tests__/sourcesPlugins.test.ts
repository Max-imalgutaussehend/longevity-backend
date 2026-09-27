process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';

type SourcesModule = typeof import('../routes/sources/index.js');

describe('Modular Sources Routes Plugins', () => {
  let sourcesRoutes: SourcesModule['sourcesRoutes'];
  let sourcesOverviewRoutes: SourcesModule['sourcesOverviewRoutes'];
  let sourcesOAuthRoutes: SourcesModule['sourcesOAuthRoutes'];
  let sourcesSyncRoutes: SourcesModule['sourcesSyncRoutes'];
  let sourcesImportRoutes: SourcesModule['sourcesImportRoutes'];

  beforeAll(async () => {
    const mod = await import('../routes/sources/index.js');
    sourcesRoutes = mod.sourcesRoutes;
    sourcesOverviewRoutes = mod.sourcesOverviewRoutes;
    sourcesOAuthRoutes = mod.sourcesOAuthRoutes;
    sourcesSyncRoutes = mod.sourcesSyncRoutes;
    sourcesImportRoutes = mod.sourcesImportRoutes;
  });

  it('exports all sub-plugins correctly', () => {
    expect(typeof sourcesRoutes).toBe('function');
    expect(typeof sourcesOverviewRoutes).toBe('function');
    expect(typeof sourcesOAuthRoutes).toBe('function');
    expect(typeof sourcesSyncRoutes).toBe('function');
    expect(typeof sourcesImportRoutes).toBe('function');
  });

  describe('sourcesOAuthRoutes probes & validation', () => {
    let app: ReturnType<typeof Fastify>;

    beforeAll(async () => {
      app = Fastify();
      await app.register(fastifyCookie);
      await app.register(fastifySession, {
        secret: 'test-session-secret-32-bytes-long!',
        cookie: { secure: false },
      });
      await app.register(sourcesOAuthRoutes);
    });

    it('handles HEAD reachability probes for known providers', async () => {
      const res = await app.inject({
        method: 'HEAD',
        url: '/oauth/callback/withings',
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 404 on HEAD probe for unknown provider', async () => {
      const res = await app.inject({
        method: 'HEAD',
        url: '/oauth/callback/unknown-provider',
      });
      expect(res.statusCode).toBe(404);
    });

    it('handles empty GET reachability probes for known providers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/oauth/callback/withings',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
      expect(body.message).toBe('OAuth callback endpoint ready.');
    });

    it('handles Google callback HEAD & GET reachability probes', async () => {
      const headRes = await app.inject({
        method: 'HEAD',
        url: '/sources/google/callback',
      });
      expect(headRes.statusCode).toBe(200);

      const getRes = await app.inject({
        method: 'GET',
        url: '/sources/google/callback',
      });
      expect(getRes.statusCode).toBe(200);
      expect(JSON.parse(getRes.payload).ok).toBe(true);
    });

    it('returns 400 when OAuth callback has code but lacks state', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/oauth/callback/withings?code=auth-code-123',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.title).toBe('code oder state fehlt.');
    });

    it('returns 400 when Google OAuth callback has code but lacks state', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sources/google/callback?code=auth-code-123',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.title).toBe('code oder state fehlt.');
    });

    it('returns 404 for unknown provider in OAuth callback', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/oauth/callback/non-existent-provider?code=123&state=abc',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.title).toBe('Unbekannter Provider.');
    });

    it('rejects unauthenticated /sources/:provider/connect with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sources/withings/connect',
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects unauthenticated /sources/:provider/exchange with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sources/withings/exchange',
        payload: { code: 'some-code' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('sourcesOverviewRoutes authentication', () => {
    let app: ReturnType<typeof Fastify>;

    beforeAll(async () => {
      app = Fastify();
      await app.register(fastifyCookie);
      await app.register(fastifySession, {
        secret: 'test-session-secret-32-bytes-long!',
        cookie: { secure: false },
      });
      await app.register(sourcesOverviewRoutes);
    });

    it('rejects unauthenticated GET /sources with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sources',
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects unauthenticated GET /samples/summary with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/samples/summary',
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects unauthenticated PATCH /sources/:id with 401', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/sources/src-123',
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('sourcesSyncRoutes authentication', () => {
    let app: ReturnType<typeof Fastify>;

    beforeAll(async () => {
      app = Fastify();
      await app.register(fastifyCookie);
      await app.register(fastifySession, {
        secret: 'test-session-secret-32-bytes-long!',
        cookie: { secure: false },
      });
      await app.register(sourcesSyncRoutes);
    });

    it('rejects unauthenticated POST /sources/withings/sync with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sources/withings/sync',
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects unauthenticated POST /sources/google-fit/sync with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sources/google-fit/sync',
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects unauthenticated POST /sources/oura/sync with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sources/oura/sync',
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects unauthenticated POST /sources/strava/sync with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sources/strava/sync',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('sourcesImportRoutes authentication', () => {
    let app: ReturnType<typeof Fastify>;

    beforeAll(async () => {
      app = Fastify();
      await app.register(fastifyCookie);
      await app.register(fastifySession, {
        secret: 'test-session-secret-32-bytes-long!',
        cookie: { secure: false },
      });
      await app.register(sourcesImportRoutes);
    });

    it('rejects unauthenticated POST /sources/apple-health/upload with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sources/apple-health/upload',
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects unauthenticated POST /labs with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/labs',
        payload: { values: [] },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects unauthenticated POST /sources/fhir/upload with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sources/fhir/upload',
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
