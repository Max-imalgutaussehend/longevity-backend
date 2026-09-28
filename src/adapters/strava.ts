import type { Sample } from '../score/types.js';

const STRENGTH_TYPES = new Set(['WeightTraining', 'CrossFit']);
const ZONE2_INDEX = 1; // Strava heart-rate zones: [1] recovery, [2] endurance (zone 2), [3] tempo, [4] threshold, [5] anaerobic

interface StravaActivity {
  id: number;
  type: string;
  start_date: string;
  has_heartrate: boolean;
}

interface StravaZoneBucket {
  min: number;
  max: number;
  time: number;
}

interface StravaZonesResponse {
  heart_rate?: { distribution_buckets: StravaZoneBucket[] };
}

function weekStartIso(dateStr: string): string {
  const date = new Date(dateStr);
  const weekStart = new Date(date);
  weekStart.setUTCDate(date.getUTCDate() - date.getUTCDay());
  weekStart.setUTCHours(0, 0, 0, 0);
  return weekStart.toISOString();
}

export function countStrengthSessions(activities: StravaActivity[]): Sample[] {
  const byWeek = new Map<string, number>();

  for (const activity of activities) {
    if (!STRENGTH_TYPES.has(activity.type)) continue;
    const key = weekStartIso(activity.start_date);
    byWeek.set(key, (byWeek.get(key) ?? 0) + 1);
  }

  return [...byWeek.entries()].map(([weekStart, count]) => ({
    metric: 'strength_sessions' as const,
    value: count,
    unit: '/week',
    measuredAt: weekStart,
    sourceKind: 'strava' as const,
  }));
}

interface Zone2Activity {
  startDate: string;
  zones: StravaZonesResponse;
}

// Aggregates zone-2 minutes per calendar week (analogous to
// countStrengthSessions) instead of one sample per activity — computeScore
// takes only the latest sample per metric, so per-activity samples silently
// discarded every workout but the most recent one in the sync window.
export function zone2MinutesPerWeek(activities: Zone2Activity[]): Sample[] {
  const secondsByWeek = new Map<string, number>();

  for (const { startDate, zones } of activities) {
    const buckets = zones.heart_rate?.distribution_buckets;
    if (!buckets || !buckets[ZONE2_INDEX]) continue;
    const key = weekStartIso(startDate);
    secondsByWeek.set(key, (secondsByWeek.get(key) ?? 0) + buckets[ZONE2_INDEX].time);
  }

  return [...secondsByWeek.entries()].map(([weekStart, seconds]) => ({
    metric: 'zone2_minutes' as const,
    value: Math.round((seconds / 60) * 10) / 10,
    unit: 'min',
    measuredAt: weekStart,
    sourceKind: 'strava' as const,
  }));
}

export async function fetchStravaSamples(accessToken: string, sinceEpochSeconds: number): Promise<Sample[]> {
  const headers = { Authorization: `Bearer ${accessToken}` };

  const activitiesRes = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?after=${sinceEpochSeconds}&per_page=100`,
    { headers },
  );
  const activities = await activitiesRes.json() as StravaActivity[];

  const samples: Sample[] = countStrengthSessions(activities);

  const withHr = activities.filter((a) => a.has_heartrate);
  const zone2Activities = await Promise.all(withHr.map(async (activity) => {
    const res = await fetch(`https://www.strava.com/api/v3/activities/${activity.id}/zones`, { headers });
    const zones = await res.json() as StravaZonesResponse;
    return { startDate: activity.start_date, zones };
  }));

  samples.push(...zone2MinutesPerWeek(zone2Activities));

  return samples;
}
