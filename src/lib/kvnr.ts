import { createHmac } from 'crypto';

/**
 * Validiert eine Krankenversichertennummer (KVNR) nach dem offiziellen
 * Modulo-10-Prüfziffernverfahren der Spitzenverbände der Krankenkassen (§ 290 SGB V).
 *
 * Struktur:
 * - 10-stellig, unveränderlicher Teil: 1 Buchstabe (A–Z) + 9 Ziffern.
 * - Der Buchstabe wird in eine 2-stellige Zahl umgewandelt (A=01, B=02, ..., Z=26).
 * - Die resultierenden 10 Ziffern werden von links nach rechts alternierend
 *   mit 1, 2, 1, 2, ... gewichtet.
 * - Von zweistelligen Produkten wird die Quersumme gebildet.
 * - Die Prüfziffer ist die Differenz der Gesamtsumme zum nächsten Vielfachen von 10
 *   (bzw. 0, falls die Summe bereits ein Vielfaches von 10 ist).
 */
export function validateKvnr(kvnr: string | null | undefined): { valid: boolean; error?: string; normalized?: string } {
  if (!kvnr || typeof kvnr !== 'string') {
    return { valid: false, error: 'Krankenversichertennummer ist erforderlich.' };
  }

  const clean = kvnr.trim().toUpperCase();
  if (!clean) {
    return { valid: false, error: 'Krankenversichertennummer ist erforderlich.' };
  }

  if (!/^[A-Z]\d{9}$/.test(clean)) {
    return {
      valid: false,
      error: 'Format ungültig: 1 Buchstabe gefolgt von 9 Ziffern (z. B. A123456789).',
    };
  }

  const letterNum = (clean.charCodeAt(0) - 64).toString().padStart(2, '0');
  const digits = (letterNum + clean.slice(1, 9)).split('').map(Number);
  const weights = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];

  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const prod = digits[i] * weights[i];
    sum += prod >= 10 ? Math.floor(prod / 10) + (prod % 10) : prod;
  }

  const expectedCheckDigit = (10 - (sum % 10)) % 10;
  const actualCheckDigit = Number(clean[9]);

  if (expectedCheckDigit !== actualCheckDigit) {
    return {
      valid: false,
      error: 'Prüfziffer der Krankenversichertennummer ist ungültig.',
    };
  }

  return { valid: true, normalized: clean };
}

/**
 * Erstellt einen kryptografischen Einweg-Hash (HMAC-SHA256) der KVNR.
 * Verhindert die Speicherung von Klartext-KVNRs gemäß DSGVO Art. 9
 * und ermöglicht gleichzeitig die Sicherstellung der Eindeutigkeit (kein Mehrfach-Account).
 */
export function hashKvnr(kvnr: string, customSalt?: string): string {
  const clean = kvnr.trim().toUpperCase();
  const salt = customSalt || process.env.KVNR_SALT || process.env.SESSION_SECRET || 'longevity-kvnr-default-salt';
  return createHmac('sha256', salt).update(clean).digest('hex');
}
