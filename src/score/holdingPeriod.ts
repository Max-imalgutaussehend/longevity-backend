export interface SnapshotHistoryItem {
  computedFor: string | Date;
  score: number;
}

export interface HoldingPeriodOptions {
  currentBand: { low: number; high: number };
  minBand: number;
  minMonths?: number | null;
  snapshots: SnapshotHistoryItem[];
  now?: Date;
  /**
   * Maximum allowed gap (in days) between two consecutive qualifying
   * snapshots before the streak is considered broken. Snapshots are only
   * written when a user visits the dashboard (no daily cron), so a strict
   * day-by-day requirement would break legitimate holding periods for any
   * user who doesn't check in every single day. Defaults to 14 (tolerates
   * roughly bi-weekly check-ins).
   */
  maxGapDays?: number;
}

export interface HoldingPeriodResult {
  qualified: boolean;
  requiredMonths: number;
  requiredDays: number;
  daysHeld: number;
  daysRemaining: number;
}

/**
 * Evaluates whether a user qualifies for a partner offer based on the minimum
 * score band and an optional required continuous holding duration (in months).
 */
export function evaluateHoldingPeriod(options: HoldingPeriodOptions): HoldingPeriodResult {
  const { currentBand, minBand, minMonths, snapshots, now = new Date(), maxGapDays = 14 } = options;
  const requiredMonths = minMonths && minMonths > 0 ? minMonths : 0;
  const requiredDays = requiredMonths * 30;

  // If current band does not meet the minimum requirement, never qualified
  if (currentBand.low < minBand) {
    return {
      qualified: false,
      requiredMonths,
      requiredDays,
      daysHeld: 0,
      daysRemaining: requiredDays,
    };
  }

  // If no holding period is required and current band qualifies
  if (requiredMonths === 0) {
    return {
      qualified: true,
      requiredMonths: 0,
      requiredDays: 0,
      daysHeld: 0,
      daysRemaining: 0,
    };
  }

  // Parse and sort snapshots chronologically descending (newest first)
  const normalizedSnapshots = snapshots
    .map((s) => ({
      date: typeof s.computedFor === 'string' ? new Date(s.computedFor) : s.computedFor,
      score: s.score,
    }))
    .filter((s) => !isNaN(s.date.getTime()) && s.date.getTime() <= now.getTime())
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  if (normalizedSnapshots.length === 0) {
    return {
      qualified: false,
      requiredMonths,
      requiredDays,
      daysHeld: 0,
      daysRemaining: requiredDays,
    };
  }

  // Calculate unbroken streak of qualifying score from newest backwards.
  // A gap of more than maxGapDays between now/consecutive snapshots — not
  // just a single non-qualifying score — also breaks the streak, since
  // snapshots are only written on dashboard visits (no daily cron) and a
  // sparse or stale history shouldn't silently count as continuous holding.
  const maxGapMs = maxGapDays * 24 * 60 * 60 * 1000;
  let oldestConsecutiveQualifyingDate: Date | null = null;
  let previousDate = now;

  for (const s of normalizedSnapshots) {
    if (previousDate.getTime() - s.date.getTime() > maxGapMs) {
      // Gap since the previous (more recent) point is too large — streak broke.
      break;
    }
    const bandLow = Math.min(90, Math.floor(s.score / 10) * 10);
    if (bandLow >= minBand) {
      oldestConsecutiveQualifyingDate = s.date;
      previousDate = s.date;
    } else {
      // Streak broke here!
      break;
    }
  }

  if (!oldestConsecutiveQualifyingDate) {
    return {
      qualified: false,
      requiredMonths,
      requiredDays,
      daysHeld: 0,
      daysRemaining: requiredDays,
    };
  }

  const msHeld = Math.max(0, now.getTime() - oldestConsecutiveQualifyingDate.getTime());
  const daysHeld = Math.floor(msHeld / (24 * 60 * 60 * 1000));
  const qualified = daysHeld >= requiredDays;
  const daysRemaining = Math.max(0, requiredDays - daysHeld);

  return {
    qualified,
    requiredMonths,
    requiredDays,
    daysHeld,
    daysRemaining,
  };
}
