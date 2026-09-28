import { describe, it, expect } from 'vitest';
import { countStrengthSessions, zone2MinutesPerWeek } from '../../adapters/strava.js';
import activitiesFixture from '../__fixtures__/strava_activities.json';

describe('countStrengthSessions', () => {
  it('aggregates WeightTraining/CrossFit activities per calendar week', () => {
    const samples = countStrengthSessions(activitiesFixture);

    expect(samples).toHaveLength(2);
    expect(samples.every((s) => s.metric === 'strength_sessions')).toBe(true);
    expect(samples.every((s) => s.sourceKind === 'strava')).toBe(true);

    const values = samples.map((s) => s.value).sort((a, b) => a - b);
    expect(values).toEqual([1, 2]);
  });

  it('ignores non-strength activity types', () => {
    const samples = countStrengthSessions([
      { id: 1, type: 'Run', start_date: '2024-06-04T07:00:00Z', has_heartrate: true },
    ]);
    expect(samples).toHaveLength(0);
  });

  it('returns an empty array for no activities', () => {
    expect(countStrengthSessions([])).toEqual([]);
  });
});

describe('zone2MinutesPerWeek', () => {
  it('extracts the zone-2 (index 1) heart-rate bucket time in minutes for a single activity', () => {
    const samples = zone2MinutesPerWeek([{
      startDate: '2024-06-04T07:00:00Z',
      zones: {
        heart_rate: {
          distribution_buckets: [
            { min: 0, max: 100, time: 300 },
            { min: 100, max: 130, time: 900 },
            { min: 130, max: 150, time: 600 },
          ],
        },
      },
    }]);

    expect(samples).toHaveLength(1);
    expect(samples[0].metric).toBe('zone2_minutes');
    expect(samples[0].value).toBeCloseTo(15, 5);
    expect(samples[0].sourceKind).toBe('strava');
  });

  it('ignores activities with missing heart_rate zones', () => {
    expect(zone2MinutesPerWeek([{ startDate: '2024-06-04T07:00:00Z', zones: {} }])).toEqual([]);
  });

  it('sums zone-2 minutes from multiple activities within the same calendar week', () => {
    const zones = {
      heart_rate: { distribution_buckets: [{ min: 0, max: 100, time: 0 }, { min: 100, max: 130, time: 600 }] },
    };
    // 2024-06-04 (Tue) and 2024-06-06 (Thu) fall in the same week (starting Sunday 2024-06-02)
    const samples = zone2MinutesPerWeek([
      { startDate: '2024-06-04T07:00:00Z', zones },
      { startDate: '2024-06-06T07:00:00Z', zones },
    ]);

    expect(samples).toHaveLength(1);
    expect(samples[0].value).toBeCloseTo(20, 5); // 10 min + 10 min
  });

  it('keeps separate weeks as separate samples', () => {
    const zones = {
      heart_rate: { distribution_buckets: [{ min: 0, max: 100, time: 0 }, { min: 100, max: 130, time: 600 }] },
    };
    const samples = zone2MinutesPerWeek([
      { startDate: '2024-06-04T07:00:00Z', zones }, // week of 2024-06-02
      { startDate: '2024-06-11T07:00:00Z', zones }, // week of 2024-06-09
    ]);

    expect(samples).toHaveLength(2);
  });
});
