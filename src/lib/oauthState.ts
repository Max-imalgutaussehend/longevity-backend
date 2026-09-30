import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStatePayload {
  userId: string;
  provider: string;
  expiresAt: number;
}

function sign(payload: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(payload).digest('base64url');
}

export interface AntiCsrfStatePayload {
  nonce: string;
  expiresAt: number;
}

/**
 * A signed, session-less anti-CSRF state for flows with no authenticated
 * user yet at issuance time (e.g. "Sign in with Google") — @fastify/session's
 * PgSessionStore never persists unauthenticated sessions, so storing this in
 * req.session would silently no-op. The HMAC signature plus expiry is the
 * actual protection; there is no userId to bind against here.
 */
export function signAntiCsrfState(ttlMs = DEFAULT_STATE_TTL_MS): string {
  const payload: AntiCsrfStatePayload = {
    nonce: createHmac('sha256', env.SESSION_SECRET).update(`${Date.now()}:${Math.random()}`).digest('hex'),
    expiresAt: Date.now() + ttlMs,
  };
  const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(payloadEncoded);
  return `${payloadEncoded}.${signature}`;
}

export function verifyAntiCsrfState(state: string): boolean {
  const parts = state.split('.');
  if (parts.length !== 2) return false;
  const [payloadEncoded, signature] = parts;

  const expectedSignature = sign(payloadEncoded);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
    return false;
  }

  let payload: AntiCsrfStatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString('utf8')) as AntiCsrfStatePayload;
  } catch {
    return false;
  }

  if (typeof payload.nonce !== 'string' || typeof payload.expiresAt !== 'number') return false;
  if (Date.now() > payload.expiresAt) return false;

  return true;
}

export function signOAuthState(params: { userId: string; provider: string; ttlMs?: number }): string {
  const payload: OAuthStatePayload = {
    userId: params.userId,
    provider: params.provider,
    expiresAt: Date.now() + (params.ttlMs ?? DEFAULT_STATE_TTL_MS),
  };
  const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(payloadEncoded);
  return `${payloadEncoded}.${signature}`;
}

export type OAuthStateResult =
  | { ok: true; userId: string; provider: string }
  | { ok: false; reason: 'malformed' | 'invalid_signature' | 'expired' };

/**
 * `expectedProviders` accepts one or more provider keys. Some providers share
 * a single OAuth redirect endpoint (e.g. google-health redirects through the
 * google-fit callback route), so the URL's :provider param does not always
 * match the provider that was originally signed into the state — the HMAC
 * signature is what actually authenticates the payload, not this check.
 */
export function verifyOAuthState(state: string, expectedProviders: string | string[]): OAuthStateResult {
  const allowedProviders = Array.isArray(expectedProviders) ? expectedProviders : [expectedProviders];

  const parts = state.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadEncoded, signature] = parts;

  const expectedSignature = sign(payloadEncoded);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString('utf8')) as OAuthStatePayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof payload.userId !== 'string' || typeof payload.provider !== 'string' || typeof payload.expiresAt !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (!allowedProviders.includes(payload.provider)) return { ok: false, reason: 'malformed' };
  if (Date.now() > payload.expiresAt) return { ok: false, reason: 'expired' };

  return { ok: true, userId: payload.userId, provider: payload.provider };
}
