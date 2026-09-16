import { describe, it, expect } from 'vitest';
import { parseWithingsMeasures, parseWithingsActivity, parseWithingsSleep, type WithingsMeasureResponse } from '../../adapters/withings.js';
import rawFixture from '../__fixtures__/withings_getmeas.json';

const fixture = rawFixture as WithingsMeasureResponse;

describe('parseWithingsMeasures', () => {
  it('maps type 9 to systolic_bp and type 11 to resting_hr, ignoring diastolic (type 10)', () => {
    const samples = parseWithingsMeasures(fixture);

    const systolic = samples.filter(s => s.metric === 'systolic_bp');
    const hr = samples.filter(s => s.metric === 'resting_hr');
    const diastolic = samples.filter(s => (s.metric as string) === 'diastolic_bp');

    expect(systolic).toHaveLength(2);
    expect(hr).toHaveLength(2);
    expect(diastolic).toHaveLength(0);
  });

  it('applies the Withings unit scale (value * 10^unit)', () => {
    const samples = parseWithingsMeasures(fixture);
    const systolic = samples.filter(s => s.metric === 'systolic_bp');

    expect(systolic[0].value).toBe(122);
    expect(systolic[1].value).toBeCloseTo(118.5, 5);
  });

  it('tags every sample with sourceKind withings', () => {
    const samples = parseWithingsMeasures(fixture);
    expect(samples.every(s => s.sourceKind === 'withings')).toBe(true);
  });

  it('returns an empty array when there are no measure groups', () => {
    const samples = parseWithingsMeasures({ status: 0, body: { measuregrps: [] } });
    expect(samples).toEqual([]);
  });
});

describe('parseWithingsActivity', () => {
  it('maps steps per day', () => {
    const samples = parseWithingsActivity({
      status: 0,
      body: { activities: [{ date: '2024-06-01', steps: 8421 }] },
    });

    expect(samples).toEqual([{
      metric: 'steps',
      value: 8421,
      unit: 'steps',
      measuredAt: new Date('2024-06-01').toISOString(),
      sourceKind: 'withings',
    }]);
  });
});

describe('parseWithingsSleep', () => {
  it('converts start/end timestamps into sleep duration in hours', () => {
    const startdate = 1717200000;
    const enddate = startdate + 7.5 * 3600;

    const samples = parseWithingsSleep({ status: 0, body: { series: [{ startdate, enddate }] } });

    expect(samples).toHaveLength(1);
    expect(samples[0].metric).toBe('sleep_duration');
    expect(samples[0].value).toBeCloseTo(7.5, 5);
    expect(samples[0].sourceKind).toBe('withings');
  });

  it('safely handles invalid date values without throwing', () => {
    const samples = parseWithingsSleep({
      status: 0,
      body: { series: [{ startdate: NaN as unknown as number, enddate: NaN as unknown as number }] },
    });
    expect(samples).toHaveLength(1);
    expect(isNaN(new Date(samples[0].measuredAt).getTime())).toBe(false);
  });
});
