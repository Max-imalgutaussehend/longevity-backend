import { describe, it, expect } from 'vitest';
import { evaluateHoldingPeriod } from '../holdingPeriod.js';

describe('evaluateHoldingPeriod', () => {
  const now = new Date('2026-09-27T12:00:00Z');

  describe('no duration required (minMonths is 0, null, or undefined)', () => {
    it('qualifies immediately when current band meets minBand', () => {
      const result = evaluateHoldingPeriod({
        currentBand: { low: 70, high: 79 },
        minBand: 70,
        minMonths: null,
        snapshots: [],
        now,
      });

      expect(result.qualified).toBe(true);
      expect(result.daysHeld).toBe(0);
      expect(result.daysRemaining).toBe(0);
      expect(result.requiredDays).toBe(0);
    });

    it('does not qualify when current band is below minBand', () => {
      const result = evaluateHoldingPeriod({
        currentBand: { low: 60, high: 69 },
        minBand: 70,
        minMonths: 0,
        snapshots: [],
        now,
      });

      expect(result.qualified).toBe(false);
      expect(result.daysHeld).toBe(0);
      expect(result.daysRemaining).toBe(0);
      expect(result.requiredDays).toBe(0);
    });
  });

  describe('duration required (minMonths > 0)', () => {
    const minBand = 70;
    const minMonths = 3; // 90 days

    it('does not qualify if current band is below minBand, regardless of history', () => {
      const result = evaluateHoldingPeriod({
        currentBand: { low: 60, high: 69 },
        minBand,
        minMonths,
        snapshots: [
          { computedFor: '2026-05-01', score: 75 },
          { computedFor: '2026-09-26', score: 75 },
        ],
        now,
      });

      expect(result.qualified).toBe(false);
      expect(result.daysHeld).toBe(0);
      expect(result.daysRemaining).toBe(90);
      expect(result.requiredDays).toBe(90);
    });

    it('does not qualify when only today is recorded', () => {
      const result = evaluateHoldingPeriod({
        currentBand: { low: 70, high: 79 },
        minBand,
        minMonths,
        snapshots: [
          { computedFor: '2026-09-27', score: 75 },
        ],
        now,
      });

      expect(result.qualified).toBe(false);
      expect(result.daysHeld).toBe(0);
      expect(result.daysRemaining).toBe(90);
    });

    it('qualifies when user maintained score >= minBand for at least 90 days with weekly check-ins', () => {
      const result = evaluateHoldingPeriod({
        currentBand: { low: 70, high: 79 },
        minBand,
        minMonths,
        snapshots: [
          { computedFor: '2026-06-20', score: 72 }, // ~99 days ago
          { computedFor: '2026-07-01', score: 73 },
          { computedFor: '2026-07-08', score: 73 },
          { computedFor: '2026-07-20', score: 74 },
          { computedFor: '2026-08-01', score: 75 },
          { computedFor: '2026-08-13', score: 76 },
          { computedFor: '2026-08-25', score: 75 },
          { computedFor: '2026-09-06', score: 75 },
          { computedFor: '2026-09-20', score: 75 },
          { computedFor: '2026-09-27', score: 75 },
        ],
        now,
      });

      expect(result.qualified).toBe(true);
      expect(result.daysHeld).toBeGreaterThanOrEqual(90);
      expect(result.daysRemaining).toBe(0);
    });

    it('resets the streak if any snapshot in between dropped below minBand', () => {
      const result = evaluateHoldingPeriod({
        currentBand: { low: 70, high: 79 },
        minBand,
        minMonths,
        snapshots: [
          { computedFor: '2026-05-01', score: 75 },
          { computedFor: '2026-08-25', score: 55 }, // Dropped below minBand
          { computedFor: '2026-09-01', score: 74 },
          { computedFor: '2026-09-05', score: 75 },
          { computedFor: '2026-09-10', score: 75 },
          { computedFor: '2026-09-15', score: 75 },
          { computedFor: '2026-09-20', score: 75 },
          { computedFor: '2026-09-27', score: 75 },
        ],
        now,
      });

      expect(result.qualified).toBe(false);
      expect(result.daysHeld).toBe(26); // 2026-09-01 to 2026-09-27
      expect(result.daysRemaining).toBe(64);
    });

    it('qualifies on exact day boundary (90 days) with regular check-ins', () => {
      const result = evaluateHoldingPeriod({
        currentBand: { low: 70, high: 79 },
        minBand,
        minMonths,
        snapshots: [
          { computedFor: '2026-06-29', score: 70 }, // exactly 90 days before `now`
          { computedFor: '2026-07-10', score: 70 },
          { computedFor: '2026-07-20', score: 70 },
          { computedFor: '2026-08-01', score: 70 },
          { computedFor: '2026-08-10', score: 70 },
          { computedFor: '2026-08-22', score: 70 },
          { computedFor: '2026-09-01', score: 70 },
          { computedFor: '2026-09-15', score: 70 },
          { computedFor: '2026-09-27', score: 70 },
        ],
        now,
      });

      expect(result.qualified).toBe(true);
      expect(result.daysHeld).toBe(90);
      expect(result.daysRemaining).toBe(0);
    });

    it('breaks the streak when the gap between check-ins exceeds maxGapDays, even with qualifying scores on both sides', () => {
      // Regression test for #99: a snapshot 90 days ago plus one today, with
      // nothing in between, must NOT count as a continuous 90-day hold.
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const result = evaluateHoldingPeriod({
        currentBand: { low: 70, high: 79 },
        minBand,
        minMonths,
        snapshots: [
          { computedFor: ninetyDaysAgo, score: 70 },
          { computedFor: '2026-09-27', score: 70 },
        ],
        now,
      });

      expect(result.qualified).toBe(false);
      expect(result.daysHeld).toBe(0);
    });

    it('tolerates a short gap (vacation) within maxGapDays without breaking the streak', () => {
      const result = evaluateHoldingPeriod({
        currentBand: { low: 70, high: 79 },
        minBand,
        minMonths,
        snapshots: [
          { computedFor: '2026-06-29', score: 70 },
          { computedFor: '2026-07-08', score: 70 },
          { computedFor: '2026-07-17', score: 70 },
          { computedFor: '2026-07-26', score: 70 },
          { computedFor: '2026-08-08', score: 70 }, // 13-day vacation gap, within 14-day tolerance
          { computedFor: '2026-08-18', score: 70 },
          { computedFor: '2026-09-01', score: 70 },
          { computedFor: '2026-09-15', score: 70 },
          { computedFor: '2026-09-27', score: 70 },
        ],
        now,
      });

      expect(result.qualified).toBe(true);
    });

    it('respects a custom maxGapDays override', () => {
      const result = evaluateHoldingPeriod({
        currentBand: { low: 70, high: 79 },
        minBand,
        minMonths,
        maxGapDays: 30,
        snapshots: [
          { computedFor: '2026-06-29', score: 70 },
          { computedFor: '2026-07-25', score: 70 }, // 26-day gap — fine with maxGapDays: 30
          { computedFor: '2026-08-20', score: 70 },
          { computedFor: '2026-09-27', score: 70 }, // 38-day gap — still under 30? no, this breaks it
        ],
        now,
      });

      // The last gap (2026-08-20 -> 2026-09-27 = 38 days) exceeds the
      // 30-day override, so only the 2026-08-20 -> now streak counts, and
      // that alone is below the 90-day requirement.
      expect(result.qualified).toBe(false);
    });
  });
});
