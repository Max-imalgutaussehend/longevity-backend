import type { FastifyRequest } from 'fastify';
import { env } from '../env.js';

/**
 * Resolves the primary base URL of the application.
 * Respects PUBLIC_BASE_URL configuration, reverse-proxy headers, and local development fallbacks.
 */
export function getAppBaseUrl(req?: FastifyRequest): string {
  if (env.PUBLIC_BASE_URL) {
    return env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  }

  if (req) {
    const forwardedProto = req.headers['x-forwarded-proto'] as string | undefined;
    const proto = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
    const forwardedHost = req.headers['x-forwarded-host'] as string | undefined;
    const host = forwardedHost ? forwardedHost.split(',')[0].trim() : req.headers.host;

    if (host) {
      return `${proto}://${host}`.replace(/\/+$/, '');
    }
  }

  // Fallback for local development or background tasks without request context
  return env.NODE_ENV === 'development' ? 'http://localhost:5173' : 'http://localhost:3000';
}

/**
 * Builds an absolute frontend URL for links in emails and OAuth redirects.
 */
export function buildFrontendUrl(path: string, req?: FastifyRequest): string {
  const base = getAppBaseUrl(req);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}
