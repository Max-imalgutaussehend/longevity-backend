import { describe, it, expect } from 'vitest';
import { suggestLevers } from '../index.js';
import type { ScoreInput } from '../types.js';
import emptyFixture from './__fixtures__/empty.json';
import demoFixture from './__fixtures__/demo.json';

const toInput = (f: unknown): ScoreInput => f as ScoreInput;

describe('suggestLevers (#95)', () => {
  it('suggests no levers for metrics the user has never recorded a value for', () => {
    const input = toInput(emptyFixture);
    const levers = suggestLevers(input);

    expect(levers).toHaveLength(0);
  });

  it('never proposes a cohort-mean-only lever with zero real samples', () => {
    const levers = suggestLevers(toInput(emptyFixture));
    const nonSmokingWithoutData = levers.filter((l) => l.metric !== 'smoking' && l.currentValue === null);
    expect(nonSmokingWithoutData).toHaveLength(0);
  });

  it('still suggests levers for metrics the user does have data for', () => {
    const levers = suggestLevers(toInput(demoFixture));
    expect(levers.length).toBeGreaterThan(0);
    for (const lever of levers) {
      expect(lever.currentValue).not.toBeNull();
    }
  });

  it('uses the newest sample, not an older sample in the array', () => {
    const now = new Date('2026-09-27T12:00:00.000Z');
    const input: ScoreInput = {
      profile: { birthDate: '1995-01-01', sex: 'm' },
      now,
      samples: [
        // Old sample first in array
        { metric: 'vo2max', value: 32, unit: 'ml/kg/min', measuredAt: '2026-09-01T00:00:00.000Z', sourceKind: 'apple_health' },
        // Newer sample later in array
        { metric: 'vo2max', value: 40, unit: 'ml/kg/min', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'apple_health' },
      ],
    };

    const levers = suggestLevers(input);
    const vo2Lever = levers.find(l => l.metric === 'vo2max');
    expect(vo2Lever).toBeDefined();
    expect(vo2Lever?.currentValue).toBe(40);
  });

  it('ignores stale samples older than half-life threshold (freshness < 0.05)', () => {
    const now = new Date('2026-09-27T12:00:00.000Z');
    const input: ScoreInput = {
      profile: { birthDate: '1995-01-01', sex: 'm' },
      now,
      samples: [
        // 400 days old sample (half-life 14 days -> freshness ~ 0)
        { metric: 'vo2max', value: 30, unit: 'ml/kg/min', measuredAt: '2025-08-01T00:00:00.000Z', sourceKind: 'apple_health' },
      ],
    };

    const levers = suggestLevers(input);
    expect(levers.find(l => l.metric === 'vo2max')).toBeUndefined();
  });

  describe('Smoking logic (#95)', () => {
    it('does NOT propose a smoking lever for never-smokers (category 0)', () => {
      const input: ScoreInput = {
        profile: { birthDate: '1995-01-01', sex: 'm' },
        now: new Date('2026-09-27T12:00:00.000Z'),
        samples: [
          { metric: 'smoking', value: 0, unit: 'category', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'questionnaire' },
        ],
      };

      const levers = suggestLevers(input);
      expect(levers.find(l => l.metric === 'smoking')).toBeUndefined();
    });

    it('does NOT propose a smoking lever for former smokers > 1 year (category 1)', () => {
      const input: ScoreInput = {
        profile: { birthDate: '1995-01-01', sex: 'm' },
        now: new Date('2026-09-27T12:00:00.000Z'),
        samples: [
          { metric: 'smoking', value: 1, unit: 'category', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'questionnaire' },
        ],
      };

      const levers = suggestLevers(input);
      expect(levers.find(l => l.metric === 'smoking')).toBeUndefined();
    });

    it('proposes target 2 (quit smoking) with 12 weeks horizon for current smokers (category 3)', () => {
      const input: ScoreInput = {
        profile: { birthDate: '1995-01-01', sex: 'm' },
        now: new Date('2026-09-27T12:00:00.000Z'),
        samples: [
          { metric: 'smoking', value: 3, unit: 'category', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'questionnaire' },
        ],
      };

      const levers = suggestLevers(input);
      const smokingLever = levers.find(l => l.metric === 'smoking');
      expect(smokingLever).toBeDefined();
      expect(smokingLever?.currentValue).toBe(3);
      expect(smokingLever?.targetValue).toBe(2);
      expect(smokingLever?.horizonWeeks).toBe(12);
      expect(smokingLever?.delta).toBeGreaterThan(0);
    });

    it('proposes target 1 (maintain smoke-free > 1 year) with 52 weeks horizon for former smokers < 1 year (category 2)', () => {
      const input: ScoreInput = {
        profile: { birthDate: '1995-01-01', sex: 'm' },
        now: new Date('2026-09-27T12:00:00.000Z'),
        samples: [
          { metric: 'smoking', value: 2, unit: 'category', measuredAt: '2026-09-26T00:00:00.000Z', sourceKind: 'questionnaire' },
        ],
      };

      const levers = suggestLevers(input);
      const smokingLever = levers.find(l => l.metric === 'smoking');
      expect(smokingLever).toBeDefined();
      expect(smokingLever?.currentValue).toBe(2);
      expect(smokingLever?.targetValue).toBe(1);
      expect(smokingLever?.horizonWeeks).toBe(52);
      expect(smokingLever?.delta).toBeGreaterThan(0);
    });
  });
});
