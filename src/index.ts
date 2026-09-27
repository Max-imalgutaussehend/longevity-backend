import { buildApp } from './app.js';
import { CURRENT_HEALTH_DATA_CONSENT_VERSION, HEALTH_DATA_CONSENT_TEXT } from './lib/consent.js';
import { env } from './env.js';
import { isValidEd25519PrivateKey, isValidEd25519PublicKey } from './lib/signing.js';

export { CURRENT_HEALTH_DATA_CONSENT_VERSION, HEALTH_DATA_CONSENT_TEXT };

const start = async () => {
  if (env.NODE_ENV === 'production') {
    if (!env.SIGNING_KEY_PRIVATE || !env.SIGNING_KEY_PUBLIC) {
      console.error('Fatal: Production server cannot start without SIGNING_KEY_PRIVATE and SIGNING_KEY_PUBLIC.');
      process.exit(1);
    }
    if (!isValidEd25519PrivateKey(env.SIGNING_KEY_PRIVATE) || !isValidEd25519PublicKey(env.SIGNING_KEY_PUBLIC)) {
      console.error('Fatal: SIGNING_KEY_PRIVATE or SIGNING_KEY_PUBLIC is not a valid Ed25519 key.');
      process.exit(1);
    }
  }

  const app = await buildApp();

  try {
    await app.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
