import type { Sample } from '../score/types.js';

interface OuraSleepEntry {
  day: string;
  total_sleep_duration: number;
  bedtime_start: string;
}

interface OuraReadinessEntry {
  day: string;
  timestamp: string;
  contributors: { hrv_balance?: number };
  temperature_deviation?: number;
}

interface OuraActivityEntry {
  day: string;
  timestamp: string;
  steps: number;
  met: { items: number[]; interval: number };
  average_met_minutes?: number;
}

export interface OuraSleepResponse { data: OuraSleepEntry[] }
export interface OuraReadinessResponse { data: (OuraReadinessEntry & { average_hrv?: number; resting_heart_rate?: number })[] }
export interface OuraActivityResponse { data: OuraActivityEntry[] }

const ZONE2_MET_MIN = 3;
const ZONE2_MET_MAX = 6;

function daySampleTime(day: string): string {
  return new Date(`${day}T12:00:00.000Z`).toISOString();
}

export function parseOuraSleep(response: OuraSleepResponse): Sample[] {
  const byDay: Sample[] = [];
  const bedtimes: number[] = [];

  for (const entry of response.data ?? []) {
    byDay.push({
      metric: 'sleep_duration',
      value: entry.total_sleep_duration / 3600,
      unit: 'h',
      measuredAt: daySampleTime(entry.day),
      sourceKind: 'oura',
    });
    bedtimes.push(new Date(entry.bedtime_start).getHours() * 60 + new Date(entry.bedtime_start).getMinutes());
  }

  if (bedtimes.length >= 2) {
    const mean = bedtimes.reduce((a, b) => a + b, 0) / bedtimes.length;
    const variance = bedtimes.reduce((a, b) => a + (b - mean) ** 2, 0) / bedtimes.length;
    const sd = Math.sqrt(variance);
    const lastDay = response.data[response.data.length - 1].day;
    byDay.push({
      metric: 'sleep_consistency',
      value: sd,
      unit: 'min',
      measuredAt: daySampleTime(lastDay),
      sourceKind: 'oura',
    });
  }

  return byDay;
}

export function parseOuraReadiness(response: OuraReadinessResponse): Sample[] {
  const samples: Sample[] = [];

  for (const entry of response.data ?? []) {
    const measuredAt = daySampleTime(entry.day);
    if (typeof entry.average_hrv === 'number') {
      samples.push({ metric: 'hrv_rmssd', value: entry.average_hrv, unit: 'ms', measuredAt, sourceKind: 'oura' });
    }
    if (typeof entry.resting_heart_rate === 'number') {
      samples.push({ metric: 'resting_hr', value: entry.resting_heart_rate, unit: 'bpm', measuredAt, sourceKind: 'oura' });
    }
  }

  return samples;
}

export function parseOuraActivity(response: OuraActivityResponse): Sample[] {
  const samples: Sample[] = [];

  for (const entry of response.data ?? []) {
    const measuredAt = daySampleTime(entry.day);
    samples.push({ metric: 'steps', value: entry.steps, unit: 'steps', measuredAt, sourceKind: 'oura' });

    const items = entry.met?.items ?? [];
    const interval = entry.met?.interval ?? 60;
    const zone2Seconds = items.filter((m) => m >= ZONE2_MET_MIN && m < ZONE2_MET_MAX).length * interval;
    samples.push({ metric: 'zone2_minutes', value: zone2Seconds / 60, unit: 'min', measuredAt, sourceKind: 'oura' });
  }

  return samples;
}

export async function fetchOuraSamples(accessToken: string): Promise<Sample[]> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);
  const query = `start_date=${start.toISOString().slice(0, 10)}&end_date=${end.toISOString().slice(0, 10)}`;

  const [sleepRes, readinessRes, activityRes] = await Promise.all([
    fetch(`https://api.ouraring.com/v2/usercollection/daily_sleep?${query}`, { headers }),
    fetch(`https://api.ouraring.com/v2/usercollection/daily_readiness?${query}`, { headers }),
    fetch(`https://api.ouraring.com/v2/usercollection/daily_activity?${query}`, { headers }),
  ]);

  const [sleep, readiness, activity] = await Promise.all([
    sleepRes.json() as Promise<OuraSleepResponse>,
    readinessRes.json() as Promise<OuraReadinessResponse>,
    activityRes.json() as Promise<OuraActivityResponse>,
  ]);

  return [
    ...parseOuraSleep(sleep),
    ...parseOuraReadiness(readiness),
    ...parseOuraActivity(activity),
  ];
}
