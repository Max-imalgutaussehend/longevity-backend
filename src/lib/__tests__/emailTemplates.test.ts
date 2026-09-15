import { describe, it, expect } from 'vitest';
import { verifyEmailTemplate, passwordResetTemplate, insurerInviteTemplate } from '../emailTemplates.js';

describe('email templates', () => {
  it('embeds the verify URL in both the button and the fallback link', () => {
    const { subject, html } = verifyEmailTemplate('https://example.com/verify-email/abc123');
    expect(subject).toBe('Bitte bestätige deine E-Mail-Adresse');
    const occurrences = html.match(/https:\/\/example\.com\/verify-email\/abc123/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('embeds the reset URL in both the button and the fallback link', () => {
    const { subject, html } = passwordResetTemplate('https://example.com/reset-password/xyz789');
    expect(subject).toBe('Passwort zurücksetzen');
    const occurrences = html.match(/https:\/\/example\.com\/reset-password\/xyz789/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('includes the organization name and invite URL in the insurer invite template', () => {
    const { subject, html } = insurerInviteTemplate('Testkasse GmbH', 'https://example.com/insurer-invite/tok');
    expect(subject).toContain('Krankenkassen');
    expect(html).toContain('Testkasse GmbH');
    const occurrences = html.match(/https:\/\/example\.com\/insurer-invite\/tok/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('escapes HTML-significant characters in the organization name', () => {
    const { html } = insurerInviteTemplate('<script>alert(1)</script> & "Kasse"', 'https://example.com/x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;Kasse&quot;');
  });
});
