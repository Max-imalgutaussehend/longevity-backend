import { clamp, Phi } from './stats.js';
import { METRICS, DOMAIN_WEIGHTS, SOURCE_HALF_LIFE } from './metrics.js';
import { REFERENCE, SMOKING_Z } from './reference.js';
import type { ScoreInput, ScoreResult, MetricResult, DomainResult, Lever, Metric, Domain } from './types.js';

const ENGINE_VERSION = '0.1.0';

function ageYears(birthDate: string, now: Date): number {
  const birth = new Date(birthDate);
  return (now.getTime() - birth.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
}

function computeFreshness(measuredAt: string, now: Date, halfLifeDays: number): number {
  const dt = (now.getTime() - new Date(measuredAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.pow(2, -dt / halfLifeDays);
}

function computeZ(metric: string, value: number, age: number, sex: 'm' | 'f'): number {
  if (metric === 'smoking') {
    const category = value === 0 ? 'never' : value === 1 ? 'former_gt_1y' : value === 2 ? 'former_lt_1y' : 'current';
    return SMOKING_Z[category] ?? 0;
  }

  const ref = REFERENCE[metric];
  if (!ref) return 0;

  const mu = ref.mu(age, sex);
  const sigma = ref.sigma(sex);
  const def = METRICS.find(m => m.metric === metric);
  if (!def) return 0;

  let z: number;
  if (def.dir === 'higher') z = (value - mu) / sigma;
  else if (def.dir === 'lower') z = (mu - value) / sigma;
  else z = -Math.abs(value - (ref.target ?? mu)) / sigma;

  return clamp(z, -3, 3);
}

export function computeScore(input: ScoreInput): ScoreResult {
  const { profile, samples, now } = input;
  const age = ageYears(profile.birthDate, now);

  // Get most recent sample per metric with freshness
  const latestSamples = new Map<string, { value: number; measuredAt: string; sourceKind: string }>();
  for (const s of samples) {
    const existing = latestSamples.get(s.metric);
    if (!existing || new Date(s.measuredAt) > new Date(existing.measuredAt)) {
      latestSamples.set(s.metric, { value: s.value, measuredAt: s.measuredAt, sourceKind: s.sourceKind });
    }
  }

  const metricResults: MetricResult[] = [];

  for (const def of METRICS) {
    const sample = latestSamples.get(def.metric);
    const domainWeight = DOMAIN_WEIGHTS[def.domain];
    const metricBaseWeight = def.weight;
    const halfLife = def.halfLifeDays;

    if (!sample) {
      metricResults.push({
        metric: def.metric, domain: def.domain, value: null, unit: def.unit,
        percentile: null, z: null, ageDays: null,
        freshness: 0, effectiveWeight: 0, contribution: 0, available: false,
      });
      continue;
    }

    const freshness = computeFreshness(sample.measuredAt, now, halfLife);
    const available = freshness >= 0.05;

    if (!available) {
      metricResults.push({
        metric: def.metric, domain: def.domain, value: sample.value, unit: def.unit,
        percentile: null, z: null,
        ageDays: Math.round((now.getTime() - new Date(sample.measuredAt).getTime()) / (1000 * 60 * 60 * 24)),
        freshness, effectiveWeight: 0, contribution: 0, available: false,
      });
      continue;
    }

    const z = computeZ(def.metric, sample.value, age, profile.sex);
    const metricScore = 100 * Phi(z);
    const effectiveWeight = domainWeight * metricBaseWeight * freshness;

    metricResults.push({
      metric: def.metric, domain: def.domain,
      value: sample.value, unit: def.unit,
      percentile: Math.round(100 * Phi(z)),
      z, freshness, effectiveWeight,
      ageDays: Math.round((now.getTime() - new Date(sample.measuredAt).getTime()) / (1000 * 60 * 60 * 24)),
      contribution: 0, // filled below
      available: true,
    });
  }

  // Compute weighted raw score
  const available = metricResults.filter(m => m.available);
  const totalEffWeight = available.reduce((s, m) => s + m.effectiveWeight, 0);
  const raw = totalEffWeight > 0
    ? available.reduce((s, m) => s + m.effectiveWeight * (100 * Phi(computeZ(m.metric, m.value!, age, profile.sex))), 0) / totalEffWeight
    : 50;

  const totalBaseWeight = METRICS.reduce((s, m) => s + DOMAIN_WEIGHTS[m.domain] * m.weight, 0);
  const coverage = totalBaseWeight > 0
    ? available.reduce((s, m) => s + m.effectiveWeight, 0) / totalBaseWeight
    : 0;

  const finalScore = Math.round((50 + coverage * (raw - 50)) * 10) / 10;

  // Fill contributions
  for (const m of metricResults) {
    if (m.available && totalEffWeight > 0) {
      const z = computeZ(m.metric, m.value!, age, profile.sex);
      const metricScore = 100 * Phi(z);
      m.contribution = Math.round(((m.effectiveWeight / totalEffWeight) * (metricScore - 50) * coverage) * 10) / 10;
    }
  }

  // Build domain results
  const domainResults: DomainResult[] = (Object.keys(DOMAIN_WEIGHTS) as Domain[]).map(domain => {
    const dMetrics = metricResults.filter(m => m.domain === domain);
    const dAvailable = dMetrics.filter(m => m.available);
    const dEffWeight = dAvailable.reduce((s, m) => s + m.effectiveWeight, 0);
    const dScore = dEffWeight > 0
      ? dAvailable.reduce((s, m) => s + m.effectiveWeight * (100 * Phi(computeZ(m.metric, m.value!, age, profile.sex))), 0) / dEffWeight
      : 50;
    return { domain, weight: DOMAIN_WEIGHTS[domain], score: Math.round(dScore * 10) / 10, metrics: dMetrics };
  });

  const chronoAge = age;
  const bioAge = clamp(chronoAge - (finalScore - 50) / 10, chronoAge - 15, chronoAge + 15);
  const band = { low: Math.floor(finalScore / 10) * 10, high: Math.floor(finalScore / 10) * 10 + 9 };

  return {
    score: finalScore, coverage: Math.round(coverage * 100) / 100,
    bioAge: Math.round(bioAge * 10) / 10, chronoAge: Math.round(chronoAge * 10) / 10,
    band, domains: domainResults, engineVersion: ENGINE_VERSION,
    computedAt: now.toISOString(),
  };
}

export function simulate(
  input: ScoreInput,
  overrides: Partial<Record<Metric, number>>,
): { base: ScoreResult; simulated: ScoreResult; perMetric: { metric: Metric; delta: number }[] } {
  const base = computeScore(input);

  const overriddenSamples = input.samples.filter(s => !(s.metric in overrides));
  for (const [metric, value] of Object.entries(overrides) as [Metric, number][]) {
    overriddenSamples.push({
      metric, value, unit: '', measuredAt: input.now.toISOString(), sourceKind: 'apple_health',
    });
  }

  const simulated = computeScore({ ...input, samples: overriddenSamples });

  const perMetric = (Object.entries(overrides) as [Metric, number][]).map(([metric, value]) => {
    const single = computeScore({
      ...input,
      samples: [
        ...input.samples.filter(s => s.metric !== metric),
        { metric, value, unit: '', measuredAt: input.now.toISOString(), sourceKind: 'apple_health' },
      ],
    });
    return { metric, delta: Math.round((single.score - base.score) * 10) / 10 };
  });

  return { base, simulated, perMetric };
}

export function suggestLevers(input: ScoreInput): Lever[] {
  const base = computeScore(input);

  return METRICS
    .map(def => {
      const sample = input.samples.find(s => s.metric === def.metric);
      const currentValue = sample?.value ?? null;

      let targetValue: number;
      if (def.metric === 'smoking') {
        const current = currentValue ?? 3; // default to current smoker
        targetValue = Math.max(0, current - 1);
      } else {
        const ref = REFERENCE[def.metric];
        if (!ref) return null;
        const age = ageYears(input.profile.birthDate, input.now);
        const mu = ref.mu(age, input.profile.sex);
        const sigma = ref.sigma(input.profile.sex);
        const improvement = def.dir === 'higher' ? 0.5 * sigma : -0.5 * sigma;
        targetValue = (currentValue ?? mu) + improvement;
      }

      const sim = computeScore({
        ...input,
        samples: [
          ...input.samples.filter(s => s.metric !== def.metric),
          { metric: def.metric, value: targetValue, unit: def.unit, measuredAt: input.now.toISOString(), sourceKind: 'apple_health' },
        ],
      });

      return {
        metric: def.metric, currentValue, targetValue,
        delta: Math.round((sim.score - base.score) * 10) / 10,
        horizonWeeks: 8,
      } as Lever;
    })
    .filter((l): l is Lever => l !== null && l.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3);
}
