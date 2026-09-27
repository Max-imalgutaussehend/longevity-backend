import type { FastifyReply } from 'fastify';

/**
 * Generates a CSRF token using @fastify/csrf-protection and sets the
 * readable XSRF-TOKEN cookie for SPA clients (SameSite=Lax, Secure='auto').
 */
export function setCsrfCookies(reply: FastifyReply): string {
  const token = reply.generateCsrf();
  reply.setCookie('XSRF-TOKEN', token, {
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    secure: 'auto',
  });
  return token;
}

/**
 * Clears the CSRF secret and readable token cookies on logout.
 */
export function clearCsrfCookies(reply: FastifyReply): void {
  reply.clearCookie('XSRF-TOKEN', { path: '/' });
  reply.clearCookie('_csrf', { path: '/' });
}

/**
 * Determines whether a route is exempt from CSRF verification.
 * Exempt routes include:
 * - Safe HTTP methods (GET, HEAD, OPTIONS)
 * - Background webhooks (Health Auto Export Webhook, token-authenticated)
 * - Public auth endpoints without an active session (login, register, reset, verify)
 * - Public contact and verify endpoints
 * - System endpoints (healthz, openapi)
 */
export function isCsrfExempt(url: string, method: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;

  const rawPath = url.split('?')[0];
  const p = rawPath.startsWith('/api') ? rawPath.slice(4) : rawPath;

  // Background Webhooks
  if (p.startsWith('/sources/health-auto-export/webhook')) return true;

  // Public Auth endpoints
  if (
    p === '/auth/login' ||
    p === '/auth/register' ||
    p === '/auth/logout' ||
    p === '/auth/verify-email' ||
    p === '/auth/resend-verification' ||
    p === '/auth/request-password-reset' ||
    p === '/auth/reset-password' ||
    p === '/auth/accept-invite' ||
    p === '/auth/google/url' ||
    p === '/auth/csrf'
  ) {
    return true;
  }

  // Public Contact & Info
  if (p === '/contact/insurer') return true;

  // Public Verify
  if (p.startsWith('/verify')) return true;

  // System endpoints
  if (p === '/healthz' || p === '/openapi.json') return true;

  return false;
}
