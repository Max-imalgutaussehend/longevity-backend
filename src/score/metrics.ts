import type { Domain, Metric, SourceKind } from './types.js';

export type Direction = 'higher' | 'lower' | 'target';

export interface MetricDef {
  metric: Metric;
  domain: Domain;
  unit: string;
  dir: Direction;
  weight: number;
  halfLifeDays: number;
}

export const DOMAIN_WEIGHTS: Record<Domain, number> = {
  cardiometabolic: 0.38,
  recovery: 0.24,
  activity: 0.26,
  risk: 0.12,
};

export const SOURCE_HALF_LIFE: Record<SourceKind, number> = {
  apple_health: 14,
  oura: 14,
  lab: 180,
  questionnaire: 365,
};

export const METRICS: MetricDef[] = [
  // cardiometabolic
  { metric: 'vo2max', domain: 'cardiometabolic', unit: 'ml/kg/min', dir: 'higher', weight: 0.34, halfLifeDays: 14 },
  { metric: 'resting_hr', domain: 'cardiometabolic', unit: 'bpm', dir: 'lower', weight: 0.12, halfLifeDays: 14 },
  { metric: 'systolic_bp', domain: 'cardiometabolic', unit: 'mmHg', dir: 'lower', weight: 0.16, halfLifeDays: 180 },
  { metric: 'ldl', domain: 'cardiometabolic', unit: 'mg/dL', dir: 'lower', weight: 0.12, halfLifeDays: 180 },
  { metric: 'hdl', domain: 'cardiometabolic', unit: 'mg/dL', dir: 'higher', weight: 0.08, halfLifeDays: 180 },
  { metric: 'hba1c', domain: 'cardiometabolic', unit: '%', dir: 'lower', weight: 0.12, halfLifeDays: 180 },
  { metric: 'waist', domain: 'cardiometabolic', unit: 'cm', dir: 'lower', weight: 0.06, halfLifeDays: 365 },
  // recovery
  { metric: 'sleep_duration', domain: 'recovery', unit: 'h', dir: 'target', weight: 0.34, halfLifeDays: 14 },
  { metric: 'sleep_consistency', domain: 'recovery', unit: 'min', dir: 'lower', weight: 0.33, halfLifeDays: 14 },
  { metric: 'hrv_rmssd', domain: 'recovery', unit: 'ms', dir: 'higher', weight: 0.33, halfLifeDays: 14 },
  // activity
  { metric: 'zone2_minutes', domain: 'activity', unit: 'min/week', dir: 'higher', weight: 0.45, halfLifeDays: 14 },
  { metric: 'steps', domain: 'activity', unit: 'steps/day', dir: 'higher', weight: 0.30, halfLifeDays: 14 },
  { metric: 'strength_sessions', domain: 'activity', unit: '/week', dir: 'higher', weight: 0.25, halfLifeDays: 14 },
  // risk
  { metric: 'smoking', domain: 'risk', unit: 'category', dir: 'higher', weight: 0.45, halfLifeDays: 365 },
  { metric: 'alcohol_units', domain: 'risk', unit: 'units/week', dir: 'lower', weight: 0.25, halfLifeDays: 365 },
  { metric: 'hscrp', domain: 'risk', unit: 'mg/L', dir: 'lower', weight: 0.30, halfLifeDays: 180 },
];
