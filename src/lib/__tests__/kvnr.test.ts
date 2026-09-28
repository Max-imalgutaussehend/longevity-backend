import { describe, it, expect } from 'vitest';
import { validateKvnr, hashKvnr } from '../kvnr.js';

describe('KVNR Validation & Hashing (§ 290 SGB V)', () => {
  describe('validateKvnr()', () => {
    it('validates correct KVNRs according to Modulo-10 checksum', () => {
      // Z62941004: Z=26 -> 2,6,6,2,9,4,1,0,0,4 -> Sum 41 -> (10 - 1) % 10 = 9
      const res1 = validateKvnr('Z629410049');
      expect(res1.valid).toBe(true);
      expect(res1.normalized).toBe('Z629410049');
      expect(res1.error).toBeUndefined();

      // A12345678: A=01 -> 0,1,1,2,3,4,5,6,7,8 -> Sum 40 -> Check digit 0
      const res2 = validateKvnr('A123456780');
      expect(res2.valid).toBe(true);
      expect(res2.normalized).toBe('A123456780');

      // T12345678: T=20 -> 2,0,1,2,3,4,5,6,7,8 -> Sum 40 -> Check digit 0
      const res3 = validateKvnr('T123456780');
      expect(res3.valid).toBe(true);
      expect(res3.normalized).toBe('T123456780');
    });

    it('accepts lowercase input and trims whitespace', () => {
      const res = validateKvnr('  z629410049  ');
      expect(res.valid).toBe(true);
      expect(res.normalized).toBe('Z629410049');
    });

    it('rejects invalid check digits', () => {
      const res1 = validateKvnr('Z629410048'); // Expected 9
      expect(res1.valid).toBe(false);
      expect(res1.error).toContain('Prüfziffer');

      const res2 = validateKvnr('A123456789'); // Expected 0
      expect(res2.valid).toBe(false);
      expect(res2.error).toContain('Prüfziffer');
    });

    it('rejects invalid formats and empty values', () => {
      expect(validateKvnr(null).valid).toBe(false);
      expect(validateKvnr(undefined).valid).toBe(false);
      expect(validateKvnr('').valid).toBe(false);
      expect(validateKvnr('   ').valid).toBe(false);

      // Too short
      expect(validateKvnr('Z62941004').valid).toBe(false);
      // Too long
      expect(validateKvnr('Z6294100499').valid).toBe(false);
      // First character is a digit
      expect(validateKvnr('1234567890').valid).toBe(false);
      // Contains special characters or letters in digit block
      expect(validateKvnr('Z62941004A').valid).toBe(false);
      expect(validateKvnr('Z629-10049').valid).toBe(false);
    });
  });

  describe('hashKvnr()', () => {
    it('produces deterministic 64-char hex SHA-256 HMAC', () => {
      const hash1 = hashKvnr('Z629410049', 'test-salt');
      const hash2 = hashKvnr('Z629410049', 'test-salt');
      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
    });

    it('normalizes lowercase and whitespace before hashing', () => {
      const hash1 = hashKvnr('Z629410049', 'test-salt');
      const hash2 = hashKvnr('  z629410049  ', 'test-salt');
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different KVNRs or salts', () => {
      const hashA = hashKvnr('Z629410049', 'test-salt');
      const hashB = hashKvnr('A123456780', 'test-salt');
      const hashSalt2 = hashKvnr('Z629410049', 'other-salt');

      expect(hashA).not.toBe(hashB);
      expect(hashA).not.toBe(hashSalt2);
    });
  });
});
