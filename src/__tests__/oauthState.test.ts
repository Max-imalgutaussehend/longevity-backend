process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect } from 'vitest';
import { signOAuthState, verifyOAuthState } from '../lib/oauthState.js';

describe('oauthState (#107)', () => {
  it('signs and verifies a valid state round-trip', () => {
    const state = signOAuthState({ userId: 'user-123', provider: 'withings' });
    const result = verifyOAuthState(state, 'withings');
    expect(result).toEqual({ ok: true, userId: 'user-123', provider: 'withings' });
  });

  it('rejects a state signed for a different provider', () => {
    const state = signOAuthState({ userId: 'user-123', provider: 'withings' });
    const result = verifyOAuthState(state, 'oura');
    expect(result.ok).toBe(false);
  });

  it('rejects a forged/tampered payload (attacker swaps userId but keeps original signature)', () => {
    const state = signOAuthState({ userId: 'victim-user', provider: 'withings' });
    const [payloadEncoded, signature] = state.split('.');
    const payload = JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString('utf8'));
    const forgedPayload = Buffer.from(JSON.stringify({ ...payload, userId: 'attacker-user' })).toString('base64url');
    const result = verifyOAuthState(`${forgedPayload}.${signature}`, 'withings');
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a state with an invalid signature', () => {
    const state = signOAuthState({ userId: 'user-123', provider: 'withings' });
    const [payloadEncoded] = state.split('.');
    const result = verifyOAuthState(`${payloadEncoded}.not-a-valid-signature`, 'withings');
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a malformed state string', () => {
    expect(verifyOAuthState('not-a-valid-state', 'withings').ok).toBe(false);
    expect(verifyOAuthState('', 'withings').ok).toBe(false);
  });

  it('rejects an expired state', () => {
    const state = signOAuthState({ userId: 'user-123', provider: 'withings', ttlMs: -1000 });
    const result = verifyOAuthState(state, 'withings');
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });
});
