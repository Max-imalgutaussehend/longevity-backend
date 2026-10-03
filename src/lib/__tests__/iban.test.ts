import { describe, it, expect } from 'vitest';
import { isValidIban, maskIban } from '../iban.js';

describe('IBAN validation and masking', () => {
  it('validates correct German IBANs', () => {
    expect(isValidIban('DE89370501980000012345')).toBe(true);
    expect(isValidIban('DE89 3705 0198 0000 0123 45')).toBe(true);
  });

  it('rejects invalid or too short IBANs', () => {
    expect(isValidIban('')).toBe(false);
    expect(isValidIban('DE123')).toBe(false);
    expect(isValidIban('1234567890')).toBe(false);
    expect(isValidIban('DE89XYZ')).toBe(false);
  });

  it('masks IBAN properly leaving first 4 and last 4 visible', () => {
    expect(maskIban('DE89370501980000012345')).toBe('DE89 •••• •••• •••• 2345');
    expect(maskIban('DE89 3705 0198 0000 0123 45')).toBe('DE89 •••• •••• •••• 2345');
  });

  it('handles short or empty strings safely', () => {
    expect(maskIban('')).toBe('');
    expect(maskIban('DE8912')).toBe('DE8912');
  });
});
