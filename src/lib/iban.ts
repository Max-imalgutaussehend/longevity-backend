/**
 * IBAN formatting and validation utilities for Longevity benefit payouts.
 */

export function isValidIban(iban: string): boolean {
  if (!iban) return false;
  const clean = iban.replace(/\s+/g, '').toUpperCase();
  // SEPA / international IBAN format: 2 letters, 2 digits, followed by 11 to 30 alphanumeric chars
  return /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(clean);
}

export function maskIban(iban: string): string {
  if (!iban) return '';
  const clean = iban.replace(/\s+/g, '').toUpperCase();
  if (clean.length <= 8) return clean;
  const start = clean.slice(0, 4);
  const end = clean.slice(-4);
  return `${start} •••• •••• •••• ${end}`;
}
