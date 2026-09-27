import { describe, it, expect, beforeAll } from 'vitest';
import { filterPlausibleSamples, isSamplePlausible } from '../score/plausibility.js';

type DetermineTrustFn = typeof import('../routes/helpers.js').determineSourceTrustLevel;

describe('Health Insurance Verified Data & Fraud Prevention (#88)', () => {
  let determineSourceTrustLevel: DetermineTrustFn;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';
    const helpers = await import('../routes/helpers.js');
    determineSourceTrustLevel = helpers.determineSourceTrustLevel;
  });
  describe('Source Trust Level Classification', () => {
    it('classifies mock adapter as trust level "mock"', () => {
      expect(determineSourceTrustLevel('mock', null)).toBe('mock');
      expect(determineSourceTrustLevel('mock', { accessToken: '123' })).toBe('mock');
    });

    it('classifies manual and upload adapters as "unverified"', () => {
      expect(determineSourceTrustLevel('upload', null)).toBe('unverified');
      expect(determineSourceTrustLevel('manual', null)).toBe('unverified');
      expect(determineSourceTrustLevel('questionnaire', null)).toBe('unverified');
    });

    it('classifies unknown or upload adapters with metadata/credentials strictly as "unverified"', () => {
      expect(determineSourceTrustLevel('upload', { someKey: 'data' })).toBe('unverified');
      expect(determineSourceTrustLevel('custom_adapter', { apiKey: 'secret' })).toBe('unverified');
    });

    it('classifies cloud OAuth providers with credentials as "cloud_verified"', () => {
      expect(determineSourceTrustLevel('withings', { accessToken: 'token' })).toBe('cloud_verified');
      expect(determineSourceTrustLevel('oura', { accessToken: 'token' })).toBe('cloud_verified');
      expect(determineSourceTrustLevel('strava', { accessToken: 'token' })).toBe('cloud_verified');
      expect(determineSourceTrustLevel('google-fit', { accessToken: 'token' })).toBe('cloud_verified');
      expect(determineSourceTrustLevel('google-health', { accessToken: 'token' })).toBe('cloud_verified');
    });

    it('classifies FHIR laboratory bundles as "certified_medical"', () => {
      expect(determineSourceTrustLevel('fhir', null)).toBe('certified_medical');
    });
  });

  describe('Anti-Fraud Plausibility Boundary Checks', () => {
    it('rejects biologically impossible step counts (mechanical shakers)', () => {
      expect(isSamplePlausible('steps', 10000)).toBe(true);
      expect(isSamplePlausible('steps', 35000)).toBe(true);
      expect(isSamplePlausible('steps', 80000)).toBe(false);
      expect(isSamplePlausible('steps', 250000)).toBe(false);
    });

    it('rejects impossible heart rate readings', () => {
      expect(isSamplePlausible('resting_hr', 55)).toBe(true);
      expect(isSamplePlausible('resting_hr', 30)).toBe(false); // under 32
      expect(isSamplePlausible('resting_hr', 240)).toBe(false); // over 220
    });

    it('filters corrupted samples before calculating official scores', () => {
      const mixedSamples = [
        { metric: 'steps', value: 10000 },
        { metric: 'steps', value: 999999 }, // fraud
        { metric: 'resting_hr', value: 58 },
        { metric: 'resting_hr', value: 5 }, // sensor error
      ];

      const { plausible, implausibleCount } = filterPlausibleSamples(mixedSamples);
      expect(implausibleCount).toBe(2);
      expect(plausible.length).toBe(2);
      expect(plausible.map(s => s.metric)).toEqual(['steps', 'resting_hr']);
    });
  });
});
