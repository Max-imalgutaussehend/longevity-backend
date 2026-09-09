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

interface HaeMetric {
  name: string;
  units?: string;
  data: HaeDataPoint[];
}

type HaePayload = HaeMetric[] | { metrics: HaeMetric[] };

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

export function parseHealthAutoExport(payload: HaePayload): Sample[] {
  const metrics: HaeMetric[] = Array.isArray(payload) ? payload : (payload.metrics ?? []);
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
        sourceKind: 'apple_health',
      });
    }
  }

  return samples;
}
