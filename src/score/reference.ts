// Reference values — approximated from literature, not validated norms.
// All changes go here only; bump engineVersion in index.ts afterwards.
// Before production use: validate against a named cohort (e.g. NHANES) with citation.

export interface RefParams {
  mu: (age: number, sex: 'm' | 'f') => number;
  sigma: (sex: 'm' | 'f') => number;
  target?: number;
}

export const REFERENCE: Record<string, RefParams> = {
  vo2max: {
    mu: (a, s) => s === 'm' ? 48 - 0.33 * (a - 25) : 40 - 0.30 * (a - 25),
    sigma: (s) => s === 'm' ? 8 : 7,
  },
  resting_hr: {
    mu: (_, s) => s === 'm' ? 66 : 70,
    sigma: () => 9,
  },
  systolic_bp: {
    mu: (a, s) => s === 'm' ? 118 + 0.35 * (a - 25) : 112 + 0.45 * (a - 25),
    sigma: () => 12,
  },
  ldl: {
    mu: (a) => 110 + 0.5 * (a - 25),
    sigma: () => 30,
  },
  hdl: {
    mu: (_, s) => s === 'm' ? 48 : 58,
    sigma: (s) => s === 'm' ? 12 : 14,
  },
  hba1c: {
    mu: (a) => 5.2 + 0.008 * (a - 25),
    sigma: () => 0.35,
  },
  waist: {
    mu: (a, s) => s === 'm' ? 88 + 0.25 * (a - 25) : 78 + 0.28 * (a - 25),
    sigma: () => 11,
  },
  sleep_duration: {
    mu: () => 7.5,
    sigma: () => 0.9,
    target: 7.5,
  },
  sleep_consistency: {
    mu: () => 55,
    sigma: () => 25,
  },
  hrv_rmssd: {
    mu: (a) => 55 - 0.5 * (a - 25),
    sigma: () => 20,
  },
  zone2_minutes: {
    mu: () => 90,
    sigma: () => 60,
  },
  steps: {
    mu: () => 7500,
    sigma: () => 3000,
  },
  strength_sessions: {
    mu: () => 1.0,
    sigma: () => 1.0,
  },
  alcohol_units: {
    mu: () => 8,
    sigma: () => 6,
  },
  hscrp: {
    mu: () => 1.6,
    sigma: () => 1.2,
  },
};

// Fixed z-scores for smoking categories
export const SMOKING_Z: Record<string, number> = {
  never: 0.6,
  former_gt_1y: 0.2,
  former_lt_1y: -0.4,
  current: -2.5,
};
