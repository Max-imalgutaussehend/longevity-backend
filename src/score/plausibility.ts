export interface PlausibilityBounds {
  min: number;
  max: number;
}

export const METRIC_PLAUSIBILITY_BOUNDS: Record<string, PlausibilityBounds> = {
  resting_hr: { min: 32, max: 220 },
  systolic_bp: { min: 60, max: 260 },
  sleep_duration: { min: 0.5, max: 20 },
  sleep_consistency: { min: 0, max: 100 },
  hrv_rmssd: { min: 2, max: 350 },
  zone2_minutes: { min: 0, max: 1440 },
  steps: { min: 0, max: 65000 },
  vo2max: { min: 14, max: 90 },
  ldl: { min: 10, max: 500 },
  hdl: { min: 5, max: 200 },
  hba1c: { min: 3.5, max: 20 },
  waist: { min: 40, max: 220 },
  strength_sessions: { min: 0, max: 14 },
  smoking: { min: 0, max: 100 },
  alcohol_units: { min: 0, max: 100 },
  hscrp: { min: 0.01, max: 100 },
};

/**
 * Checks whether a given metric sample value falls within medically plausible human boundaries.
 */
export function isSamplePlausible(metric: string, value: number): boolean {
  const bounds = METRIC_PLAUSIBILITY_BOUNDS[metric];
  if (!bounds) return true;
  return value >= bounds.min && value <= bounds.max && !Number.isNaN(value) && Number.isFinite(value);
}

/**
 * Filters out biologically impossible or fraudulent metric values.
 */
export function filterPlausibleSamples<T extends { metric: string; value: number }>(samples: T[]): {
  plausible: T[];
  implausibleCount: number;
} {
  const plausible: T[] = [];
  let implausibleCount = 0;

  for (const s of samples) {
    if (isSamplePlausible(s.metric, s.value)) {
      plausible.push(s);
    } else {
      implausibleCount++;
    }
  }

  return { plausible, implausibleCount };
}
