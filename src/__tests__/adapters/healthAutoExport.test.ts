import { describe, it, expect } from 'vitest';
import { parseHealthAutoExport } from '../../adapters/healthAutoExport.js';

describe('parseHealthAutoExport — sourceKind fix', () => {
  it('tags every sample with sourceKind health_auto_export, not apple_health', () => {
    const samples = parseHealthAutoExport([
      { name: 'HeartRate', units: 'bpm', data: [{ date: '2024-06-01T07:00:00Z', qty: 55 }] },
      { name: 'StepCount', units: 'count', data: [{ date: '2024-06-01T00:00:00Z', qty: 8000 }] },
    ]);

    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.sourceKind === 'health_auto_export')).toBe(true);
  });
});

describe('parseHealthAutoExport — existing mappings still work', () => {
  it('maps HeartRate and StepCount', () => {
    const samples = parseHealthAutoExport([
      { name: 'HeartRate', units: 'bpm', data: [{ date: '2024-06-01T07:00:00Z', qty: 55 }] },
      { name: 'StepCount', units: 'count', data: [{ date: '2024-06-01T00:00:00Z', qty: 8000 }] },
    ]);

    expect(samples.some((s) => s.metric === 'resting_hr' && s.value === 55)).toBe(true);
    expect(samples.some((s) => s.metric === 'steps' && s.value === 8000)).toBe(true);
  });
});

describe('parseHealthAutoExport — sleep_consistency', () => {
  it('computes stddev of sleep start times when >= 2 SleepAnalysis points exist', () => {
    const samples = parseHealthAutoExport([
      {
        name: 'SleepAnalysis', units: 'h', data: [
          { date: '2024-06-01T23:15:00Z', qty: 7.5 },
          { date: '2024-06-02T23:45:00Z', qty: 6.75 },
          { date: '2024-06-03T22:50:00Z', qty: 8.33 },
        ],
      },
    ]);

    const consistency = samples.filter((s) => s.metric === 'sleep_consistency');
    expect(consistency).toHaveLength(1);
    expect(consistency[0].value).toBeGreaterThan(0);
    expect(consistency[0].sourceKind).toBe('health_auto_export');
  });

  it('produces no sleep_consistency sample for a single data point', () => {
    const samples = parseHealthAutoExport([
      { name: 'SleepAnalysis', units: 'h', data: [{ date: '2024-06-01T23:15:00Z', qty: 7.5 }] },
    ]);
    expect(samples.filter((s) => s.metric === 'sleep_consistency')).toHaveLength(0);
  });
});

describe('parseHealthAutoExport — zone2_minutes from ActiveEnergyBurned + HeartRate workouts', () => {
  it('sums duration of workouts whose average HR falls in the 60-70% HRmax band', () => {
    const samples = parseHealthAutoExport({
      metrics: [],
      workouts: [
        { name: 'Running', start: '2024-06-01T07:00:00Z', duration: 2400, heartRateAvg: 125 },
        { name: 'Cycling', start: '2024-06-02T07:00:00Z', duration: 1800, heartRateAvg: 165 },
      ],
    } as never);

    const zone2 = samples.filter((s) => s.metric === 'zone2_minutes');
    expect(zone2).toHaveLength(1);
    expect(zone2[0].value).toBeCloseTo(40, 5); // 2400s / 60
    expect(zone2[0].sourceKind).toBe('health_auto_export');
  });

  it('produces no zone2_minutes sample when no workout matches the HR band', () => {
    const samples = parseHealthAutoExport({
      metrics: [],
      workouts: [{ name: 'Cycling', start: '2024-06-02T07:00:00Z', duration: 1800, heartRateAvg: 165 }],
    } as never);
    expect(samples.filter((s) => s.metric === 'zone2_minutes')).toHaveLength(0);
  });
});

describe('parseHealthAutoExport — strength_sessions from Workout entries', () => {
  it('counts Functional/Traditional Strength Training and Cross Training per week', () => {
    const samples = parseHealthAutoExport({
      metrics: [],
      workouts: [
        { name: 'Traditional Strength Training', start: '2024-06-03T18:00:00Z' },
        { name: 'Cross Training', start: '2024-06-05T18:00:00Z' },
        { name: 'Running', start: '2024-06-04T07:00:00Z' },
        { name: 'Functional Strength Training', start: '2024-06-11T18:00:00Z' },
      ],
    } as never);

    const strength = samples.filter((s) => s.metric === 'strength_sessions');
    expect(strength).toHaveLength(2);
    const values = strength.map((s) => s.value).sort((a, b) => a - b);
    expect(values).toEqual([1, 2]);
  });

  it('calculates sleep consistency correctly across midnight', () => {
    const samples = parseHealthAutoExport([
      {
        name: 'SleepAnalysis', units: 'h', data: [
          { date: '2024-06-01T23:50:00Z', qty: 7.5 },
          { date: '2024-06-02T00:10:00Z', qty: 7.0 },
        ],
      },
    ]);

    const consistency = samples.filter((s) => s.metric === 'sleep_consistency');
    expect(consistency).toHaveLength(1);
    // Difference is only 20 minutes across midnight, StdDev of [710, 730] is 10
    expect(consistency[0].value).toBeCloseTo(10, 1);
  });

  it('uses custom userAge for Zone 2 HRmax calculation', () => {
    // 60-year-old: HRmax = 160, 60-70% band = [96, 112]
    const samples = parseHealthAutoExport(
      {
        metrics: [],
        workouts: [
          { name: 'Walking', start: '2024-06-01T07:00:00Z', duration: 1800, heartRateAvg: 105 },
        ],
      } as never,
      { userAge: 60 },
    );

    const zone2 = samples.filter((s) => s.metric === 'zone2_minutes');
    expect(zone2).toHaveLength(1);
    expect(zone2[0].value).toBe(30);
  });
});

