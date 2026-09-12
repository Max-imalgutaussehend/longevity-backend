import type { Sample } from '../score/types.js';

// Health Auto Export sends JSON payloads. Two formats are common:
// 1. Array format: [{name:"HeartRate", data:[{date,qty},...]}]
// 2. Flat format: {metrics:[{name,units,data:[{date,qty},...]}]}

interface HaeDataPoint {
  date: string;
  qty?: number;
  Avg?: number;
  Min?: number;
  Max?: number;
}

interface HaeWorkout {
  name: string;
  start: string;
  duration?: number;
  heartRateAvg?: number;
}

interface HaeMetric {
  name: string;
  units?: string;
  data: HaeDataPoint[];
}

type HaePayload = (HaeMetric[] | { metrics: HaeMetric[] }) & { workouts?: HaeWorkout[] };

const STRENGTH_WORKOUT_NAMES = new Set(['Functional Strength Training', 'Traditional Strength Training', 'Cross Training']);

// Zone 2 ≈ 60–70% of HRmax, HRmax estimated via 220 − age.
const ZONE2_LOW_PCT = 0.60;
const ZONE2_HIGH_PCT = 0.70;
const DEFAULT_AGE_FOR_HRMAX = 35;

function weekStartIso(date: Date): string {
  const weekStart = new Date(date);
  weekStart.setUTCDate(date.getUTCDate() - date.getUTCDay());
  weekStart.setUTCHours(0, 0, 0, 0);
  return weekStart.toISOString();
}

const METRIC_MAP: Record<string, { metric: Sample['metric']; toValue: (dp: HaeDataPoint, unit: string) => number | null; unit: string }> = {
  HeartRate: {
    metric: 'resting_hr',
    toValue: (dp) => dp.qty ?? dp.Avg ?? null,
    unit: 'bpm',
  },
  HeartRateVariabilitySDNN: {
    metric: 'hrv_rmssd',
    toValue: (dp) => dp.qty ?? dp.Avg ?? null,
    unit: 'ms',
  },
  VO2Max: {
    metric: 'vo2max',
    toValue: (dp) => dp.qty ?? dp.Avg ?? null,
    unit: 'ml/kg/min',
  },
  SystolicBloodPressure: {
    metric: 'systolic_bp',
    toValue: (dp) => dp.qty ?? dp.Avg ?? null,
    unit: 'mmHg',
  },
  SleepAnalysis: {
    metric: 'sleep_duration',
    toValue: (dp) => dp.qty ?? dp.Avg ?? null,
    unit: 'h',
  },
  StepCount: {
    metric: 'steps',
    toValue: (dp) => dp.qty ?? null,
    unit: 'steps',
  },
  WaistCircumference: {
    metric: 'waist',
    toValue: (dp, unit) => {
      const v = dp.qty ?? dp.Avg ?? null;
      if (v === null) return null;
      return unit === 'in' ? v * 2.54 : v;
    },
    unit: 'cm',
  },
};

function parseSleepConsistency(metrics: HaeMetric[]): Sample | null {
  const sleepMetric = metrics.find((m) => m.name === 'SleepAnalysis');
  if (!sleepMetric) return null;

  const startMinutes = sleepMetric.data
    .filter((dp) => dp.date)
    .map((dp) => {
      const d = new Date(dp.date);
      return d.getHours() * 60 + d.getMinutes();
    });

  if (startMinutes.length < 2) return null;

  const mean = startMinutes.reduce((a, b) => a + b, 0) / startMinutes.length;
  const variance = startMinutes.reduce((a, b) => a + (b - mean) ** 2, 0) / startMinutes.length;
  const lastDate = sleepMetric.data[sleepMetric.data.length - 1].date;

  return {
    metric: 'sleep_consistency',
    value: Math.sqrt(variance),
    unit: 'min',
    measuredAt: new Date(lastDate).toISOString(),
    sourceKind: 'health_auto_export',
  };
}

function parseZone2Minutes(workouts: HaeWorkout[]): Sample | null {
  const hrMax = 220 - DEFAULT_AGE_FOR_HRMAX;
  const zone2Workouts = workouts.filter((w) => {
    if (w.heartRateAvg === undefined) return false;
    return w.heartRateAvg >= hrMax * ZONE2_LOW_PCT && w.heartRateAvg <= hrMax * ZONE2_HIGH_PCT;
  });

  if (zone2Workouts.length === 0) return null;

  const totalMinutes = zone2Workouts.reduce((sum, w) => sum + (w.duration ?? 0) / 60, 0);

  return {
    metric: 'zone2_minutes',
    value: totalMinutes,
    unit: 'min',
    measuredAt: new Date().toISOString(),
    sourceKind: 'health_auto_export',
  };
}

function parseStrengthSessions(workouts: HaeWorkout[]): Sample[] {
  const byWeek = new Map<string, number>();

  for (const workout of workouts) {
    if (!STRENGTH_WORKOUT_NAMES.has(workout.name)) continue;
    const week = weekStartIso(new Date(workout.start));
    byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
  }

  return [...byWeek.entries()].map(([week, count]) => ({
    metric: 'strength_sessions' as const,
    value: count,
    unit: '/week',
    measuredAt: week,
    sourceKind: 'health_auto_export' as const,
  }));
}

export function parseHealthAutoExport(payload: HaePayload): Sample[] {
  const metrics: HaeMetric[] = Array.isArray(payload) ? payload : (payload.metrics ?? []);
  const workouts = payload.workouts ?? [];
  const samples: Sample[] = [];

  for (const metric of metrics) {
    const mapping = METRIC_MAP[metric.name];
    if (!mapping) continue;

    for (const dp of metric.data) {
      if (!dp.date) continue;
      const value = mapping.toValue(dp, metric.units ?? '');
      if (value === null || isNaN(value)) continue;

      samples.push({
        metric: mapping.metric,
        value,
        unit: mapping.unit,
        measuredAt: new Date(dp.date).toISOString(),
        sourceKind: 'health_auto_export',
      });
    }
  }

  const consistency = parseSleepConsistency(metrics);
  if (consistency) samples.push(consistency);

  const zone2 = parseZone2Minutes(workouts);
  if (zone2) samples.push(zone2);

  samples.push(...parseStrengthSessions(workouts));

  return samples;
}
