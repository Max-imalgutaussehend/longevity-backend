process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect } from 'vitest';
import { signOAuthState, verifyOAuthState, signAntiCsrfState, verifyAntiCsrfState } from '../lib/oauthState.js';

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

  it('accepts a state whose provider matches any entry in an allow-list (google-fit/google-health share one callback route, #129 follow-up)', () => {
    const state = signOAuthState({ userId: 'user-123', provider: 'google-health' });
    const result = verifyOAuthState(state, ['google-fit', 'google-health']);
    expect(result).toEqual({ ok: true, userId: 'user-123', provider: 'google-health' });
  });

  it('rejects a state whose provider is not in the allow-list', () => {
    const state = signOAuthState({ userId: 'user-123', provider: 'withings' });
    const result = verifyOAuthState(state, ['google-fit', 'google-health']);
    expect(result.ok).toBe(false);
  });
});

describe('signAntiCsrfState / verifyAntiCsrfState (#129 follow-up — session-less Google Sign-In CSRF guard)', () => {
  it('accepts a freshly signed state', () => {
    const state = signAntiCsrfState();
    expect(verifyAntiCsrfState(state)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const state = signAntiCsrfState();
    const [payloadEncoded, signature] = state.split('.');
    const payload = JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString('utf8'));
    const forgedPayload = Buffer.from(JSON.stringify({ ...payload, nonce: 'attacker-controlled' })).toString('base64url');
    expect(verifyAntiCsrfState(`${forgedPayload}.${signature}`)).toBe(false);
  });

  it('rejects an invalid signature', () => {
    const state = signAntiCsrfState();
    const [payloadEncoded] = state.split('.');
    expect(verifyAntiCsrfState(`${payloadEncoded}.not-a-valid-signature`)).toBe(false);
  });

  it('rejects a malformed state string', () => {
    expect(verifyAntiCsrfState('not-a-valid-state')).toBe(false);
    expect(verifyAntiCsrfState('')).toBe(false);
  });

  it('rejects an expired state', () => {
    const state = signAntiCsrfState(-1000);
    expect(verifyAntiCsrfState(state)).toBe(false);
  });

  it('two calls never produce the same nonce', () => {
    const a = signAntiCsrfState();
    const b = signAntiCsrfState();
    expect(a).not.toBe(b);
  });
});
