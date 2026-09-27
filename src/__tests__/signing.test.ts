process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  generateEd25519KeyPair,
  signTokenPayload,
  verifyTokenSignature,
  buildTokenPayload,
  isValidEd25519PrivateKey,
  isValidEd25519PublicKey,
  getPublicKeyJwk,
  getDevSigningKeys,
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

  describe('Key Validation & Parsing', () => {
    it('identifies valid Ed25519 private and public keys', () => {
      const { privateKey, publicKey } = generateEd25519KeyPair();
      expect(isValidEd25519PrivateKey(privateKey)).toBe(true);
      expect(isValidEd25519PublicKey(publicKey)).toBe(true);
    });

    it('rejects malformed or non-Ed25519 keys', () => {
      expect(isValidEd25519PrivateKey('corrupted-key-data')).toBe(false);
      expect(isValidEd25519PublicKey('corrupted-key-data')).toBe(false);

      // Generate RSA key pair to test algorithm rejection
      const rsaKeyPair = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      expect(isValidEd25519PrivateKey(rsaKeyPair.privateKey)).toBe(false);
      expect(isValidEd25519PublicKey(rsaKeyPair.publicKey)).toBe(false);
    });
  });

  describe('JWK Export (RFC 8037)', () => {
    it('exports Ed25519 public key to valid JWK format with OKP and Ed25519 crv', () => {
      const { publicKey } = generateEd25519KeyPair();
      const jwk = getPublicKeyJwk(publicKey);

      expect(jwk).not.toBeNull();
      expect(jwk?.kty).toBe('OKP');
      expect(jwk?.crv).toBe('Ed25519');
      expect(typeof jwk?.x).toBe('string');
      expect(jwk?.x.length).toBeGreaterThan(30);
    });

    it('returns null for invalid or non-Ed25519 keys', () => {
      expect(getPublicKeyJwk('invalid-pem')).toBeNull();

      const rsaKeyPair = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      expect(getPublicKeyJwk(rsaKeyPair.publicKey)).toBeNull();
    });
  });

  describe('Development Key Pair Fallback', () => {
    it('provides persistent singleton dev signing keys', () => {
      const keys1 = getDevSigningKeys();
      const keys2 = getDevSigningKeys();
      expect(keys1.privateKey).toBe(keys2.privateKey);
      expect(keys1.publicKey).toBe(keys2.publicKey);

      const payload = 'test-token-payload';
      const sig = signTokenPayload(payload, keys1.privateKey);
      expect(verifyTokenSignature(payload, sig, keys2.publicKey)).toBe(true);
    });
  });

  describe('Public Key API Route (/api/verify/public-key)', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
    });

    it('returns public key in SPKI-PEM and JWK format', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/verify/public-key',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.algorithm).toBe('Ed25519');
      expect(body.format).toBe('spki-pem');
      expect(body.publicKey).toContain('BEGIN PUBLIC KEY');
      expect(body.jwk).toBeDefined();
      expect(body.jwk.kty).toBe('OKP');
      expect(body.jwk.crv).toBe('Ed25519');
      expect(typeof body.jwk.x).toBe('string');
    });
  });
});
