import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import type { Sample } from '../score/types.js';

// Maps Apple Health HKQuantityTypeIdentifier → our metric + unit normalizer
const METRIC_MAP: Record<string, { metric: Sample['metric']; toValue: (v: number, unit: string) => number; unit: string }> = {
  HKQuantityTypeIdentifierVO2Max: {
    metric: 'vo2max',
    toValue: (v) => v,
    unit: 'ml/kg/min',
  },
  HKQuantityTypeIdentifierHeartRate: {
    metric: 'resting_hr',
    toValue: (v) => v,
    unit: 'bpm',
  },
  HKQuantityTypeIdentifierBloodPressureSystolic: {
    metric: 'systolic_bp',
    toValue: (v) => v,
    unit: 'mmHg',
  },
  HKQuantityTypeIdentifierWaistCircumference: {
    metric: 'waist',
    toValue: (v, unit) => unit === 'in' ? v * 2.54 : v,
    unit: 'cm',
  },
  HKQuantityTypeIdentifierSleepAnalysis: {
    metric: 'sleep_duration',
    toValue: (v) => v / 3600,
    unit: 'h',
  },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: {
    metric: 'hrv_rmssd',
    toValue: (v, unit) => unit === 's' ? v * 1000 : v,
    unit: 'ms',
  },
  HKQuantityTypeIdentifierStepCount: {
    metric: 'steps',
    toValue: (v) => v,
    unit: 'steps',
  },
};

const STRENGTH_WORKOUT_TYPES = new Set([
  'HKWorkoutActivityTypeTraditionalStrengthTraining',
  'HKWorkoutActivityTypeFunctionalStrengthTraining',
  'HKWorkoutActivityTypeCrossTraining',
]);

// Zone 2 ≈ 60–70% of HRmax, HRmax estimated via 220 − age.
const ZONE2_LOW_PCT = 0.60;
const ZONE2_HIGH_PCT = 0.70;
const DEFAULT_AGE_FOR_HRMAX = 35;

// Minimal SAX-style line-by-line XML parser — no external deps.
// Apple Health export XML has one element per line (or close to it).
const RECORD_RE = /<Record\s([^>]+)\/>/;
const WORKOUT_START_RE = /<Workout\s([^>]*?)(\/?)>/;
const WORKOUT_END_RE = /<\/Workout>/;
const WORKOUT_STAT_RE = /<WorkoutStatistics\s([^>]+)\/>/;
const CORRELATION_START_RE = /<Correlation\s([^>]*?)(\/?)>/;
const CORRELATION_END_RE = /<\/Correlation>/;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function weekStartIso(date: Date): string {
  const weekStart = new Date(date);
  weekStart.setUTCDate(date.getUTCDate() - date.getUTCDay());
  weekStart.setUTCHours(0, 0, 0, 0);
  return weekStart.toISOString();
}

export async function parseAppleHealthXml(stream: Readable): Promise<Sample[]> {
  const samples: Sample[] = [];
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const strengthSessionsByWeek = new Map<string, number>();
  const zone2SecondsByWorkout: number[] = [];
  const sleepStartMinutes: number[] = [];
  let lastSleepDate: string | null = null;

  let inWorkout = false;
  let currentWorkoutType: string | null = null;
  let currentWorkoutStart: string | null = null;
  let currentWorkoutDuration = 0;
  let currentWorkoutAvgHr: number | null = null;

  let inCorrelation = false;
  let correlationIsBloodPressure = false;

  for await (const line of rl) {
    if (!inWorkout) {
      const workoutStart = WORKOUT_START_RE.exec(line);
      if (workoutStart) {
        const attrs = parseAttrs(workoutStart[1]);
        currentWorkoutType = attrs['workoutActivityType'] ?? null;
        currentWorkoutStart = attrs['startDate'] ?? null;
        currentWorkoutDuration = parseFloat(attrs['duration'] ?? '0');
        currentWorkoutAvgHr = null;

        if (workoutStart[2] === '/') {
          finalizeWorkout();
        } else {
          inWorkout = true;
        }
        continue;
      }
    } else {
      const stat = WORKOUT_STAT_RE.exec(line);
      if (stat) {
        const attrs = parseAttrs(stat[1]);
        if (attrs['type'] === 'HKQuantityTypeIdentifierHeartRate' && attrs['average']) {
          currentWorkoutAvgHr = parseFloat(attrs['average']);
        }
      }
      if (WORKOUT_END_RE.test(line)) {
        finalizeWorkout();
        inWorkout = false;
      }
      continue;
    }

    if (!inCorrelation) {
      const corrStart = CORRELATION_START_RE.exec(line);
      if (corrStart) {
        const attrs = parseAttrs(corrStart[1]);
        correlationIsBloodPressure = attrs['type'] === 'HKCorrelationTypeIdentifierBloodPressure';
        if (corrStart[2] !== '/') inCorrelation = true;
        continue;
      }
    } else if (CORRELATION_END_RE.test(line)) {
      inCorrelation = false;
      continue;
    }

    const match = RECORD_RE.exec(line);
    if (!match) continue;

    const attrs = parseAttrs(match[1]);
    const type = attrs['type'];

    if (inCorrelation && !correlationIsBloodPressure) continue;

    if (type === 'HKQuantityTypeIdentifierSleepAnalysis') {
      const startDate = attrs['startDate'];
      if (startDate) {
        const d = new Date(startDate);
        const day = startDate.slice(0, 10);
        if (day !== lastSleepDate) {
          sleepStartMinutes.push(d.getHours() * 60 + d.getMinutes());
          lastSleepDate = day;
        }
      }
    }

    const mapping = METRIC_MAP[type];
    if (!mapping) continue;

    const rawValue = parseFloat(attrs['value']);
    if (isNaN(rawValue)) continue;

    const rawUnit = attrs['unit'] ?? '';
    const measuredAt = attrs['endDate'] ?? attrs['startDate'];
    if (!measuredAt) continue;

    samples.push({
      metric: mapping.metric,
      value: mapping.toValue(rawValue, rawUnit),
      unit: mapping.unit,
      measuredAt: new Date(measuredAt).toISOString(),
      sourceKind: 'apple_health',
    });
  }

  function finalizeWorkout() {
    if (!currentWorkoutType || !currentWorkoutStart) return;

    if (STRENGTH_WORKOUT_TYPES.has(currentWorkoutType)) {
      const week = weekStartIso(new Date(currentWorkoutStart));
      strengthSessionsByWeek.set(week, (strengthSessionsByWeek.get(week) ?? 0) + 1);
    }

    if (currentWorkoutAvgHr !== null) {
      const hrMax = 220 - DEFAULT_AGE_FOR_HRMAX;
      const isZone2 = currentWorkoutAvgHr >= hrMax * ZONE2_LOW_PCT && currentWorkoutAvgHr <= hrMax * ZONE2_HIGH_PCT;
      if (isZone2) zone2SecondsByWorkout.push(currentWorkoutDuration * 60);
    }
  }

  for (const [week, count] of strengthSessionsByWeek) {
    samples.push({
      metric: 'strength_sessions',
      value: count,
      unit: '/week',
      measuredAt: week,
      sourceKind: 'apple_health',
    });
  }

  if (zone2SecondsByWorkout.length > 0) {
    const totalMinutes = zone2SecondsByWorkout.reduce((a, b) => a + b, 0) / 60;
    samples.push({
      metric: 'zone2_minutes',
      value: totalMinutes,
      unit: 'min',
      measuredAt: new Date().toISOString(),
      sourceKind: 'apple_health',
    });
  }

  if (sleepStartMinutes.length >= 2) {
    const mean = sleepStartMinutes.reduce((a, b) => a + b, 0) / sleepStartMinutes.length;
    const variance = sleepStartMinutes.reduce((a, b) => a + (b - mean) ** 2, 0) / sleepStartMinutes.length;
    samples.push({
      metric: 'sleep_consistency',
      value: Math.sqrt(variance),
      unit: 'min',
      measuredAt: new Date().toISOString(),
      sourceKind: 'apple_health',
    });
  }

  return samples;
}
