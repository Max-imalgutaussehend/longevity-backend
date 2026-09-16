import type { Sample } from '../score/types.js';

// Withings "getmeas" encodes measurement types numerically.
// 9 = systolic BP, 10 = diastolic BP, 11 = pulse, 6 = BMI, 88 = fat mass.
const MEASURE_TYPE_SYSTOLIC = 9;
const MEASURE_TYPE_PULSE = 11;

interface WithingsMeasure {
  value: number;
  type: number;
  unit: number;
}

interface WithingsMeasureGroup {
  date: number;
  measures: WithingsMeasure[];
}

export interface WithingsMeasureResponse {
  status: number;
  body?: { measuregrps?: WithingsMeasureGroup[] };
  error?: string;
}

export interface WithingsActivityResponse {
  status: number;
  body?: { activities?: Array<{ date: string; steps: number }> };
  error?: string;
}

export interface WithingsSleepResponse {
  status: number;
  body?: {
    series?: Array<{
      startdate?: number;
      enddate?: number;
      date?: string;
      data?: { total_sleep_time?: number };
    }>;
  };
  error?: string;
}

function scaledValue(measure: WithingsMeasure): number {
  return measure.value * 10 ** measure.unit;
}

function safeIsoDate(val: string | number | undefined | null): string {
  if (val == null) return new Date().toISOString();
  const d = typeof val === 'number' ? new Date(val * 1000) : new Date(val);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function parseWithingsMeasures(response?: WithingsMeasureResponse | null): Sample[] {
  if (!response || response.status !== 0 || !response.body?.measuregrps) {
    return [];
  }

  const samples: Sample[] = [];

  for (const group of response.body.measuregrps) {
    const measuredAt = safeIsoDate(group.date);

    for (const measure of group.measures ?? []) {
      if (measure.type === MEASURE_TYPE_SYSTOLIC) {
        samples.push({
          metric: 'systolic_bp',
          value: scaledValue(measure),
          unit: 'mmHg',
          measuredAt,
          sourceKind: 'withings',
        });
      } else if (measure.type === MEASURE_TYPE_PULSE) {
        samples.push({
          metric: 'resting_hr',
          value: scaledValue(measure),
          unit: 'bpm',
          measuredAt,
          sourceKind: 'withings',
        });
      }
    }
  }

  return samples;
}

export function parseWithingsActivity(response?: WithingsActivityResponse | null): Sample[] {
  if (!response || response.status !== 0 || !response.body?.activities) {
    return [];
  }

  return response.body.activities
    .filter((a) => a && typeof a.steps === 'number' && !isNaN(a.steps))
    .map((a) => ({
      metric: 'steps' as const,
      value: a.steps,
      unit: 'steps',
      measuredAt: safeIsoDate(a.date),
      sourceKind: 'withings' as const,
    }));
}

export function parseWithingsSleep(response?: WithingsSleepResponse | null): Sample[] {
  if (!response || response.status !== 0 || !response.body?.series) {
    return [];
  }

  return response.body.series.flatMap((s) => {
    if (!s) return [];

    let hours = 0;
    if (s.data?.total_sleep_time != null && typeof s.data.total_sleep_time === 'number') {
      hours = s.data.total_sleep_time / 3600;
    } else if (typeof s.startdate === 'number' && typeof s.enddate === 'number' && s.enddate > s.startdate) {
      hours = (s.enddate - s.startdate) / 3600;
    }

    if (hours <= 0 || !Number.isFinite(hours)) return [];

    const measuredAt = s.enddate ? safeIsoDate(s.enddate) : safeIsoDate(s.date);
    return [{
      metric: 'sleep_duration' as const,
      value: Math.round(hours * 100) / 100,
      unit: 'h',
      measuredAt,
      sourceKind: 'withings' as const,
    }];
  });
}

export async function fetchWithingsSamples(accessToken: string): Promise<Sample[]> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  const now = new Date();
  const past30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const startdateymd = past30Days.toISOString().slice(0, 10);
  const enddateymd = now.toISOString().slice(0, 10);
  const startdateUnix = Math.floor(past30Days.getTime() / 1000);

  const fetchSafe = async <T>(url: string, body: URLSearchParams): Promise<T | null> => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { status?: number };
      if (typeof data.status === 'number' && data.status !== 0) {
        return null;
      }
      return data as T;
    } catch {
      return null;
    }
  };

  const [measures, activity, sleep] = await Promise.all([
    fetchSafe<WithingsMeasureResponse>(
      'https://wbsapi.withings.net/measure',
      new URLSearchParams({
        action: 'getmeas',
        category: '1',
        startdate: String(startdateUnix),
      }),
    ),
    fetchSafe<WithingsActivityResponse>(
      'https://wbsapi.withings.net/v2/activity',
      new URLSearchParams({
        action: 'getactivity',
        startdateymd,
        enddateymd,
        data_fields: 'steps',
      }),
    ),
    fetchSafe<WithingsSleepResponse>(
      'https://wbsapi.withings.net/v2/sleep',
      new URLSearchParams({
        action: 'getsummary',
        startdateymd,
        enddateymd,
        data_fields: 'total_sleep_time',
      }),
    ),
  ]);

  return [
    ...parseWithingsMeasures(measures),
    ...parseWithingsActivity(activity),
    ...parseWithingsSleep(sleep),
  ];
}
