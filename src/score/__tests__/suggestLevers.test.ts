import { describe, it, expect } from 'vitest';
import { suggestLevers } from '../index.js';
import type { ScoreInput } from '../types.js';
import emptyFixture from './__fixtures__/empty.json';
import demoFixture from './__fixtures__/demo.json';

const toInput = (f: unknown): ScoreInput => f as ScoreInput;

describe('suggestLevers — Issue #56', () => {
  it('suggests no levers for metrics the user has never recorded a value for', () => {
    const input = toInput(emptyFixture);
    const levers = suggestLevers(input);

    // Every remaining suggestion (if any) must be for a metric with a real
    // measurement — 'smoking' is the sole deliberate no-data-default exception.
    for (const lever of levers) {
      expect(lever.metric === 'smoking' || lever.currentValue !== null).toBe(true);
    }
  });

  it('never proposes a cohort-mean-only lever (currentValue null, non-smoking) with zero real samples', () => {
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
});
