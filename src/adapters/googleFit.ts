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

        const endMs = Number(BigInt(point.endTimeNanos) / 1_000_000n);
        const measuredAt = endMs > Date.now()
          ? new Date().toISOString()
          : nanosToIso(point.endTimeNanos);

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
  name?: string;
  createTime?: string;
  updateTime?: string;
  dataSourceId?: string;
  origin?: string;
  metadata?: {
    dataOrigin?: { packageName?: string };
    device?: { manufacturer?: string; model?: string; type?: string };
    recordingMethod?: string;
    clientRecordId?: string;
    id?: string;
  };
  steps?: {
    count?: string | number;
    interval?: {
      startTime?: string;
      endTime?: string;
      civilStartTime?: { date?: { year?: number; month?: number; day?: number } };
      civilEndTime?: { date?: { year?: number; month?: number; day?: number } };
    };
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
  exercise?: {
    exerciseType?: string;
    displayName?: string;
    activeDuration?: string;
    interval?: { startTime?: string; endTime?: string };
  };
}

function getOriginPriority(origin: string): number {
  const o = origin.toLowerCase();
  if (o.includes('com.google.android.apps.fitness')) return 100;
  if (o.includes('com.google.android.gms')) return 95;
  if (o.includes('google')) return 90;
  if (o.includes('fitbit')) return 80;
  if (o.includes('fitness') || o.includes('health')) return 70;
  if (o.length > 0) return 50;
  return 10;
}

export function parseGoogleHealthV4DataPoints(dataType: string, dataPoints: GoogleHealthDataPoint[]): Sample[] {
  const samples: Sample[] = [];
  if (!Array.isArray(dataPoints)) return samples;

  if (dataType === 'steps') {
    interface ParsedStepPoint {
      count: number;
      startMs: number | null;
      endMs: number | null;
      durationMs: number;
      isCumulative: boolean;
      origin: string;
    }

    const pointsByDay = new Map<string, ParsedStepPoint[]>();

    for (const dp of dataPoints) {
      if (dp.steps?.count === undefined) continue;
      const count = Number(dp.steps.count);
      if (Number.isNaN(count) || count <= 0) continue;

      let dayStr: string | null = null;
      const cDate = dp.steps.interval?.civilStartTime?.date;
      if (cDate?.year && cDate?.month && cDate?.day) {
        dayStr = `${cDate.year}-${String(cDate.month).padStart(2, '0')}-${String(cDate.day).padStart(2, '0')}`;
      } else {
        const iso = dp.steps.interval?.endTime ?? dp.steps.interval?.startTime;
        if (iso) dayStr = iso.slice(0, 10);
      }
      if (!dayStr) continue;

      const startIso = dp.steps.interval?.startTime;
      const endIso = dp.steps.interval?.endTime;
      const startMs = startIso ? new Date(startIso).getTime() : null;
      const endMs = endIso ? new Date(endIso).getTime() : null;
      const durationMs = (startMs !== null && endMs !== null && endMs > startMs) ? (endMs - startMs) : 0;
      // An interval spanning >= 12 hours represents a full-day cumulative summary record
      const isCumulative = durationMs >= 12 * 3600 * 1000;

      const origin = dp.metadata?.dataOrigin?.packageName
        ?? dp.dataSourceId
        ?? dp.origin
        ?? '';

      const list = pointsByDay.get(dayStr) ?? [];
      list.push({ count, startMs, endMs, durationMs, isCumulative, origin });
      pointsByDay.set(dayStr, list);
    }

    const todayStr = new Date().toISOString().slice(0, 10);

    for (const [dayStr, dayPoints] of pointsByDay.entries()) {
      // Group points by origin
      const byOrigin = new Map<string, ParsedStepPoint[]>();
      for (const pt of dayPoints) {
        const list = byOrigin.get(pt.origin) ?? [];
        list.push(pt);
        byOrigin.set(pt.origin, list);
      }

      // Compute total for each origin
      const originTotals = new Map<string, number>();
      for (const [origin, pts] of byOrigin.entries()) {
        const cumulativePts = pts.filter(p => p.isCumulative);
        if (cumulativePts.length > 0) {
          // If cumulative records exist for this origin, use the max cumulative record
          originTotals.set(origin, Math.max(...cumulativePts.map(p => p.count)));
        } else {
          // Otherwise, sum intraday non-cumulative records
          const intradaySum = pts.reduce((sum, p) => sum + p.count, 0);
          originTotals.set(origin, intradaySum);
        }
      }

      // Sort origins by priority descending
      const sortedOrigins = Array.from(originTotals.entries()).sort(
        (a, b) => getOriginPriority(b[0]) - getOriginPriority(a[0]),
      );

      // Take the top priority origin's count to avoid summing multiple apps/devices together
      let finalCount = sortedOrigins[0]?.[1] ?? 0;

      // Fallback: if finalCount is 0, check for any cumulative record
      if (finalCount <= 0) {
        const allCumulative = dayPoints.filter(p => p.isCumulative);
        if (allCumulative.length > 0) {
          finalCount = Math.max(...allCumulative.map(p => p.count));
        }
      }

      if (finalCount <= 0) continue;

      const measuredAt = dayStr === todayStr
        ? new Date().toISOString()
        : `${dayStr}T12:00:00.000Z`;

      samples.push({
        metric: 'steps',
        value: finalCount,
        unit: 'steps',
        measuredAt,
        sourceKind: 'google_fit',
      });
    }
  } else if (dataType === 'exercise') {
    const dailyExerciseZone2 = new Map<string, number>();

    for (const dp of dataPoints) {
      if (!dp.exercise) continue;
      const exType = (dp.exercise.exerciseType ?? '').toUpperCase();
      const rawMeasuredAt = dp.exercise.interval?.endTime ?? dp.exercise.interval?.startTime ?? new Date().toISOString();
      const measuredAt = new Date(rawMeasuredAt).getTime() > Date.now()
        ? new Date().toISOString()
        : rawMeasuredAt;

      const isStrength = exType.includes('STRENGTH') || exType.includes('WEIGHT') || exType.includes('CALISTHENICS');
      if (isStrength) {
        samples.push({
          metric: 'strength_sessions',
          value: 1,
          unit: '/week',
          measuredAt,
          sourceKind: 'google_fit',
        });
      } else if (dp.exercise.activeDuration) {
        const secs = parseFloat(dp.exercise.activeDuration);
        if (!Number.isNaN(secs) && secs >= 600) {
          const mins = Math.round((secs / 60) * 10) / 10;
          const dayStr = measuredAt.slice(0, 10);
          dailyExerciseZone2.set(dayStr, (dailyExerciseZone2.get(dayStr) ?? 0) + mins);
        }
      }
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    for (const [dayStr, totalMins] of dailyExerciseZone2.entries()) {
      const measuredAt = dayStr === todayStr
        ? new Date().toISOString()
        : `${dayStr}T12:00:00.000Z`;

      samples.push({
        metric: 'zone2_minutes',
        value: Math.round(totalMins * 10) / 10,
        unit: 'min',
        measuredAt,
        sourceKind: 'google_fit',
      });
    }
  } else if (dataType === 'daily-resting-heart-rate') {
    for (const dp of dataPoints) {
      if (dp.dailyRestingHeartRate?.beatsPerMinute === undefined) continue;
      const value = Number(dp.dailyRestingHeartRate.beatsPerMinute);
      const d = dp.dailyRestingHeartRate.date;
      const measuredAt = d?.year && d?.month && d?.day
        ? new Date(Date.UTC(d.year, d.month - 1, d.day, 12, 0, 0)).toISOString()
        : new Date().toISOString();
      if (!Number.isNaN(value)) {
        samples.push({ metric: 'resting_hr', value, unit: 'bpm', measuredAt, sourceKind: 'google_fit' });
      }
    }
  } else if (dataType === 'sleep') {
    for (const dp of dataPoints) {
      const start = dp.sleep?.interval?.startTime;
      const end = dp.sleep?.interval?.endTime;
      if (start && end) {
        const hours = (new Date(end).getTime() - new Date(start).getTime()) / 3600000;
        if (hours > 0) {
          samples.push({ metric: 'sleep_duration', value: Math.round(hours * 100) / 100, unit: 'h', measuredAt: end, sourceKind: 'google_fit' });
        }
      }
    }
  } else if (dataType === 'active-minutes') {
    const dailyActiveMins = new Map<string, number>();

    for (const dp of dataPoints) {
      if (!dp.activeMinutes) continue;
      const levels = dp.activeMinutes.activeMinutesByActivityLevel ?? [];
      const totalMinutes = levels.reduce((acc, l) => acc + (Number(l.activeMinutes) || 0), 0);
      if (totalMinutes <= 0) continue;

      let dayStr: string | null = null;
      const iso = dp.activeMinutes.interval?.endTime ?? dp.activeMinutes.interval?.startTime;
      if (iso) dayStr = iso.slice(0, 10);
      if (!dayStr) continue;

      dailyActiveMins.set(dayStr, (dailyActiveMins.get(dayStr) ?? 0) + totalMinutes);
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    for (const [dayStr, totalMinutes] of dailyActiveMins.entries()) {
      const measuredAt = dayStr === todayStr
        ? new Date().toISOString()
        : `${dayStr}T12:00:00.000Z`;

      samples.push({
        metric: 'zone2_minutes',
        value: Math.round(totalMinutes * 10) / 10,
        unit: 'min',
        measuredAt,
        sourceKind: 'google_fit',
      });
    }
  } else if (dataType === 'daily-vo2-max') {
    for (const dp of dataPoints) {
      if (dp.dailyVo2Max?.vo2MaxMlPerKgPerMinute === undefined) continue;
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

function extractOldestTimestamp(dp: GoogleHealthDataPoint, dt: string): string | null {
  if (dt === 'steps') {
    const c = dp.steps?.interval?.civilStartTime?.date;
    if (c?.year && c?.month && c?.day) {
      return `${c.year}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}T00:00:00.000Z`;
    }
    return dp.steps?.interval?.startTime ?? dp.steps?.interval?.endTime ?? null;
  }
  if (dt === 'exercise') {
    return dp.exercise?.interval?.startTime ?? dp.exercise?.interval?.endTime ?? null;
  }
  if (dt === 'daily-resting-heart-rate') {
    const d = dp.dailyRestingHeartRate?.date;
    if (d?.year && d?.month && d?.day) {
      return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}T12:00:00.000Z`;
    }
  }
  if (dt === 'sleep') {
    return dp.sleep?.interval?.startTime ?? dp.sleep?.interval?.endTime ?? null;
  }
  if (dt === 'active-minutes') {
    return dp.activeMinutes?.interval?.startTime ?? dp.activeMinutes?.interval?.endTime ?? null;
  }
  if (dt === 'daily-vo2-max') {
    const d = dp.dailyVo2Max?.date;
    if (d?.year && d?.month && d?.day) {
      return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}T12:00:00.000Z`;
    }
  }
  return null;
}

export function consolidateDailyZone2Samples(samples: Sample[]): Sample[] {
  const nonZone2: Sample[] = [];
  const zone2ByDay = new Map<string, Sample>();

  for (const s of samples) {
    if (s.metric !== 'zone2_minutes') {
      nonZone2.push(s);
      continue;
    }

    const dayStr = s.measuredAt.slice(0, 10);
    const existing = zone2ByDay.get(dayStr);
    if (!existing) {
      zone2ByDay.set(dayStr, s);
    } else {
      // Keep the higher value between active minutes and exercise active duration
      if (s.value > existing.value) {
        zone2ByDay.set(dayStr, s);
      }
    }
  }

  return [...nonZone2, ...zone2ByDay.values()];
}

async function fetchGoogleHealthV4Samples(accessToken: string): Promise<Sample[]> {
  const dataTypes = ['steps', 'exercise', 'daily-resting-heart-rate', 'sleep', 'active-minutes', 'daily-vo2-max'];
  const samples: Sample[] = [];
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

  for (const dt of dataTypes) {
    let pageToken: string | undefined = undefined;
    let pageCount = 0;
    const maxPages = dt === 'steps' ? 25 : 5;
    const pageSize = dt === 'steps' ? 5000 : 1000;
    const allRawPoints: GoogleHealthDataPoint[] = [];

    while (pageCount < maxPages) {
      pageCount++;
      try {
        const url = new URL(`https://health.googleapis.com/v4/users/me/dataTypes/${dt}/dataPoints`);
        url.searchParams.set('pageSize', String(pageSize));
        if (pageToken) {
          url.searchParams.set('pageToken', pageToken);
        }

        const res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.warn(`[GoogleHealthV4] ${dt} returned HTTP ${res.status}: ${text.slice(0, 150)}`);
          break;
        }

        const data = await res.json() as {
          dataPoints?: GoogleHealthDataPoint[];
          points?: GoogleHealthDataPoint[];
          nextPageToken?: string;
        };

        const rawPoints = data.dataPoints ?? data.points ?? [];
        if (rawPoints.length === 0) break;

        allRawPoints.push(...rawPoints);

        const oldestPoint = rawPoints[rawPoints.length - 1];
        const oldestTime = extractOldestTimestamp(oldestPoint, dt);
        if (oldestTime && new Date(oldestTime) < oneYearAgo) {
          break;
        }

        pageToken = data.nextPageToken;
        if (!pageToken) break;
      } catch (err) {
        console.warn(`[GoogleHealthV4] ${dt} fetch error on page ${pageCount}:`, err);
        break;
      }
    }

    if (allRawPoints.length > 0) {
      samples.push(...parseGoogleHealthV4DataPoints(dt, allRawPoints));
    }
  }

  return consolidateDailyZone2Samples(samples);
}

export async function fetchGoogleFitSamples(accessToken: string): Promise<Sample[]> {
  // First try modern Google Health API v4
  const v4Samples = await fetchGoogleHealthV4Samples(accessToken);
  if (v4Samples.length > 0) {
    return v4Samples;
  }

  // Fall back to Google Fit REST aggregate API
  const nowDate = new Date();
  const startDate = new Date(Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate() - 90,
    0, 0, 0, 0,
  ));
  const startTimeMillis = startDate.getTime();
  const endTimeMillis = nowDate.getTime();

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
      startTimeMillis,
      endTimeMillis,
    }),
  });

  if (!res.ok) {
    // If neither returned samples and fitness aggregate failed, return whatever we have or empty
    return [];
  }

  const data = await res.json() as GoogleFitAggregateResponse;
  return parseGoogleFitAggregate(data);
}

