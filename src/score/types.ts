export type Metric =
  | 'vo2max' | 'resting_hr' | 'systolic_bp' | 'ldl' | 'hdl' | 'hba1c' | 'waist'
  | 'sleep_duration' | 'sleep_consistency' | 'hrv_rmssd'
  | 'zone2_minutes' | 'steps' | 'strength_sessions'
  | 'smoking' | 'alcohol_units' | 'hscrp';

export type Domain = 'cardiometabolic' | 'recovery' | 'activity' | 'risk';
export type SourceKind = 'apple_health' | 'oura' | 'lab' | 'questionnaire';

export interface Sample {
  metric: Metric;
  value: number;
  unit: string;
  measuredAt: string;
  sourceKind: SourceKind;
}

export interface MetricResult {
  metric: Metric;
  domain: Domain;
  value: number | null;
  unit: string;
  percentile: number | null;
  z: number | null;
  ageDays: number | null;
  freshness: number;
  effectiveWeight: number;
  contribution: number;
  available: boolean;
}

export interface DomainResult {
  domain: Domain;
  weight: number;
  score: number;
  metrics: MetricResult[];
}

export interface ScoreResult {
  score: number;
  coverage: number;
  bioAge: number;
  chronoAge: number;
  band: { low: number; high: number };
  domains: DomainResult[];
  engineVersion: string;
  computedAt: string;
}

export interface Lever {
  metric: Metric;
  currentValue: number | null;
  targetValue: number;
  delta: number;
  horizonWeeks: number;
}

export interface ScoreInput {
  profile: { birthDate: string; sex: 'm' | 'f' };
  samples: Sample[];
  now: Date;
}
