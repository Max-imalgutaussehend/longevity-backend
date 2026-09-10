import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import type { Sample } from '../score/types.js';

// Maps Apple Health HKQuantityTypeIdentifier → our metric + unit normalizer
const METRIC_MAP: Record<string, { metric: Sample['metric']; toValue: (v: number, unit: string) => number; unit: string }> = {
  HKQuantityTypeIdentifierVO2Max: {
    metric: 'vo2max',
    toValue: (v) => v,
    unit: 'ml/kg/min',
  },
  HKQuantityTypeIdentifierHeartRate: {
    metric: 'resting_hr',
    toValue: (v) => v,
    unit: 'bpm',
  },
  HKQuantityTypeIdentifierBloodPressureSystolic: {
    metric: 'systolic_bp',
    toValue: (v) => v,
    unit: 'mmHg',
  },
  HKQuantityTypeIdentifierWaistCircumference: {
    metric: 'waist',
    toValue: (v, unit) => unit === 'in' ? v * 2.54 : v,
    unit: 'cm',
  },
  HKQuantityTypeIdentifierSleepAnalysis: {
    metric: 'sleep_duration',
    toValue: (v) => v / 3600,
    unit: 'h',
  },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: {
    metric: 'hrv_rmssd',
    toValue: (v, unit) => unit === 's' ? v * 1000 : v,
    unit: 'ms',
  },
  HKQuantityTypeIdentifierStepCount: {
    metric: 'steps',
    toValue: (v) => v,
    unit: 'steps',
  },
};

// Minimal SAX-style line-by-line XML parser — no external deps.
// Apple Health export XML has one <Record ...> per line (or close to it).
const RECORD_RE = /<Record\s([^>]+)\/>/;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

export async function parseAppleHealthXml(stream: Readable): Promise<Sample[]> {
  const samples: Sample[] = [];
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const match = RECORD_RE.exec(line);
    if (!match) continue;

    const attrs = parseAttrs(match[1]);
    const type = attrs['type'];
    const mapping = METRIC_MAP[type];
    if (!mapping) continue;

    const rawValue = parseFloat(attrs['value']);
    if (isNaN(rawValue)) continue;

    const rawUnit = attrs['unit'] ?? '';
    const measuredAt = attrs['endDate'] ?? attrs['startDate'];
    if (!measuredAt) continue;

    samples.push({
      metric: mapping.metric,
      value: mapping.toValue(rawValue, rawUnit),
      unit: mapping.unit,
      measuredAt: new Date(measuredAt).toISOString(),
      sourceKind: 'apple_health',
    });
  }

  return samples;
}
