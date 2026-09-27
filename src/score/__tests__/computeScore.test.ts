import { describe, it, expect } from 'vitest';
import { computeScore } from '../index.js';
import type { ScoreInput } from '../types.js';

describe('computeScore — Target-Metriken & Plausibilitätsabstrafungen', () => {
  const baseProfile: ScoreInput['profile'] = { birthDate: '1995-01-01', sex: 'm' };
  const baseNow = new Date('2026-09-27T12:00:00.000Z');

  describe('sleep_duration as target metric (target 7.5h, sigma 0.9)', () => {
    it('gives optimal z = 0 (percentile 50) when sleep is exactly at target 7.5h', () => {
      const input: ScoreInput = {
        profile: baseProfile,
        now: baseNow,
        samples: [
          { metric: 'sleep_duration', value: 7.5, unit: 'h', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'oura' },
        ],
      };
      const result = computeScore(input);
      const sleepMetric = result.domains.flatMap(d => d.metrics).find(m => m.metric === 'sleep_duration');

      expect(sleepMetric).toBeDefined();
      expect(sleepMetric?.z).toBeCloseTo(0, 5);
      expect(sleepMetric?.percentile).toBe(50);
    });

    it('penalizes excessive sleep duration (e.g. 14h) with clamped negative z = -3', () => {
      const input: ScoreInput = {
        profile: baseProfile,
        now: baseNow,
        samples: [
          { metric: 'sleep_duration', value: 14.0, unit: 'h', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'oura' },
        ],
      };
      const result = computeScore(input);
      const sleepMetric = result.domains.flatMap(d => d.metrics).find(m => m.metric === 'sleep_duration');

      expect(sleepMetric).toBeDefined();
      expect(sleepMetric?.z).toBe(-3);
      expect(sleepMetric?.percentile).toBeLessThanOrEqual(1);
    });

    it('penalizes insufficient sleep duration (e.g. 4.0h) symmetrically', () => {
      const input: ScoreInput = {
        profile: baseProfile,
        now: baseNow,
        samples: [
          { metric: 'sleep_duration', value: 4.0, unit: 'h', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'oura' },
        ],
      };
      const result = computeScore(input);
      const sleepMetric = result.domains.flatMap(d => d.metrics).find(m => m.metric === 'sleep_duration');

      expect(sleepMetric).toBeDefined();
      // |4.0 - 7.5| = 3.5; 3.5 / 0.9 = 3.88 -> clamped to -3
      expect(sleepMetric?.z).toBe(-3);
      expect(sleepMetric?.percentile).toBeLessThanOrEqual(1);
    });

    it('computes z = -|v - 7.5| / 0.9 accurately for moderate deviations', () => {
      const input: ScoreInput = {
        profile: baseProfile,
        now: baseNow,
        samples: [
          { metric: 'sleep_duration', value: 6.6, unit: 'h', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'oura' },
        ],
      };
      const result = computeScore(input);
      const sleepMetric = result.domains.flatMap(d => d.metrics).find(m => m.metric === 'sleep_duration');

      // |6.6 - 7.5| = 0.9 -> z = -0.9 / 0.9 = -1.0
      expect(sleepMetric?.z).toBeCloseTo(-1.0, 5);
      expect(sleepMetric?.percentile).toBe(16); // Phi(-1.0) * 100 = 15.87 -> 16
    });
  });

  describe('Pathological extreme value penalties', () => {
    it('resting_hr < 40 bpm receives z = -3 penalty instead of best note', () => {
      const input: ScoreInput = {
        profile: baseProfile,
        now: baseNow,
        samples: [
          { metric: 'resting_hr', value: 28, unit: 'bpm', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'apple_health' },
        ],
      };
      const result = computeScore(input);
      const rhr = result.domains.flatMap(d => d.metrics).find(m => m.metric === 'resting_hr');

      expect(rhr?.z).toBe(-3);
      expect(rhr?.percentile).toBeLessThanOrEqual(1);
    });

    it('resting_hr >= 40 bpm computes normally without penalty', () => {
      const input: ScoreInput = {
        profile: baseProfile,
        now: baseNow,
        samples: [
          { metric: 'resting_hr', value: 45, unit: 'bpm', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'apple_health' },
        ],
      };
      const result = computeScore(input);
      const rhr = result.domains.flatMap(d => d.metrics).find(m => m.metric === 'resting_hr');

      // Male mu = 66, sigma = 9 -> z = (66 - 45) / 9 = 2.33
      expect(rhr?.z).toBeCloseTo(2.333, 2);
      expect(rhr?.percentile).toBeGreaterThan(90);
    });

    it('systolic_bp < 90 mmHg receives z = -3 penalty instead of best note', () => {
      const input: ScoreInput = {
        profile: baseProfile,
        now: baseNow,
        samples: [
          { metric: 'systolic_bp', value: 65, unit: 'mmHg', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'lab' },
        ],
      };
      const result = computeScore(input);
      const bp = result.domains.flatMap(d => d.metrics).find(m => m.metric === 'systolic_bp');

      expect(bp?.z).toBe(-3);
      expect(bp?.percentile).toBeLessThanOrEqual(1);
    });

    it('systolic_bp >= 90 mmHg computes normally without penalty', () => {
      const input: ScoreInput = {
        profile: baseProfile,
        now: baseNow,
        samples: [
          { metric: 'systolic_bp', value: 95, unit: 'mmHg', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'lab' },
        ],
      };
      const result = computeScore(input);
      const bp = result.domains.flatMap(d => d.metrics).find(m => m.metric === 'systolic_bp');

      expect(bp?.z).toBeGreaterThan(0);
      expect(bp?.percentile).toBeGreaterThan(50);
    });

    it('waist < 60 cm receives z = -3 penalty instead of best note', () => {
      const input: ScoreInput = {
        profile: baseProfile,
        now: baseNow,
        samples: [
          { metric: 'waist', value: 40, unit: 'cm', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'lab' },
        ],
      };
      const result = computeScore(input);
      const waist = result.domains.flatMap(d => d.metrics).find(m => m.metric === 'waist');

      expect(waist?.z).toBe(-3);
      expect(waist?.percentile).toBeLessThanOrEqual(1);
    });

    it('waist >= 60 cm computes normally without penalty', () => {
      const input: ScoreInput = {
        profile: baseProfile,
        now: baseNow,
        samples: [
          { metric: 'waist', value: 75, unit: 'cm', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'lab' },
        ],
      };
      const result = computeScore(input);
      const waist = result.domains.flatMap(d => d.metrics).find(m => m.metric === 'waist');

      expect(waist?.z).toBeGreaterThan(0);
      expect(waist?.percentile).toBeGreaterThan(50);
    });
  });

  describe('Engine Version', () => {
    it('reports engineVersion 0.2.0', () => {
      const input: ScoreInput = {
        profile: baseProfile,
        now: baseNow,
        samples: [],
      };
      const result = computeScore(input);
      expect(result.engineVersion).toBe('0.2.0');
    });
  });
});
