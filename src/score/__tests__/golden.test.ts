import { describe, it, expect } from 'vitest';
import { computeScore } from '../index.js';
import type { ScoreInput } from '../types.js';
import emptyFixture from './__fixtures__/empty.json';
import demoFixture from './__fixtures__/demo.json';
import perfectFixture from './__fixtures__/perfect.json';
import staleFixture from './__fixtures__/stale.json';
import smokerFixture from './__fixtures__/smoker.json';
import missingSingleFixture from './__fixtures__/missing_single.json';
import missingSourceFixture from './__fixtures__/missing_source.json';
import extremeHighFixture from './__fixtures__/extreme_high.json';
import extremeLowFixture from './__fixtures__/extreme_low.json';
import unplausibleCorruptFixture from './__fixtures__/unplausible_corrupt.json';

const toInput = (f: unknown): ScoreInput => f as ScoreInput;

describe('Golden Tests', () => {
  it('empty — no samples → score 50.0, coverage 0', () => {
    const result = computeScore(toInput(emptyFixture));
    expect(result.score).toBe(50.0);
    expect(result.coverage).toBe(0);
  });

  it('demo — seeded demo user → score 78 ± 0.5, coverage 0.82 ± 0.02', () => {
    const result = computeScore(toInput(demoFixture));
    expect(result.score).toBeGreaterThanOrEqual(77.5);
    expect(result.score).toBeLessThanOrEqual(78.5);
    expect(result.coverage).toBeGreaterThanOrEqual(0.80);
    expect(result.coverage).toBeLessThanOrEqual(0.84);
  });

  it('perfect — all metrics at μ+2σ → score > 92', () => {
    const result = computeScore(toInput(perfectFixture));
    expect(result.score).toBeGreaterThan(92);
  });

  it('stale — 400-day-old samples → coverage < 0.1, score near 50', () => {
    const result = computeScore(toInput(staleFixture));
    expect(result.coverage).toBeLessThan(0.1);
    expect(result.score).toBeGreaterThan(45);
    expect(result.score).toBeLessThan(55);
  });

  it('smoker — demo + smoking:current → score drops > 4 points', () => {
    const base = computeScore(toInput(demoFixture));
    const result = computeScore(toInput(smokerFixture));
    expect(base.score - result.score).toBeGreaterThan(4);
  });

  it('monotony — increasing a higher metric never lowers the score', () => {
    const base = computeScore(toInput(demoFixture));
    const higherMetrics = ['vo2max', 'hdl', 'hrv_rmssd', 'zone2_minutes', 'steps', 'strength_sessions'] as const;

    for (const metric of higherMetrics) {
      const input = toInput(demoFixture) as ScoreInput;
      const modifiedSamples = input.samples.map(s =>
        s.metric === metric ? { ...s, value: s.value * 1.2 } : s
      );
      const result = computeScore({ ...input, samples: modifiedSamples });
      expect(result.score, `${metric} increased should not lower score`).toBeGreaterThanOrEqual(base.score - 0.01);
    }
  });

  it('determinism — same input produces same output twice', () => {
    const r1 = computeScore(toInput(demoFixture));
    const r2 = computeScore(toInput(demoFixture));
    expect(r1).toEqual(r2);
  });

  it('missing single metric — missing vo2max → lower coverage, available false for vo2max, score stable', () => {
    const base = computeScore(toInput(demoFixture));
    const result = computeScore(toInput(missingSingleFixture));

    expect(result.coverage).toBeLessThan(base.coverage);
    expect(result.coverage).toBeGreaterThan(0.65);
    expect(result.score).toBeGreaterThan(70);
    expect(result.score).toBeLessThan(85);

    const vo2Metric = result.domains
      .flatMap(d => d.metrics)
      .find(m => m.metric === 'vo2max');

    expect(vo2Metric).toBeDefined();
    expect(vo2Metric?.available).toBe(false);
    expect(vo2Metric?.value).toBeNull();
    expect(vo2Metric?.percentile).toBeNull();
    expect(vo2Metric?.contribution).toBe(0);
  });

  it('missing adapter — recovery source down → recovery domain defaults to 50.0, score regresses cleanly', () => {
    const base = computeScore(toInput(demoFixture));
    const result = computeScore(toInput(missingSourceFixture));

    expect(result.coverage).toBeLessThan(base.coverage);
    expect(result.coverage).toBeGreaterThanOrEqual(0.55);
    expect(result.coverage).toBeLessThanOrEqual(0.65);

    const recoveryDomain = result.domains.find(d => d.domain === 'recovery');
    expect(recoveryDomain).toBeDefined();
    expect(recoveryDomain?.score).toBe(50.0);
    expect(recoveryDomain?.metrics.every(m => !m.available)).toBe(true);

    // Overall score remains valid and defined
    expect(result.score).toBeGreaterThan(60);
    expect(result.score).toBeLessThan(80);
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it('extreme high — physiologically critical upper values → scores & percentiles bounded without NaN', () => {
    const result = computeScore(toInput(extremeHighFixture));

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(Number.isFinite(result.score)).toBe(true);

    // BioAge is clamped within ±15 years of chronoAge
    expect(result.bioAge).toBeGreaterThanOrEqual(result.chronoAge - 15);
    expect(result.bioAge).toBeLessThanOrEqual(result.chronoAge + 15);

    // Band is valid
    expect(result.band.low).toBeGreaterThanOrEqual(0);
    expect(result.band.high).toBeLessThanOrEqual(100);
    expect(result.band.high).toBeGreaterThanOrEqual(result.band.low);

    // All metrics have clamped z and valid percentiles
    for (const d of result.domains) {
      for (const m of d.metrics) {
        if (m.available) {
          expect(m.z).toBeGreaterThanOrEqual(-3);
          expect(m.z).toBeLessThanOrEqual(3);
          expect(m.percentile).toBeGreaterThanOrEqual(0);
          expect(m.percentile).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it('extreme low — zero and floor values → no division by zero, all metrics handled without NaN', () => {
    const result = computeScore(toInput(extremeLowFixture));

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(Number.isFinite(result.score)).toBe(true);

    expect(result.bioAge).toBeGreaterThanOrEqual(result.chronoAge - 15);
    expect(result.bioAge).toBeLessThanOrEqual(result.chronoAge + 15);

    for (const d of result.domains) {
      expect(Number.isFinite(d.score)).toBe(true);
      for (const m of d.metrics) {
        if (m.available) {
          expect(Number.isFinite(m.z!)).toBe(true);
          expect(m.percentile).toBeGreaterThanOrEqual(0);
          expect(m.percentile).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it('unplausible / corrupt — negative values & invalid samples safely filtered → defaults to empty baseline', () => {
    const result = computeScore(toInput(unplausibleCorruptFixture));

    expect(result.score).toBe(50.0);
    expect(result.coverage).toBe(0);
    expect(result.bioAge).toBe(result.chronoAge);
    expect(result.domains.every(d => d.score === 50.0)).toBe(true);
  });

  it('single source profile — only Apple Health steps → minimal coverage, safe domain fallback', () => {
    const singleSourceInput: ScoreInput = {
      profile: { birthDate: '1990-01-01', sex: 'f' },
      now: new Date('2026-09-09T12:00:00.000Z'),
      samples: [
        { metric: 'steps', value: 8500, unit: 'steps', measuredAt: '2026-09-08T00:00:00.000Z', sourceKind: 'apple_health' },
      ],
    };

    const result = computeScore(singleSourceInput);
    expect(result.coverage).toBeGreaterThan(0.05);
    expect(result.coverage).toBeLessThan(0.15);

    // Domains without any data default to 50.0
    const cardiometabolic = result.domains.find(d => d.domain === 'cardiometabolic');
    const recovery = result.domains.find(d => d.domain === 'recovery');
    const risk = result.domains.find(d => d.domain === 'risk');

    expect(cardiometabolic?.score).toBe(50.0);
    expect(recovery?.score).toBe(50.0);
    expect(risk?.score).toBe(50.0);

    // Final score is close to 50 due to low coverage regression
    expect(result.score).toBeGreaterThan(45);
    expect(result.score).toBeLessThan(55);
  });

  it('age boundary profiles — young (20yo) and elderly (80yo) profiles calculate plausible reference values', () => {
    const youngInput: ScoreInput = {
      profile: { birthDate: '2006-09-01', sex: 'm' },
      now: new Date('2026-09-09T12:00:00.000Z'),
      samples: (toInput(demoFixture) as ScoreInput).samples,
    };
    const elderlyInput: ScoreInput = {
      profile: { birthDate: '1946-09-01', sex: 'm' },
      now: new Date('2026-09-09T12:00:00.000Z'),
      samples: (toInput(demoFixture) as ScoreInput).samples,
    };

    const youngResult = computeScore(youngInput);
    const elderlyResult = computeScore(elderlyInput);

    expect(youngResult.chronoAge).toBeCloseTo(20, 0);
    expect(elderlyResult.chronoAge).toBeCloseTo(80, 0);

    // Both scores are valid finite numbers between 0 and 100
    expect(youngResult.score).toBeGreaterThan(50);
    expect(youngResult.score).toBeLessThanOrEqual(100);
    expect(elderlyResult.score).toBeGreaterThan(50);
    expect(elderlyResult.score).toBeLessThanOrEqual(100);

    // Elderly with youthful biometric values (VO2max 58 at age 80) gets higher relative percentile score
    expect(elderlyResult.score).toBeGreaterThan(youngResult.score);
  });
});
