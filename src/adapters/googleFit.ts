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

export async function fetchGoogleFitSamples(accessToken: string): Promise<Sample[]> {
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
    throw new Error(`Google Fit aggregate request failed: ${res.status}`);
  }

  const data = await res.json() as GoogleFitAggregateResponse;
  return parseGoogleFitAggregate(data);
}
