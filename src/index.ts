import Fastify from 'fastify';
import { env } from './env.js';

const app = Fastify({ logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' } });

// Health route (no auth required)
app.get('/api/healthz', async () => {
  return { ok: true, db: true, engineVersion: '0.1.0', commit: env.COMMIT_SHA };
});

const start = async () => {
  try {
    await app.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
