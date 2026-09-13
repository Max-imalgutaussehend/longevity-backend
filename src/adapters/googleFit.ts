import type { Sample } from '../score/types.js';

// Google Fit REST data type names used in the aggregate response buckets.
const DATA_TYPE_STEPS = 'com.google.step_count.delta';
const DATA_TYPE_HEART_RATE = 'com.google.heart_rate.bpm';
const DATA_TYPE_SLEEP = 'com.google.sleep.segment';
const DATA_TYPE_ACTIVE_MINUTES = 'com.google.active_minutes';

interface GoogleFitValue {
  intVal?: number;
  fpVal?: number;
}

interface GoogleFitPoint {
  startTimeNanos: string;
  endTimeNanos: string;
  dataTypeName: string;
  value: GoogleFitValue[];
}

interface GoogleFitDataset {
  dataSourceId: string;
  point: GoogleFitPoint[];
}

interface GoogleFitBucket {
  startTimeMillis: string;
  endTimeMillis: string;
  dataset: GoogleFitDataset[];
}

export interface GoogleFitAggregateResponse {
  bucket: GoogleFitBucket[];
}

function nanosToIso(nanos: string): string {
  return new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();
}

function pointValue(point: GoogleFitPoint): number | null {
  const v = point.value[0];
  if (!v) return null;
  return v.intVal ?? v.fpVal ?? null;
}

export function parseGoogleFitAggregate(response: GoogleFitAggregateResponse): Sample[] {
  const samples: Sample[] = [];

  for (const bucket of response.bucket ?? []) {
    for (const dataset of bucket.dataset ?? []) {
      for (const point of dataset.point ?? []) {
        const value = pointValue(point);
        if (value === null) continue;

        const measuredAt = nanosToIso(point.endTimeNanos);

        if (point.dataTypeName === DATA_TYPE_STEPS) {
          samples.push({ metric: 'steps', value, unit: 'steps', measuredAt, sourceKind: 'google_fit' });
        } else if (point.dataTypeName === DATA_TYPE_HEART_RATE) {
          samples.push({ metric: 'resting_hr', value, unit: 'bpm', measuredAt, sourceKind: 'google_fit' });
        } else if (point.dataTypeName === DATA_TYPE_SLEEP) {
          const startNanos = BigInt(point.startTimeNanos);
          const endNanos = BigInt(point.endTimeNanos);
          const hours = Number(endNanos - startNanos) / 1e9 / 3600;
          samples.push({ metric: 'sleep_duration', value: hours, unit: 'h', measuredAt, sourceKind: 'google_fit' });
        } else if (point.dataTypeName === DATA_TYPE_ACTIVE_MINUTES) {
          samples.push({ metric: 'zone2_minutes', value, unit: 'min', measuredAt, sourceKind: 'google_fit' });
        }
      }
    }
  }

  return samples;
}

export interface GoogleHealthDataPoint {
  steps?: {
    count?: string | number;
    interval?: { startTime?: string; endTime?: string };
  };
  dailyRestingHeartRate?: {
    beatsPerMinute?: string | number;
    date?: { year?: number; month?: number; day?: number };
  };
  sleep?: {
    interval?: { startTime?: string; endTime?: string };
  };
  activeMinutes?: {
    interval?: { startTime?: string; endTime?: string };
    activeMinutesByActivityLevel?: Array<{ activeMinutes?: number }>;
  };
  dailyVo2Max?: {
    vo2MaxMlPerKgPerMinute?: number;
    date?: { year?: number; month?: number; day?: number };
  };
}

export function parseGoogleHealthV4DataPoints(dataType: string, dataPoints: GoogleHealthDataPoint[]): Sample[] {
  const samples: Sample[] = [];
  if (!Array.isArray(dataPoints)) return samples;

  for (const dp of dataPoints) {
    if (dataType === 'steps' && dp.steps?.count !== undefined) {
      const value = Number(dp.steps.count);
      const measuredAt = dp.steps.interval?.endTime ?? dp.steps.interval?.startTime ?? new Date().toISOString();
      if (!Number.isNaN(value)) {
        samples.push({ metric: 'steps', value, unit: 'steps', measuredAt, sourceKind: 'google_fit' });
      }
    } else if (dataType === 'daily-resting-heart-rate' && dp.dailyRestingHeartRate?.beatsPerMinute !== undefined) {
      const value = Number(dp.dailyRestingHeartRate.beatsPerMinute);
      const d = dp.dailyRestingHeartRate.date;
      const measuredAt = d?.year && d?.month && d?.day
        ? new Date(Date.UTC(d.year, d.month - 1, d.day, 12, 0, 0)).toISOString()
        : new Date().toISOString();
      if (!Number.isNaN(value)) {
        samples.push({ metric: 'resting_hr', value, unit: 'bpm', measuredAt, sourceKind: 'google_fit' });
      }
    } else if (dataType === 'sleep' && dp.sleep?.interval) {
      const start = dp.sleep.interval.startTime;
      const end = dp.sleep.interval.endTime;
      if (start && end) {
        const hours = (new Date(end).getTime() - new Date(start).getTime()) / 3600000;
        if (hours > 0) {
          samples.push({ metric: 'sleep_duration', value: hours, unit: 'h', measuredAt: end, sourceKind: 'google_fit' });
        }
      }
    } else if (dataType === 'active-minutes' && dp.activeMinutes) {
      const levels = dp.activeMinutes.activeMinutesByActivityLevel ?? [];
      const totalMinutes = levels.reduce((acc, l) => acc + (Number(l.activeMinutes) || 0), 0);
      const measuredAt = dp.activeMinutes.interval?.endTime ?? new Date().toISOString();
      if (totalMinutes > 0) {
        samples.push({ metric: 'zone2_minutes', value: totalMinutes, unit: 'min', measuredAt, sourceKind: 'google_fit' });
      }
    } else if (dataType === 'daily-vo2-max' && dp.dailyVo2Max?.vo2MaxMlPerKgPerMinute !== undefined) {
      const value = Number(dp.dailyVo2Max.vo2MaxMlPerKgPerMinute);
      const d = dp.dailyVo2Max.date;
      const measuredAt = d?.year && d?.month && d?.day
        ? new Date(Date.UTC(d.year, d.month - 1, d.day, 12, 0, 0)).toISOString()
        : new Date().toISOString();
      if (!Number.isNaN(value)) {
        samples.push({ metric: 'vo2max', value, unit: 'ml/kg/min', measuredAt, sourceKind: 'google_fit' });
      }
    }
  }

  return samples;
}

async function fetchGoogleHealthV4Samples(accessToken: string): Promise<Sample[]> {
  const dataTypes = ['steps', 'daily-resting-heart-rate', 'sleep', 'active-minutes', 'daily-vo2-max'];
  const samples: Sample[] = [];

  for (const dt of dataTypes) {
    try {
      const res = await fetch(`https://health.googleapis.com/v4/users/me/dataTypes/${dt}/dataPoints?pageSize=100`, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json() as { dataPoints?: GoogleHealthDataPoint[] };
      if (data.dataPoints) {
        samples.push(...parseGoogleHealthV4DataPoints(dt, data.dataPoints));
      }
    } catch {
      // Continue to next data type or fallback
    }
  }

  return samples;
}

export async function fetchGoogleFitSamples(accessToken: string): Promise<Sample[]> {
  // First try modern Google Health API v4
  const v4Samples = await fetchGoogleHealthV4Samples(accessToken);
  if (v4Samples.length > 0) {
    return v4Samples;
  }

  // Fall back to Google Fit REST aggregate API
  const now = Date.now();
  const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;

  const res = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      aggregateBy: [
        { dataTypeName: DATA_TYPE_STEPS },
        { dataTypeName: DATA_TYPE_HEART_RATE },
        { dataTypeName: DATA_TYPE_SLEEP },
        { dataTypeName: DATA_TYPE_ACTIVE_MINUTES },
      ],
      bucketByTime: { durationMillis: 24 * 60 * 60 * 1000 },
      startTimeMillis: ninetyDaysAgo,
      endTimeMillis: now,
    }),
  });

  if (!res.ok) {
    // If neither returned samples and fitness aggregate failed, return whatever we have or empty
    return [];
  }

  const data = await res.json() as GoogleFitAggregateResponse;
  return parseGoogleFitAggregate(data);
}

