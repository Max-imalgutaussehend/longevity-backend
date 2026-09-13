import { describe, it, expect } from 'vitest';
import { parseGoogleFitAggregate, type GoogleFitAggregateResponse } from '../../adapters/googleFit.js';
import rawFixture from '../__fixtures__/google_fit_aggregate.json';

const fixture = rawFixture as GoogleFitAggregateResponse;

describe('parseGoogleFitAggregate', () => {
  it('maps step_count.delta to steps', () => {
    const samples = parseGoogleFitAggregate(fixture);
    const steps = samples.filter(s => s.metric === 'steps');

    expect(steps).toHaveLength(1);
    expect(steps[0].value).toBe(8421);
    expect(steps[0].unit).toBe('steps');
    expect(steps[0].sourceKind).toBe('google_fit');
  });

  it('maps heart_rate.bpm to resting_hr', () => {
    const samples = parseGoogleFitAggregate(fixture);
    const hr = samples.filter(s => s.metric === 'resting_hr');

    expect(hr).toHaveLength(1);
    expect(hr[0].value).toBe(58.5);
    expect(hr[0].unit).toBe('bpm');
  });

  it('converts sleep.segment start/end nanos into hours', () => {
    const samples = parseGoogleFitAggregate(fixture);
    const sleep = samples.filter(s => s.metric === 'sleep_duration');

    expect(sleep).toHaveLength(1);
    expect(sleep[0].value).toBeCloseTo(7.5, 5);
    expect(sleep[0].unit).toBe('h');
  });

  it('maps active_minutes to zone2_minutes', () => {
    const samples = parseGoogleFitAggregate(fixture);
    const zone2 = samples.filter(s => s.metric === 'zone2_minutes');

    expect(zone2).toHaveLength(1);
    expect(zone2[0].value).toBe(42);
    expect(zone2[0].unit).toBe('min');
  });

  it('returns an empty array for an empty bucket list', () => {
    expect(parseGoogleFitAggregate({ bucket: [] })).toEqual([]);
  });

  it('skips points with no usable value', () => {
    const samples = parseGoogleFitAggregate({
      bucket: [{
        startTimeMillis: '0', endTimeMillis: '0',
        dataset: [{
          dataSourceId: 'x',
          point: [{ startTimeNanos: '0', endTimeNanos: '0', dataTypeName: 'com.google.step_count.delta', value: [] }],
        }],
      }],
    });
    expect(samples).toEqual([]);
  });
});
