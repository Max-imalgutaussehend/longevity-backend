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

  it('registers sourcesOAuthRoutes and handles reachability probes', async () => {
    const app = Fastify();
    await app.register(sourcesOAuthRoutes);

    // HEAD reachability probe for known provider
    const headRes = await app.inject({
      method: 'HEAD',
      url: '/oauth/callback/withings',
    });
    expect(headRes.statusCode).toBe(200);

    // HEAD probe for unknown provider
    const headUnknown = await app.inject({
      method: 'HEAD',
      url: '/oauth/callback/unknown-provider',
    });
    expect(headUnknown.statusCode).toBe(404);

    // Empty GET reachability probe
    const getProbe = await app.inject({
      method: 'GET',
      url: '/oauth/callback/withings',
    });
    expect(getProbe.statusCode).toBe(200);
    const body = JSON.parse(getProbe.payload);
    expect(body.ok).toBe(true);

    // Google callback HEAD reachability probe
    const googleHead = await app.inject({
      method: 'HEAD',
      url: '/sources/google/callback',
    });
    expect(googleHead.statusCode).toBe(200);

    // Google callback GET reachability probe
    const googleGet = await app.inject({
      method: 'GET',
      url: '/sources/google/callback',
    });
    expect(googleGet.statusCode).toBe(200);
    expect(JSON.parse(googleGet.payload).ok).toBe(true);
  });

  it('rejects unauthenticated requests on protected routes with 401', async () => {
    const app = Fastify();
    await app.register(fastifyCookie);
    await app.register(fastifySession, {
      secret: 'test-session-secret-32-bytes-long!',
      cookie: { secure: false },
    });
    await app.register(sourcesOverviewRoutes);

    const res = await app.inject({
      method: 'GET',
      url: '/sources',
    });
    expect(res.statusCode).toBe(401);
  });
});
