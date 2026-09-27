// Sentry must be initialised before any other imports for full OTel coverage
import { initSentry, captureException } from './lib/sentry.js';
initSentry();

import { buildApp } from './app.js';
import { CURRENT_HEALTH_DATA_CONSENT_VERSION, HEALTH_DATA_CONSENT_TEXT } from './lib/consent.js';

export { CURRENT_HEALTH_DATA_CONSENT_VERSION, HEALTH_DATA_CONSENT_TEXT };

const start = async () => {
  const app = await buildApp();

  try {
    await app.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    captureException(err);
    process.exit(1);
  }
};

start();
