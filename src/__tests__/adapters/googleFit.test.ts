import { describe, it, expect } from 'vitest';
import { parseGoogleFitAggregate, parseGoogleHealthV4DataPoints, type GoogleFitAggregateResponse } from '../../adapters/googleFit.js';
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

describe('parseGoogleHealthV4DataPoints', () => {
  it('parses steps data points', () => {
    const samples = parseGoogleHealthV4DataPoints('steps', [
      { steps: { count: '7500', interval: { startTime: '2026-09-13T00:00:00Z', endTime: '2026-09-13T23:59:59Z' } } },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      metric: 'steps',
      value: 7500,
      unit: 'steps',
      sourceKind: 'google_fit',
    });
  });

  it('parses daily-resting-heart-rate data points', () => {
    const samples = parseGoogleHealthV4DataPoints('daily-resting-heart-rate', [
      { dailyRestingHeartRate: { beatsPerMinute: '56', date: { year: 2026, month: 9, day: 13 } } },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      metric: 'resting_hr',
      value: 56,
      unit: 'bpm',
      sourceKind: 'google_fit',
    });
  });

  it('parses sleep data points and calculates duration', () => {
    const samples = parseGoogleHealthV4DataPoints('sleep', [
      { sleep: { interval: { startTime: '2026-09-13T00:00:00Z', endTime: '2026-09-13T08:00:00Z' } } },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0].metric).toBe('sleep_duration');
    expect(samples[0].value).toBe(8);
    expect(samples[0].unit).toBe('h');
  });

  it('parses active-minutes data points', () => {
    const samples = parseGoogleHealthV4DataPoints('active-minutes', [
      {
        activeMinutes: {
          interval: { startTime: '2026-09-13T08:00:00Z', endTime: '2026-09-13T09:00:00Z' },
          activeMinutesByActivityLevel: [{ activeMinutes: 30 }, { activeMinutes: 15 }],
        },
      },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      metric: 'zone2_minutes',
      value: 45,
      unit: 'min',
    });
  });

  it('aggregates multiple step interval data points per day into a single daily total', () => {
    const samples = parseGoogleHealthV4DataPoints('steps', [
      {
        steps: {
          count: '1500',
          interval: {
            startTime: '2026-09-13T08:00:00Z',
            endTime: '2026-09-13T08:30:00Z',
            civilStartTime: { date: { year: 2026, month: 9, day: 13 } },
          },
        },
      },
      {
        steps: {
          count: '3200',
          interval: {
            startTime: '2026-09-13T12:00:00Z',
            endTime: '2026-09-13T13:00:00Z',
            civilStartTime: { date: { year: 2026, month: 9, day: 13 } },
          },
        },
      },
      {
        steps: {
          count: '8000',
          interval: {
            startTime: '2026-09-12T10:00:00Z',
            endTime: '2026-09-12T11:00:00Z',
            civilStartTime: { date: { year: 2026, month: 9, day: 12 } },
          },
        },
      },
    ]);

    expect(samples).toHaveLength(2);
    const day13 = samples.find(s => s.measuredAt.startsWith('2026-09-13'));
    const day12 = samples.find(s => s.measuredAt.startsWith('2026-09-12'));
    expect(day13?.value).toBe(4700);
    expect(day12?.value).toBe(8000);
  });

  it('parses strength exercise into strength_sessions', () => {
    const samples = parseGoogleHealthV4DataPoints('exercise', [
      {
        exercise: {
          exerciseType: 'WEIGHTLIFTING',
          displayName: 'Krafttraining',
          interval: { startTime: '2026-09-13T14:00:00Z', endTime: '2026-09-13T15:00:00Z' },
        },
      },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      metric: 'strength_sessions',
      value: 1,
      unit: '/week',
    });
  });

  it('parses exercise with activeDuration into zone2_minutes', () => {
    const samples = parseGoogleHealthV4DataPoints('exercise', [
      {
        exercise: {
          exerciseType: 'WALKING',
          displayName: 'Gehen',
          activeDuration: '1800s', // 30 min
          interval: { startTime: '2026-09-13T16:00:00Z', endTime: '2026-09-13T16:30:00Z' },
        },
      },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      metric: 'zone2_minutes',
      value: 30,
      unit: 'min',
    });
  });
});

