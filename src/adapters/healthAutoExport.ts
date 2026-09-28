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

export type HaePayload = (HaeMetric[] | { metrics: HaeMetric[] }) & { workouts?: HaeWorkout[] };

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
  // "HeartRate" in Health Auto Export is momentary/ambient heart rate,
  // including workout peaks — it must not feed resting_hr directly (see
  // handling of "RestingHeartRate" below, and #96). No METRIC_MAP entry
  // here on purpose so the generic per-datapoint loop skips it.
  RestingHeartRate: {
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

export interface HealthAutoExportOptions {
  birthDate?: string | Date;
  userAge?: number;
}

function parseSleepConsistency(metrics: HaeMetric[]): Sample | null {
  const sleepMetric = metrics.find((m) => m.name === 'SleepAnalysis');
  if (!sleepMetric) return null;

  const startMinutes = sleepMetric.data
    .filter((dp) => dp.date)
    .map((dp) => {
      const d = new Date(dp.date);
      const hour = d.getUTCHours();
      const minute = d.getUTCMinutes();
      return hour >= 12 ? (hour - 12) * 60 + minute : (hour + 12) * 60 + minute;
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

function parseZone2Minutes(workouts: HaeWorkout[], options?: HealthAutoExportOptions): Sample[] {
  let age = DEFAULT_AGE_FOR_HRMAX;
  if (options?.birthDate) {
    const birth = new Date(options.birthDate);
    if (!isNaN(birth.getTime())) {
      const today = new Date();
      age = today.getFullYear() - birth.getFullYear();
      const m = today.getMonth() - birth.getMonth();
      if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    }
  } else if (options?.userAge && options.userAge > 0) {
    age = options.userAge;
  }

  const hrMax = 220 - age;
  const zone2Workouts = workouts.filter((w) => {
    if (w.heartRateAvg === undefined) return false;
    return w.heartRateAvg >= hrMax * ZONE2_LOW_PCT && w.heartRateAvg <= hrMax * ZONE2_HIGH_PCT;
  });

  // Aggregate per calendar week (min/week) instead of summing the entire
  // payload into a single sample — a sync spanning multiple weeks would
  // otherwise blend every week's minutes into one value.
  const minutesByWeek = new Map<string, number>();
  for (const w of zone2Workouts) {
    const week = weekStartIso(new Date(w.start));
    minutesByWeek.set(week, (minutesByWeek.get(week) ?? 0) + (w.duration ?? 0) / 60);
  }

  return [...minutesByWeek.entries()].map(([week, totalMinutes]) => ({
    metric: 'zone2_minutes' as const,
    value: Math.round(totalMinutes * 10) / 10,
    unit: 'min',
    measuredAt: week,
    sourceKind: 'health_auto_export' as const,
  }));
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

export function parseHealthAutoExport(payload: HaePayload, options?: HealthAutoExportOptions): Sample[] {
  const obj = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const dataObj = typeof obj.data === 'object' && obj.data !== null ? (obj.data as Record<string, unknown>) : undefined;
  const metrics: HaeMetric[] = Array.isArray(payload) ? payload : ((obj.metrics ?? dataObj?.metrics ?? []) as HaeMetric[]);
  const workouts: HaeWorkout[] = (obj.workouts ?? dataObj?.workouts ?? []) as HaeWorkout[];
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

  const stepMetric = metrics.find((m) => m.name === 'StepCount');
  if (stepMetric) {
    const stepsByDay = new Map<string, { total: number; lastMeasuredAt: string }>();
    for (const dp of stepMetric.data) {
      if (!dp.date || dp.qty === undefined) continue;
      const measuredAt = new Date(dp.date).toISOString();
      const dayKey = measuredAt.slice(0, 10);
      const existing = stepsByDay.get(dayKey);
      if (existing) {
        existing.total += dp.qty;
        if (measuredAt > existing.lastMeasuredAt) existing.lastMeasuredAt = measuredAt;
      } else {
        stepsByDay.set(dayKey, { total: dp.qty, lastMeasuredAt: measuredAt });
      }
    }
    for (const { total, lastMeasuredAt } of stepsByDay.values()) {
      samples.push({
        metric: 'steps',
        value: Math.round(total),
        unit: 'steps',
        measuredAt: lastMeasuredAt,
        sourceKind: 'health_auto_export',
      });
    }
  }

  const consistency = parseSleepConsistency(metrics);
  if (consistency) samples.push(consistency);

  samples.push(...parseZone2Minutes(workouts, options));
  samples.push(...parseStrengthSessions(workouts));

  return samples;
}
