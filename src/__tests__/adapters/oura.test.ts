import { describe, it, expect } from 'vitest';
import { parseOuraSleep, parseOuraReadiness, parseOuraActivity, type OuraSleepResponse, type OuraReadinessResponse, type OuraActivityResponse } from '../../adapters/oura.js';
import sleepFixture from '../__fixtures__/oura_sleep.json';
import readinessFixture from '../__fixtures__/oura_readiness.json';
import activityFixture from '../__fixtures__/oura_activity.json';

describe('parseOuraSleep', () => {
  const fixture = sleepFixture as OuraSleepResponse;

  it('maps total_sleep_duration (seconds) to sleep_duration in hours', () => {
    const samples = parseOuraSleep(fixture);
    const durations = samples.filter((s) => s.metric === 'sleep_duration');

    expect(durations).toHaveLength(3);
    expect(durations[0].value).toBeCloseTo(7.5, 5);
    expect(durations[0].unit).toBe('h');
    expect(durations.every((s) => s.sourceKind === 'oura')).toBe(true);
  });

  it('computes sleep_consistency as the stddev of bedtimes across days', () => {
    const samples = parseOuraSleep(fixture);
    const consistency = samples.filter((s) => s.metric === 'sleep_consistency');

    expect(consistency).toHaveLength(1);
    expect(consistency[0].value).toBeGreaterThan(0);
    expect(consistency[0].unit).toBe('min');
  });

  it('handles midnight crossover gracefully without standard deviation explosion', () => {
    const samples = parseOuraSleep({
      data: [
        { day: '2024-06-01', total_sleep_duration: 27000, bedtime_start: '2024-06-01T23:45:00.000Z' },
        { day: '2024-06-02', total_sleep_duration: 27000, bedtime_start: '2024-06-02T00:15:00.000Z' },
      ],
    });
    const consistency = samples.filter((s) => s.metric === 'sleep_consistency');
    expect(consistency).toHaveLength(1);
    // 23:45 and 00:15 are 30 min apart, stddev between them is 15 min, NOT ~700 min
    expect(consistency[0].value).toBeCloseTo(15, 1);
  });

  it('returns no sleep_consistency sample for fewer than 2 days', () => {
    const samples = parseOuraSleep({ data: [fixture.data[0]] });
    expect(samples.filter((s) => s.metric === 'sleep_consistency')).toHaveLength(0);
  });
});

describe('parseOuraReadiness', () => {
  const fixture = readinessFixture as OuraReadinessResponse;

  it('maps average_hrv to hrv_rmssd and resting_heart_rate to resting_hr', () => {
    const samples = parseOuraReadiness(fixture);
    const hrv = samples.filter((s) => s.metric === 'hrv_rmssd');
    const hr = samples.filter((s) => s.metric === 'resting_hr');

    expect(hrv).toHaveLength(2);
    expect(hrv[0].value).toBe(42.5);
    expect(hr).toHaveLength(2);
    expect(hr[0].value).toBe(54);
  });
});

describe('parseOuraActivity', () => {
  const fixture = activityFixture as OuraActivityResponse;

  it('maps steps directly', () => {
    const samples = parseOuraActivity(fixture);
    const steps = samples.filter((s) => s.metric === 'steps');
    expect(steps).toHaveLength(1);
    expect(steps[0].value).toBe(8421);
  });

  it('counts MET-zone-2 (3 <= met < 6) minutes from the interval buckets', () => {
    const samples = parseOuraActivity(fixture);
    const zone2 = samples.filter((s) => s.metric === 'zone2_minutes');
    expect(zone2).toHaveLength(1);
    // 4 buckets in [3,6) * 60s interval / 60 = 4 minutes
    expect(zone2[0].value).toBeCloseTo(4, 5);
  });
});
