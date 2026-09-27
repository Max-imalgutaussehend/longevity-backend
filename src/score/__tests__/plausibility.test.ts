import { describe, it, expect } from 'vitest';
import { isSamplePlausible, filterPlausibleSamples, METRIC_PLAUSIBILITY_BOUNDS } from '../plausibility.js';

describe('Physiological Plausibility Filter', () => {
  it('accepts normal resting heart rate and flags impossible values', () => {
    expect(isSamplePlausible('resting_hr', 60)).toBe(true);
    expect(isSamplePlausible('resting_hr', 42)).toBe(true);
    // Extreme unrealistic values
    expect(isSamplePlausible('resting_hr', 10)).toBe(false);
    expect(isSamplePlausible('resting_hr', 280)).toBe(false);
    expect(isSamplePlausible('resting_hr', NaN)).toBe(false);
  });

  it('flags fraudulent step counts (e.g. mechanical shaker > 65k)', () => {
    expect(isSamplePlausible('steps', 10000)).toBe(true);
    expect(isSamplePlausible('steps', 35000)).toBe(true);
    expect(isSamplePlausible('steps', 95000)).toBe(false);
    expect(isSamplePlausible('steps', -100)).toBe(false);
  });

  it('filters an array of mixed samples', () => {
    const raw = [
      { metric: 'steps', value: 12000 },
      { metric: 'steps', value: 150000 }, // fraud
      { metric: 'resting_hr', value: 55 },
      { metric: 'resting_hr', value: 5 }, // impossible
      { metric: 'vo2max', value: 45 },
    ];

    const result = filterPlausibleSamples(raw);
    expect(result.plausible.length).toBe(3);
    expect(result.implausibleCount).toBe(2);
    expect(result.plausible.map(s => s.metric)).toEqual(['steps', 'resting_hr', 'vo2max']);
  });

  it('has bounds defined for all primary score metrics', () => {
    expect(METRIC_PLAUSIBILITY_BOUNDS.vo2max).toBeDefined();
    expect(METRIC_PLAUSIBILITY_BOUNDS.systolic_bp).toBeDefined();
    expect(METRIC_PLAUSIBILITY_BOUNDS.sleep_duration).toBeDefined();
    expect(METRIC_PLAUSIBILITY_BOUNDS.hrv_rmssd).toBeDefined();
  });
});
