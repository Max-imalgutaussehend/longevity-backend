import { describe, it, expect } from 'vitest';
import {
  generateEd25519KeyPair,
  signTokenPayload,
  verifyTokenSignature,
  buildTokenPayload,
} from '../lib/signing.js';

describe('Ed25519 Token Signing & Verification', () => {
  it('generates keypair, signs payload, and verifies signature successfully', () => {
    const { privateKey, publicKey } = generateEd25519KeyPair();
    expect(privateKey).toContain('BEGIN PRIVATE KEY');
    expect(publicKey).toContain('BEGIN PUBLIC KEY');

    const payload = buildTokenPayload('token-123', 65, 80, '2026-12-31T23:59:59.000Z');
    const signature = signTokenPayload(payload, privateKey);
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(20);

    const isValid = verifyTokenSignature(payload, signature, publicKey);
    expect(isValid).toBe(true);
  });

  it('rejects signature if payload is tampered with', () => {
    const { privateKey, publicKey } = generateEd25519KeyPair();
    const payload = buildTokenPayload('token-123', 65, 80, '2026-12-31T23:59:59.000Z');
    const signature = signTokenPayload(payload, privateKey);

    const tamperedPayload = buildTokenPayload('token-123', 80, 100, '2026-12-31T23:59:59.000Z');
    const isValid = verifyTokenSignature(tamperedPayload, signature, publicKey);
    expect(isValid).toBe(false);
  });

  it('rejects signature if wrong public key is used', () => {
    const keyPairA = generateEd25519KeyPair();
    const keyPairB = generateEd25519KeyPair();

    const payload = buildTokenPayload('token-123', 65, 80, '2026-12-31T23:59:59.000Z');
    const signature = signTokenPayload(payload, keyPairA.privateKey);

    const isValid = verifyTokenSignature(payload, signature, keyPairB.publicKey);
    expect(isValid).toBe(false);
  });
});
