import { describe, it, expect } from 'vitest';
import { countStrengthSessions, zone2MinutesFromZones } from '../../adapters/strava.js';
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

describe('zone2MinutesFromZones', () => {
  it('extracts the zone-2 (index 1) heart-rate bucket time in minutes', () => {
    const sample = zone2MinutesFromZones({
      heart_rate: {
        distribution_buckets: [
          { min: 0, max: 100, time: 300 },
          { min: 100, max: 130, time: 900 },
          { min: 130, max: 150, time: 600 },
        ],
      },
    }, '2024-06-04T07:00:00Z');

    expect(sample).not.toBeNull();
    expect(sample?.metric).toBe('zone2_minutes');
    expect(sample?.value).toBeCloseTo(15, 5);
    expect(sample?.sourceKind).toBe('strava');
  });

  it('returns null when heart_rate zones are missing', () => {
    expect(zone2MinutesFromZones({}, '2024-06-04T07:00:00Z')).toBeNull();
  });
});
