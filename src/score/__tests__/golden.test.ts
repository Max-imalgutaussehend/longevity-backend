import { describe, it, expect } from 'vitest';
import { computeScore } from '../index.js';
import type { ScoreInput } from '../types.js';
import emptyFixture from './__fixtures__/empty.json';
import demoFixture from './__fixtures__/demo.json';
import perfectFixture from './__fixtures__/perfect.json';
import staleFixture from './__fixtures__/stale.json';
import smokerFixture from './__fixtures__/smoker.json';

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
});
