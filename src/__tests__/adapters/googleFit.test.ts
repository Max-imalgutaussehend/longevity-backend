import { describe, it, expect } from 'vitest';
import {
  parseGoogleFitAggregate,
  parseGoogleHealthV4DataPoints,
  consolidateDailyZone2Samples,
  extractGoogleHealthOrigin,
  getOriginPriority,
  type GoogleFitAggregateResponse,
} from '../../adapters/googleFit.js';
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

  it('deduplicates steps across multiple datasets in the same bucket prioritizing estimated_steps', () => {
    const samples = parseGoogleFitAggregate({
      bucket: [{
        startTimeMillis: '1726358400000',
        endTimeMillis: '1726444800000',
        dataset: [
          {
            dataSourceId: 'derived:com.google.step_count.delta:com.google.android.gms:estimated_steps',
            point: [{
              startTimeNanos: '1726358400000000000',
              endTimeNanos: '1726444800000000000',
              dataTypeName: 'com.google.step_count.delta',
              value: [{ intVal: 7360 }],
            }],
          },
          {
            dataSourceId: 'raw:com.google.step_count.delta:com.fitbit.FitBitMobile:tracker',
            point: [{
              startTimeNanos: '1726358400000000000',
              endTimeNanos: '1726444800000000000',
              dataTypeName: 'com.google.step_count.delta',
              value: [{ intVal: 9250 }],
            }],
          },
        ],
      }],
    });
    const steps = samples.filter(s => s.metric === 'steps');
    expect(steps).toHaveLength(1);
    expect(steps[0].value).toBe(7360);
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

  it('assigns past day steps to noon UTC and never in the future', () => {
    const samples = parseGoogleHealthV4DataPoints('steps', [
      {
        steps: {
          count: '5000',
          interval: {
            startTime: '2024-01-15T08:00:00Z',
            endTime: '2024-01-15T20:00:00Z',
            civilStartTime: { date: { year: 2024, month: 1, day: 15 } },
          },
        },
      },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0].measuredAt).toBe('2024-01-15T12:00:00.000Z');
    expect(new Date(samples[0].measuredAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('caps future-dated aggregate points to current time', () => {
    const farFutureNanos = String((Date.now() + 86400000) * 1_000_000);
    const samples = parseGoogleFitAggregate({
      bucket: [{
        startTimeMillis: '0',
        endTimeMillis: String(Date.now() + 86400000),
        dataset: [{
          dataSourceId: 'steps',
          point: [{
            startTimeNanos: '0',
            endTimeNanos: farFutureNanos,
            dataTypeName: 'com.google.step_count.delta',
            value: [{ intVal: 1000 }],
          }],
        }],
      }],
    });
    expect(samples).toHaveLength(1);
    expect(new Date(samples[0].measuredAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('deduplicates steps across multiple origins prioritizing Google Fit and does not sum them', () => {
    const samples = parseGoogleHealthV4DataPoints('steps', [
      {
        steps: {
          count: '12808',
          interval: {
            startTime: '2026-09-13T00:00:00Z',
            endTime: '2026-09-13T23:59:59Z',
            civilStartTime: { date: { year: 2026, month: 9, day: 13 } },
          },
        },
        metadata: {
          dataOrigin: { packageName: 'com.google.android.apps.fitness' },
        },
      },
      {
        steps: {
          count: '16215',
          interval: {
            startTime: '2026-09-13T00:00:00Z',
            endTime: '2026-09-13T23:59:59Z',
            civilStartTime: { date: { year: 2026, month: 9, day: 13 } },
          },
        },
        metadata: {
          dataOrigin: { packageName: 'com.sec.android.app.shealth' },
        },
      },
    ]);

    expect(samples).toHaveLength(1);
    expect(samples[0].value).toBe(12808);
  });

  it('does not sum full-day cumulative step records with intraday deltas', () => {
    const samples = parseGoogleHealthV4DataPoints('steps', [
      {
        steps: {
          count: '12808',
          interval: {
            startTime: '2026-09-13T00:00:00Z',
            endTime: '2026-09-13T23:59:59Z',
            civilStartTime: { date: { year: 2026, month: 9, day: 13 } },
          },
        },
      },
      {
        steps: {
          count: '4000',
          interval: {
            startTime: '2026-09-13T08:00:00Z',
            endTime: '2026-09-13T09:00:00Z',
            civilStartTime: { date: { year: 2026, month: 9, day: 13 } },
          },
        },
      },
      {
        steps: {
          count: '6000',
          interval: {
            startTime: '2026-09-13T14:00:00Z',
            endTime: '2026-09-13T15:00:00Z',
            civilStartTime: { date: { year: 2026, month: 9, day: 13 } },
          },
        },
      },
    ]);

    expect(samples).toHaveLength(1);
    expect(samples[0].value).toBe(12808);
  });

  it('aggregates multiple individual 1-minute active-minutes slices into a single daily sample', () => {
    // Simulating Google Health Connect v4 sending individual 1-minute active slices
    const rawPoints = Array.from({ length: 60 }, (_, i) => ({
      activeMinutes: {
        interval: {
          startTime: `2026-09-13T14:${String(i).padStart(2, '0')}:00Z`,
          endTime: `2026-09-13T14:${String(i).padStart(2, '0')}:59Z`,
        },
        activeMinutesByActivityLevel: [{ activeMinutes: 1 }],
      },
    }));

    const samples = parseGoogleHealthV4DataPoints('active-minutes', rawPoints);
    expect(samples).toHaveLength(1);
    expect(samples[0].value).toBe(60);
    expect(samples[0].metric).toBe('zone2_minutes');
  });

  it('consolidates daily zone2_minutes taking the maximum between exercise and active minutes', () => {
    const rawSamples = [
      {
        metric: 'zone2_minutes' as const,
        value: 98.7,
        unit: 'min',
        measuredAt: '2026-09-13T12:00:00.000Z',
        sourceKind: 'google_fit' as const,
      },
      {
        metric: 'zone2_minutes' as const,
        value: 120,
        unit: 'min',
        measuredAt: '2026-09-13T12:00:00.000Z',
        sourceKind: 'google_fit' as const,
      },
      {
        metric: 'steps' as const,
        value: 12808,
        unit: 'steps',
        measuredAt: '2026-09-13T12:00:00.000Z',
        sourceKind: 'google_fit' as const,
      },
    ];

    const consolidated = consolidateDailyZone2Samples(rawSamples);
    const zone2 = consolidated.filter(s => s.metric === 'zone2_minutes');
    expect(zone2).toHaveLength(1);
    expect(zone2[0].value).toBe(120);

    const steps = consolidated.filter(s => s.metric === 'steps');
    expect(steps).toHaveLength(1);
    expect(steps[0].value).toBe(12808);
  });

  it('deduplicates multi-source Google Health v4 step data with dataSource metadata to 7360 instead of 25860', () => {
    const samples = parseGoogleHealthV4DataPoints('steps', [
      {
        steps: {
          count: '7360',
          interval: {
            startTime: '2026-09-15T00:00:00Z',
            endTime: '2026-09-15T23:59:59Z',
            civilStartTime: { date: { year: 2026, month: 9, day: 15 } },
          },
        },
        dataSource: {
          platform: 'HEALTH_CONNECT',
          application: { packageName: 'com.google.android.apps.fitness' },
          device: { displayName: 'Google' },
        },
      },
      {
        steps: {
          count: '9250',
          interval: {
            startTime: '2026-09-15T00:00:00Z',
            endTime: '2026-09-15T23:59:59Z',
            civilStartTime: { date: { year: 2026, month: 9, day: 15 } },
          },
        },
        dataSource: {
          platform: 'FITBIT',
          device: { displayName: 'MobileTrack' },
        },
      },
      {
        steps: {
          count: '9250',
          interval: {
            startTime: '2026-09-15T00:00:00Z',
            endTime: '2026-09-15T23:59:59Z',
            civilStartTime: { date: { year: 2026, month: 9, day: 15 } },
          },
        },
        dataSource: {
          platform: 'HEALTH_CONNECT',
          application: { packageName: 'com.android.healthconnect.phone' },
          device: { displayName: 'Google' },
        },
      },
    ]);

    expect(samples).toHaveLength(1);
    expect(samples[0].value).toBe(7360);
    expect(samples[0].metric).toBe('steps');
  });

  it('deduplicates active-minutes across multiple origins prioritizing Google Fit', () => {
    const samples = parseGoogleHealthV4DataPoints('active-minutes', [
      {
        activeMinutes: {
          interval: { startTime: '2026-09-15T08:00:00Z', endTime: '2026-09-15T09:00:00Z' },
          activeMinutesByActivityLevel: [{ activeMinutes: 45 }],
        },
        dataSource: {
          platform: 'HEALTH_CONNECT',
          application: { packageName: 'com.google.android.apps.fitness' },
        },
      },
      {
        activeMinutes: {
          interval: { startTime: '2026-09-15T08:00:00Z', endTime: '2026-09-15T09:00:00Z' },
          activeMinutesByActivityLevel: [{ activeMinutes: 50 }],
        },
        dataSource: {
          platform: 'FITBIT',
          device: { displayName: 'MobileTrack' },
        },
      },
    ]);

    expect(samples).toHaveLength(1);
    expect(samples[0].value).toBe(45);
    expect(samples[0].metric).toBe('zone2_minutes');
  });
});

describe('extractGoogleHealthOrigin', () => {
  it('extracts packageName from dataSource application', () => {
    const origin = extractGoogleHealthOrigin({
      dataSource: { application: { packageName: 'com.google.android.apps.fitness' } },
    });
    expect(origin).toBe('com.google.android.apps.fitness');
  });

  it('extracts platform and device displayName when application is absent', () => {
    const origin = extractGoogleHealthOrigin({
      dataSource: { platform: 'FITBIT', device: { displayName: 'MobileTrack' } },
    });
    expect(origin).toBe('FITBIT:MobileTrack');
  });

  it('falls back to metadata, dataSourceId or unknown', () => {
    expect(extractGoogleHealthOrigin({ metadata: { dataOrigin: { packageName: 'custom.app' } } })).toBe('custom.app');
    expect(extractGoogleHealthOrigin({ dataSourceId: 'ds-123' })).toBe('ds-123');
    expect(extractGoogleHealthOrigin({})).toBe('unknown');
  });
});

describe('getOriginPriority', () => {
  it('prioritizes Google Fit higher than Fitbit and Health Connect', () => {
    const fit = getOriginPriority('com.google.android.apps.fitness');
    const fitbit = getOriginPriority('fitbit:mobiletrack');
    const hc = getOriginPriority('com.android.healthconnect.phone');
    const unknown = getOriginPriority('unknown');

    expect(fit).toBeGreaterThan(fitbit);
    expect(fitbit).toBeGreaterThan(hc);
    expect(hc).toBeGreaterThan(unknown);
  });
});

