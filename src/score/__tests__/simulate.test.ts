import { describe, it, expect } from 'vitest';
import { simulate } from '../index.js';
import type { ScoreInput } from '../types.js';
import demoFixture from './__fixtures__/demo.json';
import smokerFixture from './__fixtures__/smoker.json';

const toInput = (f: unknown): ScoreInput => f as ScoreInput;

describe('simulate', () => {
  it('vo2max erhöhen verbessert den Score', () => {
    const input = toInput(demoFixture);
    const result = simulate(input, { vo2max: 75 });

    expect(result.base.score).toBeGreaterThan(0);
    expect(result.simulated.score).toBeGreaterThanOrEqual(result.base.score);
    expect(result.perMetric).toHaveLength(1);
    expect(result.perMetric[0].metric).toBe('vo2max');
    expect(result.perMetric[0].delta).toBeGreaterThanOrEqual(0);
  });

  it('Rauchen auf "aktuell" setzen senkt den Score', () => {
    const input = toInput(demoFixture);
    const result = simulate(input, { smoking: 3 });

    expect(result.simulated.score).toBeLessThan(result.base.score);
    expect(result.perMetric).toHaveLength(1);
    expect(result.perMetric[0].metric).toBe('smoking');
    expect(result.perMetric[0].delta).toBeLessThan(0);
  });

  it('Mehrere Overrides: HDL hoch + Rauchen weg ergibt positive Gesamt-Delta', () => {
    const input = toInput(smokerFixture);
    const result = simulate(input, { hdl: 80, smoking: 0 });

    expect(result.simulated.score).toBeGreaterThan(result.base.score);
    expect(result.perMetric).toHaveLength(2);
    const metrics = result.perMetric.map(m => m.metric);
    expect(metrics).toContain('hdl');
    expect(metrics).toContain('smoking');
  });

  it('Leere Overrides: base und simulated sind identisch', () => {
    const input = toInput(demoFixture);
    const result = simulate(input, {});

    expect(result.base.score).toBe(result.simulated.score);
    expect(result.perMetric).toHaveLength(0);
  });

  it('simulate() verändert den Input nicht (keine Side-Effects)', () => {
    const input = toInput(demoFixture);
    const sampleCountBefore = input.samples.length;
    simulate(input, { vo2max: 60, resting_hr: 50 });
    expect(input.samples.length).toBe(sampleCountBefore);
  });
});
