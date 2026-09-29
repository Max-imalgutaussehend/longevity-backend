import { createHmac } from 'node:crypto';
import { hash, verify, Algorithm, type Options } from '@node-rs/argon2';
import { z } from 'zod';

/**
 * OWASP-konforme Argon2id-Konfiguration:
 * - Algorithmus: Argon2id (kombiniert Side-Channel- und GPU-Resistenz)
 * - MemoryCost: 19456 KiB (~19 MiB gem. OWASP Password Storage Cheat Sheet)
 * - TimeCost: 2 Iterationen
 * - Parallelism: 1 Thread
 */
export const ARGON2_OPTIONS: Options = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  algorithm: Algorithm.Argon2id,
};

/**
 * Zod-Validierung für Passwörter:
 * - mindestens 10 Zeichen
 * - Groß- und Kleinbuchstaben
 * - Zahlen oder Sonderzeichen
 */
export const passwordSchema = z.string()
  .min(10, 'Passwort muss mindestens 10 Zeichen haben.')
  .regex(/[a-z]/, 'Passwort muss mindestens einen Kleinbuchstaben enthalten.')
  .regex(/[A-Z]/, 'Passwort muss mindestens einen Großbuchstaben enthalten.')
  .regex(/[\d\W_]/, 'Passwort muss mindestens eine Zahl oder ein Sonderzeichen enthalten.');

const DEFAULT_PEPPER = 'longevity-default-pepper-secret-32b-long!';

/**
 * Kombiniert das Passwort vor dem Hashing per HMAC-SHA256 mit dem Server-Pepper.
 * Das Resultat ist ein hex-kodierter String, der UTF-8-kompatibel für Argon2 ist.
 */
export function pepperPassword(password: string): string {
  const pepper = process.env.PASSWORD_PEPPER || DEFAULT_PEPPER;
  return createHmac('sha256', pepper).update(password).digest('hex');
}

/**
 * Hashes a plaintext password using HMAC-SHA256 server pepper and Argon2id.
 */
export async function hashPassword(password: string): Promise<string> {
  const peppered = pepperPassword(password);
  return hash(peppered, ARGON2_OPTIONS);
}

/**
 * Verifies a plaintext password against an Argon2id hash.
 * Supports transparent fallback to unpeppered verification for existing/legacy hashes,
 * and to the hardcoded default pepper for accounts hashed before an individual
 * PASSWORD_PEPPER was deployed to the environment.
 */
export async function verifyPassword(hashStr: string, password: string): Promise<boolean> {
  const peppered = pepperPassword(password);
  const ok = await verify(hashStr, peppered).catch(() => false);
  if (ok) return true;

  // Fallback für Hashes, die mit dem Default-Pepper erzeugt wurden, bevor ein
  // individueller PASSWORD_PEPPER in der Umgebung gesetzt wurde.
  const defaultPeppered = createHmac('sha256', DEFAULT_PEPPER).update(password).digest('hex');
  const okDefault = await verify(hashStr, defaultPeppered).catch(() => false);
  if (okDefault) return true;

  // Fallback für unpepperte Legacy-Hashes
  return verify(hashStr, password).catch(() => false);
}
