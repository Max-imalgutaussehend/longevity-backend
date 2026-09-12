import { describe, it, expect } from 'vitest';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { parseAppleHealthXml } from '../../adapters/appleHealth.js';

const fixturePath = join(__dirname, '..', '__fixtures__', 'apple_health_mini.xml');

async function parseFixture() {
  return parseAppleHealthXml(createReadStream(fixturePath));
}

describe('parseAppleHealthXml — existing Record mappings still work', () => {
  it('maps VO2Max and StepCount', async () => {
    const samples = await parseFixture();
    expect(samples.some((s) => s.metric === 'vo2max' && s.value === 42.5)).toBe(true);
    expect(samples.some((s) => s.metric === 'steps' && s.value === 8421)).toBe(true);
  });

  it('maps sleep_duration for each SleepAnalysis record', async () => {
    const samples = await parseFixture();
    const sleep = samples.filter((s) => s.metric === 'sleep_duration');
    expect(sleep.length).toBe(3);
  });
});

describe('parseAppleHealthXml — HKCorrelation blood pressure', () => {
  it('extracts systolic_bp from inside a Correlation, ignores diastolic', async () => {
    const samples = await parseFixture();
    const systolic = samples.filter((s) => s.metric === 'systolic_bp');
    expect(systolic).toHaveLength(1);
    expect(systolic[0].value).toBe(118);
  });
});

describe('parseAppleHealthXml — Workout-derived metrics', () => {
  it('counts strength_sessions from TraditionalStrengthTraining/CrossTraining/FunctionalStrengthTraining workouts', async () => {
    const samples = await parseFixture();
    const strength = samples.filter((s) => s.metric === 'strength_sessions');
    // Both strength workouts fall in the same ISO week (2024-06-03, 2024-06-05)
    expect(strength).toHaveLength(1);
    expect(strength[0].value).toBe(2);
  });

  it('estimates zone2_minutes from workouts whose average HR falls in the 60-70% HRmax band', async () => {
    const samples = await parseFixture();
    const zone2 = samples.filter((s) => s.metric === 'zone2_minutes');
    expect(zone2).toHaveLength(1);
    // 3 workouts in zone (45 + 30 + 40 = 115 min); the 165bpm cycling workout is excluded
    expect(zone2[0].value).toBeCloseTo(115, 5);
  });
});

describe('parseAppleHealthXml — sleep_consistency', () => {
  it('computes stddev of sleep start times across days', async () => {
    const samples = await parseFixture();
    const consistency = samples.filter((s) => s.metric === 'sleep_consistency');
    expect(consistency).toHaveLength(1);
    expect(consistency[0].value).toBeGreaterThan(0);
    expect(consistency[0].unit).toBe('min');
  });
});
