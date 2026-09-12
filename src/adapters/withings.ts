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
  body: { measuregrps: WithingsMeasureGroup[] };
}

export interface WithingsActivityResponse {
  status: number;
  body: { activities: Array<{ date: string; steps: number }> };
}

export interface WithingsSleepResponse {
  status: number;
  body: { series: Array<{ startdate: number; enddate: number }> };
}

function scaledValue(measure: WithingsMeasure): number {
  return measure.value * 10 ** measure.unit;
}

export function parseWithingsMeasures(response: WithingsMeasureResponse): Sample[] {
  const samples: Sample[] = [];

  for (const group of response.body.measuregrps ?? []) {
    const measuredAt = new Date(group.date * 1000).toISOString();

    for (const measure of group.measures) {
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

export function parseWithingsActivity(response: WithingsActivityResponse): Sample[] {
  return (response.body.activities ?? []).map((a) => ({
    metric: 'steps' as const,
    value: a.steps,
    unit: 'steps',
    measuredAt: new Date(a.date).toISOString(),
    sourceKind: 'withings' as const,
  }));
}

export function parseWithingsSleep(response: WithingsSleepResponse): Sample[] {
  return (response.body.series ?? []).map((s) => ({
    metric: 'sleep_duration' as const,
    value: (s.enddate - s.startdate) / 3600,
    unit: 'h',
    measuredAt: new Date(s.enddate * 1000).toISOString(),
    sourceKind: 'withings' as const,
  }));
}

export async function fetchWithingsSamples(accessToken: string): Promise<Sample[]> {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' };

  const [measuresRes, activityRes, sleepRes] = await Promise.all([
    fetch('https://wbsapi.withings.net/measure?action=getmeas', { method: 'POST', headers }),
    fetch('https://wbsapi.withings.net/v2/activity?action=getactivity', { method: 'POST', headers }),
    fetch('https://wbsapi.withings.net/v2/sleep?action=get', { method: 'POST', headers }),
  ]);

  const [measures, activity, sleep] = await Promise.all([
    measuresRes.json() as Promise<WithingsMeasureResponse>,
    activityRes.json() as Promise<WithingsActivityResponse>,
    sleepRes.json() as Promise<WithingsSleepResponse>,
  ]);

  return [
    ...parseWithingsMeasures(measures),
    ...parseWithingsActivity(activity),
    ...parseWithingsSleep(sleep),
  ];
}
