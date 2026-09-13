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

export function countStrengthSessions(activities: StravaActivity[]): Sample[] {
  const byWeek = new Map<string, number>();

  for (const activity of activities) {
    if (!STRENGTH_TYPES.has(activity.type)) continue;
    const date = new Date(activity.start_date);
    const weekStart = new Date(date);
    weekStart.setUTCDate(date.getUTCDate() - date.getUTCDay());
    weekStart.setUTCHours(0, 0, 0, 0);
    const key = weekStart.toISOString();
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

export function zone2MinutesFromZones(zones: StravaZonesResponse, measuredAt: string): Sample | null {
  const buckets = zones.heart_rate?.distribution_buckets;
  if (!buckets || !buckets[ZONE2_INDEX]) return null;

  const seconds = buckets[ZONE2_INDEX].time;
  return {
    metric: 'zone2_minutes',
    value: seconds / 60,
    unit: 'min',
    measuredAt,
    sourceKind: 'strava',
  };
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
  const zoneSamples = await Promise.all(withHr.map(async (activity) => {
    const res = await fetch(`https://www.strava.com/api/v3/activities/${activity.id}/zones`, { headers });
    const zones = await res.json() as StravaZonesResponse;
    return zone2MinutesFromZones(zones, activity.start_date);
  }));

  for (const sample of zoneSamples) {
    if (sample) samples.push(sample);
  }

  return samples;
}
