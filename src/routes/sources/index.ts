import type { FastifyInstance } from 'fastify';
import { sourcesOverviewRoutes } from './overview.js';
import { sourcesOAuthRoutes } from './oauth.js';
import { sourcesSyncRoutes } from './sync.js';
import { sourcesImportRoutes } from './imports.js';

export async function sourcesRoutes(app: FastifyInstance) {
  await app.register(sourcesOverviewRoutes);
  await app.register(sourcesOAuthRoutes);
  await app.register(sourcesSyncRoutes);
  await app.register(sourcesImportRoutes);
}

export { sourcesOverviewRoutes } from './overview.js';
export { sourcesOAuthRoutes } from './oauth.js';
export { sourcesSyncRoutes } from './sync.js';
export { sourcesImportRoutes } from './imports.js';
