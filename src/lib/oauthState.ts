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

export function verifyOAuthState(state: string, expectedProvider: string): OAuthStateResult {
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
  if (payload.provider !== expectedProvider) return { ok: false, reason: 'malformed' };
  if (Date.now() > payload.expiresAt) return { ok: false, reason: 'expired' };

  return { ok: true, userId: payload.userId, provider: payload.provider };
}
