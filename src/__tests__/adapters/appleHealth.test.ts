import { describe, it, expect } from 'vitest';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { parseAppleHealthXml } from '../../adapters/appleHealth.js';

import { resolve } from 'node:path';

function streamFromXml(xml: string): Readable {
  return Readable.from([xml]);
}

describe('parseAppleHealthXml with apple_health_mini.xml fixture', () => {
  it('parses all existing and new metrics from the mini fixture', async () => {
    const fixturePath = resolve(__dirname, '../__fixtures__/apple_health_mini.xml');
    const stream = createReadStream(fixturePath);
    const samples = await parseAppleHealthXml(stream);

    // Existing metrics check
    const vo2max = samples.filter((s) => s.metric === 'vo2max');
    expect(vo2max).toHaveLength(1);
    expect(vo2max[0].value).toBe(48.5);
    expect(vo2max[0].unit).toBe('ml/kg/min');

    // Only HKQuantityTypeIdentifierRestingHeartRate maps to resting_hr — the
    // ambient 180 bpm workout-level HeartRate record must not leak in.
    const restingHr = samples.filter((s) => s.metric === 'resting_hr');
    expect(restingHr).toHaveLength(1);
    expect(restingHr[0].value).toBe(58);
    expect(restingHr[0].unit).toBe('bpm');

    const waist = samples.filter((s) => s.metric === 'waist');
    expect(waist).toHaveLength(1);
    expect(waist[0].value).toBe(82);
    expect(waist[0].unit).toBe('cm');

    const hrv = samples.filter((s) => s.metric === 'hrv_rmssd');
    expect(hrv).toHaveLength(1);
    expect(hrv[0].value).toBe(65);
    expect(hrv[0].unit).toBe('ms');

    // Two step chunks on the same day (6000 + 2500) must be summed into one
    // daily sample, not overwritten by the last chunk.
    const steps = samples.filter((s) => s.metric === 'steps');
    expect(steps).toHaveLength(1);
    expect(steps[0].value).toBe(8500);
    expect(steps[0].unit).toBe('steps');

    // HKCorrelation: systolic_bp resolved from Blood Pressure correlation
    const systolic = samples.filter((s) => s.metric === 'systolic_bp');
    expect(systolic).toHaveLength(1);
    expect(systolic[0].value).toBe(120);
    expect(systolic[0].unit).toBe('mmHg');
    const diastolic = samples.filter((s) => (s.metric as string) === 'diastolic_bp');
    expect(diastolic).toHaveLength(0);

    // HKWorkout: Strength sessions (TraditionalStrengthTraining, FunctionalStrengthTraining, CrossTraining)
    const strength = samples.filter((s) => s.metric === 'strength_sessions');
    expect(strength).toHaveLength(3);
    expect(strength.every((s) => s.value === 1 && s.unit === '/week')).toBe(true);

    // HKWorkout: Zone 2 minutes (HR = 125 is between 60% and 70% HRmax for age 30)
    // Non-Zone 2 workout (HR = 165) must be excluded
    const zone2 = samples.filter((s) => s.metric === 'zone2_minutes');
    expect(zone2).toHaveLength(1);
    expect(zone2[0].value).toBe(40);
    expect(zone2[0].unit).toBe('min');

    // HKCategoryTypeIdentifierSleepAnalysis: sleep_duration (3 nights: 8h, 8h, 7.5h)
    const sleepDuration = samples.filter((s) => s.metric === 'sleep_duration');
    expect(sleepDuration).toHaveLength(3);
    expect(sleepDuration[0].value).toBe(8);
    expect(sleepDuration[1].value).toBe(8);
    expect(sleepDuration[2].value).toBe(7.5);

    // Sleep Consistency: Standard deviation of bedtimes (23:00, 23:30, 00:00 -> stddev = 30 min)
    const sleepConsistency = samples.filter((s) => s.metric === 'sleep_consistency');
    expect(sleepConsistency).toHaveLength(1);
    expect(sleepConsistency[0].value).toBe(30);
    expect(sleepConsistency[0].unit).toBe('min');

    // All samples tagged with sourceKind: apple_health
    expect(samples.every((s) => s.sourceKind === 'apple_health')).toBe(true);
  });
});

describe('parseAppleHealthXml edge cases and variations', () => {
  it('resolves self-closing strength workout tags and custom workout types', async () => {
    const xml = `
      <Workout workoutActivityType="TraditionalStrengthTraining" duration="45" durationUnit="min" startDate="2026-09-01 10:00:00 +0200" endDate="2026-09-01 10:45:00 +0200"/>
    `;
    const samples = await parseAppleHealthXml(streamFromXml(xml));
    const strength = samples.filter((s) => s.metric === 'strength_sessions');
    expect(strength).toHaveLength(1);
    expect(strength[0].value).toBe(1);
    expect(strength[0].unit).toBe('/week');
  });

  it('calculates Zone 2 with custom userAge and duration in seconds', async () => {
    // For age 50: HRmax = 220 - 50 = 170. Zone 2 (60-70%) is [102, 119] bpm.
    // Workout 1: HR 110 (Zone 2 for age 50), duration 1800 s (30 min)
    // Workout 2: HR 125 (Zone 2 for age 30, but above 119 for age 50 -> excluded)
    const xml = `
      <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="1800" durationUnit="s" startDate="2026-09-01 07:00:00 +0200" endDate="2026-09-01 07:30:00 +0200">
        <MetadataEntry key="HKAverageHeartRate" value="110 bpm"/>
      </Workout>
      <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="1800" durationUnit="s" startDate="2026-09-02 07:00:00 +0200" endDate="2026-09-02 07:30:00 +0200">
        <MetadataEntry key="HKAverageHeartRate" value="125 bpm"/>
      </Workout>
    `;
    const samples = await parseAppleHealthXml(streamFromXml(xml), { userAge: 50 });
    const zone2 = samples.filter((s) => s.metric === 'zone2_minutes');
    expect(zone2).toHaveLength(1);
    expect(zone2[0].value).toBe(30);
    expect(zone2[0].unit).toBe('min');
  });

  it('resolves self-closing BloodPressure correlation with value directly', async () => {
    const xml = `
      <Correlation type="HKCorrelationTypeIdentifierBloodPressure" value="118" unit="mmHg" startDate="2026-09-01 08:00:00 +0200" endDate="2026-09-01 08:00:00 +0200"/>
    `;
    const samples = await parseAppleHealthXml(streamFromXml(xml));
    const systolic = samples.filter((s) => s.metric === 'systolic_bp');
    expect(systolic).toHaveLength(1);
    expect(systolic[0].value).toBe(118);
  });

  it('does not emit sleep_consistency if only 1 sleep session exists', async () => {
    const xml = `
      <Record type="HKCategoryTypeIdentifierSleepAnalysis" value="HKCategoryValueSleepAnalysisAsleep" startDate="2026-09-01 23:00:00 +0200" endDate="2026-09-02 07:00:00 +0200"/>
    `;
    const samples = await parseAppleHealthXml(streamFromXml(xml));
    const sleepDuration = samples.filter((s) => s.metric === 'sleep_duration');
    const sleepConsistency = samples.filter((s) => s.metric === 'sleep_consistency');
    expect(sleepDuration).toHaveLength(1);
    expect(sleepConsistency).toHaveLength(0);
  });

  // Regression tests for #96: momentary HeartRate must not overwrite
  // resting_hr, step chunks must sum per day, zone2_minutes must aggregate
  // per calendar week.
  it('does not map ambient/workout HeartRate records to resting_hr', async () => {
    const xml = `
      <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="bpm" value="180" startDate="2026-09-01 12:00:00 +0200" endDate="2026-09-01 12:00:00 +0200"/>
    `;
    const samples = await parseAppleHealthXml(streamFromXml(xml));
    expect(samples.filter((s) => s.metric === 'resting_hr')).toHaveLength(0);
  });

  it('sums step chunks across a day instead of taking the last chunk', async () => {
    const xml = `
      <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" value="30" startDate="2026-09-01 08:00:00 +0200" endDate="2026-09-01 08:10:00 +0200"/>
      <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" value="70" startDate="2026-09-01 08:10:00 +0200" endDate="2026-09-01 08:20:00 +0200"/>
      <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" value="20" startDate="2026-09-01 20:00:00 +0200" endDate="2026-09-01 20:05:00 +0200"/>
    `;
    const samples = await parseAppleHealthXml(streamFromXml(xml));
    const steps = samples.filter((s) => s.metric === 'steps');
    expect(steps).toHaveLength(1);
    expect(steps[0].value).toBe(120);
  });

  it('keeps step totals separate per calendar day', async () => {
    const xml = `
      <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" value="100" startDate="2026-09-01 08:00:00 +0200" endDate="2026-09-01 08:10:00 +0200"/>
      <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" value="200" startDate="2026-09-02 08:00:00 +0200" endDate="2026-09-02 08:10:00 +0200"/>
    `;
    const samples = await parseAppleHealthXml(streamFromXml(xml));
    const steps = samples.filter((s) => s.metric === 'steps');
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.value).sort((a, b) => a - b)).toEqual([100, 200]);
  });

  it('aggregates zone2_minutes across multiple qualifying workouts in the same calendar week', async () => {
    // 2026-09-07 and 2026-09-09 are both in the week starting Sunday 2026-09-06.
    const xml = `
      <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2026-09-07 07:00:00 +0200" endDate="2026-09-07 07:30:00 +0200">
        <MetadataEntry key="HKAverageHeartRate" value="125 count/min"/>
      </Workout>
      <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="20" durationUnit="min" startDate="2026-09-09 07:00:00 +0200" endDate="2026-09-09 07:20:00 +0200">
        <MetadataEntry key="HKAverageHeartRate" value="125 count/min"/>
      </Workout>
    `;
    const samples = await parseAppleHealthXml(streamFromXml(xml));
    const zone2 = samples.filter((s) => s.metric === 'zone2_minutes');
    expect(zone2).toHaveLength(1);
    expect(zone2[0].value).toBe(50);
  });

  it('keeps zone2_minutes separate across different calendar weeks', async () => {
    const xml = `
      <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2026-09-07 07:00:00 +0200" endDate="2026-09-07 07:30:00 +0200">
        <MetadataEntry key="HKAverageHeartRate" value="125 count/min"/>
      </Workout>
      <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="20" durationUnit="min" startDate="2026-09-14 07:00:00 +0200" endDate="2026-09-14 07:20:00 +0200">
        <MetadataEntry key="HKAverageHeartRate" value="125 count/min"/>
      </Workout>
    `;
    const samples = await parseAppleHealthXml(streamFromXml(xml));
    const zone2 = samples.filter((s) => s.metric === 'zone2_minutes');
    expect(zone2).toHaveLength(2);
  });
});
