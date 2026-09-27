/**
 * Sentry initialisation for the Fastify backend.
 *
 * Must be imported as early as possible — before any other imports — in
 * index.ts so that the OpenTelemetry instrumentation can wrap all modules.
 *
 * Set SENTRY_DSN_BACKEND in your .env to enable error tracking.
 * Without it the module is a no-op and no external calls are made.
 */
import * as Sentry from '@sentry/node';
import { env } from '../env.js';

export function initSentry() {
  if (!env.SENTRY_DSN_BACKEND) {
    return; // Gracefully disabled when no DSN is configured
  }

  Sentry.init({
    dsn: env.SENTRY_DSN_BACKEND,
    environment: env.NODE_ENV,
    release: env.COMMIT_SHA,

    // Sample all errors, 10 % of transactions (performance)
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // Keep PII out of Sentry — strip IP and user-agent by default
    sendDefaultPii: false,
  });
}

/**
 * Capture an exception with optional tags for adapter / score context.
 * Safe to call even when Sentry is disabled.
 */
export function captureException(
  err: unknown,
  tags?: { adapter?: string; scoreMetric?: string; userId?: string },
) {
  if (!env.SENTRY_DSN_BACKEND) return;
  Sentry.withScope((scope) => {
    if (tags?.adapter) scope.setTag('adapter', tags.adapter);
    if (tags?.scoreMetric) scope.setTag('score_metric', tags.scoreMetric);
    if (tags?.userId) scope.setUser({ id: tags.userId });
    Sentry.captureException(err);
  });
}
