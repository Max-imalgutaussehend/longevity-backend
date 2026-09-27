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
  const { currentBand, minBand, minMonths, snapshots, now = new Date() } = options;
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

  // Calculate unbroken streak of qualifying score from newest backwards
  let oldestConsecutiveQualifyingDate: Date | null = null;

  for (const s of normalizedSnapshots) {
    const bandLow = Math.min(90, Math.floor(s.score / 10) * 10);
    if (bandLow >= minBand) {
      oldestConsecutiveQualifyingDate = s.date;
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
