import type { Metric, SourceKind } from '../score/types.js';

// Mulberry32 deterministic PRNG
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MetricConfig {
  metric: Metric;
  sourceKind: SourceKind;
  unit: string;
  mu: number;
  sigma: number;
  phi: number; // AR(1) coefficient
  isLab?: boolean;
}

const WEARABLE_METRICS: MetricConfig[] = [
  { metric: 'vo2max', sourceKind: 'apple_health', unit: 'ml/kg/min', mu: 50, sigma: 3, phi: 0.9 },
  { metric: 'resting_hr', sourceKind: 'oura', unit: 'bpm', mu: 60, sigma: 4, phi: 0.85 },
  { metric: 'hrv_rmssd', sourceKind: 'oura', unit: 'ms', mu: 58, sigma: 8, phi: 0.8 },
  { metric: 'sleep_duration', sourceKind: 'oura', unit: 'h', mu: 7.3, sigma: 0.5, phi: 0.7 },
  { metric: 'sleep_consistency', sourceKind: 'oura', unit: 'min', mu: 48, sigma: 12, phi: 0.6 },
  { metric: 'zone2_minutes', sourceKind: 'apple_health', unit: 'min/week', mu: 95, sigma: 25, phi: 0.7 },
  { metric: 'steps', sourceKind: 'apple_health', unit: 'steps/day', mu: 8800, sigma: 1500, phi: 0.75 },
  { metric: 'strength_sessions', sourceKind: 'apple_health', unit: '/week', mu: 1.8, sigma: 0.6, phi: 0.6 },
];

const LAB_METRICS: MetricConfig[] = [
  { metric: 'ldl', sourceKind: 'lab', unit: 'mg/dL', mu: 112, sigma: 15, phi: 0, isLab: true },
  { metric: 'hdl', sourceKind: 'lab', unit: 'mg/dL', mu: 50, sigma: 8, phi: 0, isLab: true },
  { metric: 'hba1c', sourceKind: 'lab', unit: '%', mu: 5.3, sigma: 0.2, phi: 0, isLab: true },
  { metric: 'systolic_bp', sourceKind: 'lab', unit: 'mmHg', mu: 120, sigma: 8, phi: 0, isLab: true },
];

export interface GeneratedSample {
  metric: Metric;
  value: number;
  unit: string;
  measuredAt: string;
  sourceKind: SourceKind;
}

export function generate(seed: number, days: number, now = new Date()): GeneratedSample[] {
  const rand = mulberry32(seed);
  const samples: GeneratedSample[] = [];

  // AR(1) state per metric
  const state: Record<string, number> = {};
  for (const m of WEARABLE_METRICS) {
    state[m.metric] = m.mu + (rand() - 0.5) * m.sigma;
  }

  for (let d = days - 1; d >= 0; d--) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    const dayOfWeek = date.getDay(); // 0=Sun, 5=Fri, 6=Sat

    for (const m of WEARABLE_METRICS) {
      // AR(1) update
      const noise = (rand() - 0.5) * 2 * m.sigma * Math.sqrt(1 - m.phi * m.phi);
      let value = m.phi * (state[m.metric] - m.mu) + m.mu + noise;

      // Slight positive drift on vo2max and zone2_minutes
      if (m.metric === 'vo2max') value += 0.015;
      if (m.metric === 'zone2_minutes') value += 0.2;

      // Weekend sleep pattern
      if (m.metric === 'sleep_duration' && (dayOfWeek === 5 || dayOfWeek === 6)) {
        value -= 0.7;
      }
      if (m.metric === 'sleep_consistency' && (dayOfWeek === 5 || dayOfWeek === 6)) {
        value += 50; // later/inconsistent on weekends
      }

      // Clamp to plausible values
      value = Math.max(0, value);
      if (m.metric === 'strength_sessions') value = Math.min(4, Math.round(value * 2) / 2);

      state[m.metric] = value;

      samples.push({
        metric: m.metric, value: Math.round(value * 100) / 100,
        unit: m.unit, measuredAt: date.toISOString(), sourceKind: m.sourceKind,
      });
    }
  }

  // Lab values: 3 snapshots at -122, -310, -480 days
  for (const offset of [122, 310, 480]) {
    const labDate = new Date(now);
    labDate.setDate(labDate.getDate() - offset);
    for (const m of LAB_METRICS) {
      const value = m.mu + (rand() - 0.5) * m.sigma * 2;
      samples.push({
        metric: m.metric, value: Math.round(value * 10) / 10,
        unit: m.unit, measuredAt: labDate.toISOString(), sourceKind: m.sourceKind,
      });
    }
  }

  return samples;
}
