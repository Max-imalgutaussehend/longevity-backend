import { describe, it, expect } from 'vitest';
import {
  verifyEmailTemplate,
  passwordResetTemplate,
  insurerInviteTemplate,
  insurerRequestReceivedTemplate,
  weeklyReportTemplate,
} from '../emailTemplates.js';

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

  it('includes the company name in the insurer request received template', () => {
    const { subject, html } = insurerRequestReceivedTemplate('Testkasse GmbH');
    expect(subject).toContain('eingegangen');
    expect(html).toContain('Testkasse GmbH');
  });

  it('escapes HTML-significant characters in the request received company name', () => {
    const { html } = insurerRequestReceivedTemplate('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders weekly report template with score, delta, streak, and metrics', () => {
    const { subject, html } = weeklyReportTemplate({
      displayName: 'Max <Mustermann>',
      score: 75.4,
      delta: 2.1,
      bestMetricLabel: 'VO₂max',
      worstMetricLabel: 'Rauchen',
      streakDays: 7,
      dashboardUrl: 'https://example.com/report',
    });
    expect(subject).toContain('Score: 75');
    expect(html).toContain('Hallo Max &lt;Mustermann&gt;,');
    expect(html).toContain('75');
    expect(html).toContain('+2.1 Pkt.');
    expect(html).toContain('VO₂max');
    expect(html).toContain('Rauchen');
    expect(html).toContain('7 Tage');
    expect(html).toContain('https://example.com/report');
  });
});
