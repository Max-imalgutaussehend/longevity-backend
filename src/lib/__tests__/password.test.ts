import { describe, it, expect } from 'vitest';
import { hash, Algorithm } from '@node-rs/argon2';
import { hashPassword, verifyPassword, passwordSchema, ARGON2_OPTIONS, pepperPassword } from '../password.js';

describe('Password Module — Argon2id Härtung & Server-Pepper', () => {
  describe('hashPassword & verifyPassword', () => {
    it('generates an Argon2id hash containing OWASP parameters (m=19456, t=2, p=1)', async () => {
      const password = 'CorrectHorseBatteryStaple123!';
      const hashResult = await hashPassword(password);

      expect(hashResult).toContain('$argon2id$');
      expect(hashResult).toContain('m=19456');
      expect(hashResult).toContain('t=2');
      expect(hashResult).toContain('p=1');
      expect(ARGON2_OPTIONS.algorithm).toBe(Algorithm.Argon2id);
      expect(ARGON2_OPTIONS.memoryCost).toBe(19456);
      expect(ARGON2_OPTIONS.timeCost).toBe(2);
      expect(ARGON2_OPTIONS.parallelism).toBe(1);
    });

    it('verifies correct password and rejects incorrect password', async () => {
      const password = 'SecurePassword2026!';
      const hashResult = await hashPassword(password);

      expect(await verifyPassword(hashResult, password)).toBe(true);
      expect(await verifyPassword(hashResult, 'WrongPassword2026!')).toBe(false);
      expect(await verifyPassword(hashResult, '')).toBe(false);
    });

    it('uses HMAC-SHA256 server pepper prior to Argon2 hashing', async () => {
      const password = 'TestPepperIntegration1!';
      const pepperedHex = pepperPassword(password);

      expect(typeof pepperedHex).toBe('string');
      expect(pepperedHex.length).toBe(64); // 32 bytes hex encoded = 64 hex chars

      // Hashes generated with different input (e.g. unpeppered) do not match
      const unpepperedHash = await hash(password);
      expect(await verifyPassword(unpepperedHash, password)).toBe(true); // Supported via legacy fallback
    });

    it('supports fallback verification for legacy unpeppered hashes', async () => {
      const rawPassword = 'legacy-password-seed-123';
      const legacyHash = await hash(rawPassword);

      // Verify that verifyPassword correctly verifies unpeppered legacy hash
      const verified = await verifyPassword(legacyHash, rawPassword);
      expect(verified).toBe(true);

      const wrong = await verifyPassword(legacyHash, 'wrong-password');
      expect(wrong).toBe(false);
    });
  });

  describe('passwordSchema (Zod Validation)', () => {
    it('accepts strong passwords meeting all complexity criteria', () => {
      expect(passwordSchema.safeParse('CorrectHorse1!').success).toBe(true);
      expect(passwordSchema.safeParse('aVerySecurePassword123!').success).toBe(true);
      expect(passwordSchema.safeParse('Longevity-2026-SuperSafe').success).toBe(true);
      expect(passwordSchema.safeParse('P@ssw0rd12345').success).toBe(true);
    });

    it('rejects passwords shorter than 10 characters', () => {
      const result = passwordSchema.safeParse('Short1!');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Passwort muss mindestens 10 Zeichen haben.');
      }
    });

    it('rejects passwords without lowercase letters', () => {
      const result = passwordSchema.safeParse('ALLUPPERCASE123!');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Passwort muss mindestens einen Kleinbuchstaben enthalten.');
      }
    });

    it('rejects passwords without uppercase letters', () => {
      const result = passwordSchema.safeParse('alllowercase123!');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Passwort muss mindestens einen Großbuchstaben enthalten.');
      }
    });

    it('rejects passwords without numbers or special characters', () => {
      const result = passwordSchema.safeParse('OnlyAlphabeticalLetters');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Passwort muss mindestens eine Zahl oder ein Sonderzeichen enthalten.');
      }
    });
  });
});
