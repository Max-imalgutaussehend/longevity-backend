import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import type { Sample } from '../score/types.js';

export interface AppleHealthOptions {
  userAge?: number;
  birthDate?: string | Date;
}

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
  HKQuantityTypeIdentifierRestingHeartRate: {
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

export const STRENGTH_WORKOUT_TYPES = new Set([
  'TraditionalStrengthTraining',
  'HKWorkoutActivityTypeTraditionalStrengthTraining',
  'FunctionalStrengthTraining',
  'HKWorkoutActivityTypeFunctionalStrengthTraining',
  'CrossTraining',
  'HKWorkoutActivityTypeCrossTraining',
]);

const RECORD_TAG_RE = /<Record\s([^>]+?)(\/?>)/;
const WORKOUT_OPEN_RE = /<Workout\s([^>]+?)(\/?>)/;
const WORKOUT_CLOSE_RE = /<\/Workout>/;
const CORRELATION_OPEN_RE = /<Correlation\s([^>]+?)(\/?>)/;
const CORRELATION_CLOSE_RE = /<\/Correlation>/;
const METADATA_TAG_RE = /<MetadataEntry\s([^>]+?)\/?>/;
const ME_TAG_RE = /<Me\s([^>]+?)\/?>/;
const ATTR_RE = /([A-Za-z0-9_:-]+)="([^"]*)"/g;

function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function resolveAge(options?: AppleHealthOptions, dobFromXml?: string): number {
  if (typeof options?.userAge === 'number' && !isNaN(options.userAge)) {
    return options.userAge;
  }
  const birthDateStr = options?.birthDate
    ? (options.birthDate instanceof Date ? options.birthDate.toISOString() : options.birthDate)
    : dobFromXml;

  if (birthDateStr) {
    const birthTime = new Date(birthDateStr).getTime();
    if (!isNaN(birthTime)) {
      const diffMs = Date.now() - birthTime;
      const age = diffMs / (1000 * 60 * 60 * 24 * 365.25);
      if (age > 0 && age < 120) return age;
    }
  }
  return 30; // Default fallback age
}

interface PendingWorkout {
  activityType: string;
  durationMinutes: number;
  measuredAt: string;
  startTime: number;
  endTime: number;
}

interface SleepOnsetEntry {
  minFromNoon: number;
  date: Date;
}

export async function parseAppleHealthXml(stream: Readable, options?: AppleHealthOptions): Promise<Sample[]> {
  const samples: Sample[] = [];
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let dobFromXml: string | undefined;
  let currentCorrelation: Record<string, string> | null = null;
  let currentWorkout: {
    attrs: Record<string, string>;
    metadata: Record<string, string>;
    heartRates: number[];
  } | null = null;

  const pendingWorkouts: PendingWorkout[] = [];
  const ambientHeartRates: Array<{ value: number; time: number }> = [];
  const sleepOnsetsByDay = new Map<string, SleepOnsetEntry>();

  function trackSleepOnset(startDateStr: string) {
    const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(startDateStr);
    if (!m) return;
    const [, y, mo, d, hStr, minStr] = m;
    const hour = parseInt(hStr, 10);
    const minute = parseInt(minStr, 10);

    const minFromNoon = hour >= 12 ? (hour - 12) * 60 + minute : (hour + 12) * 60 + minute;

    const recordDate = new Date(Date.UTC(parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10)));
    if (hour < 12) {
      recordDate.setUTCDate(recordDate.getUTCDate() - 1);
    }
    const dayKey = recordDate.toISOString().slice(0, 10);

    const existing = sleepOnsetsByDay.get(dayKey);
    const rawDate = new Date(startDateStr);
    if (!existing || minFromNoon < existing.minFromNoon) {
      sleepOnsetsByDay.set(dayKey, { minFromNoon, date: rawDate });
    }
  }

  function handleWorkout(
    attrs: Record<string, string>,
    metadata: Record<string, string>,
    heartRates: number[],
  ) {
    const activityType = attrs['workoutActivityType'] ?? '';
    const measuredAt = attrs['endDate'] ?? attrs['startDate'];
    if (!measuredAt) return;

    const normalizedType = activityType.replace(/^HKWorkoutActivityType/, '').trim();

    // 1. Strength workout check
    if (STRENGTH_WORKOUT_TYPES.has(activityType) || STRENGTH_WORKOUT_TYPES.has(normalizedType)) {
      samples.push({
        metric: 'strength_sessions',
        value: 1,
        unit: '/week',
        measuredAt: new Date(measuredAt).toISOString(),
        sourceKind: 'apple_health',
      });
      return;
    }

    // 2. Zone 2 duration calculation
    let durationMinutes = 0;
    const rawDuration = parseFloat(attrs['duration'] ?? '');
    if (!isNaN(rawDuration)) {
      const dUnit = (attrs['durationUnit'] ?? 'min').toLowerCase();
      if (dUnit === 's' || dUnit === 'sec' || dUnit === 'second' || dUnit === 'seconds') {
        durationMinutes = rawDuration / 60;
      } else if (dUnit === 'hr' || dUnit === 'h' || dUnit === 'hour' || dUnit === 'hours') {
        durationMinutes = rawDuration * 60;
      } else {
        durationMinutes = rawDuration;
      }
    } else if (attrs['startDate'] && attrs['endDate']) {
      durationMinutes = (new Date(attrs['endDate']).getTime() - new Date(attrs['startDate']).getTime()) / 60000;
    }

    if (durationMinutes <= 0) return;

    // 3. Heart rate detection
    let avgHr: number | null = null;
    const metaHr = metadata['HKAverageHeartRate'] ?? metadata['HKWorkoutAverageHeartRate'] ?? metadata['AverageHeartRate'];
    if (metaHr) {
      const val = parseFloat(metaHr);
      if (!isNaN(val)) avgHr = val;
    } else if (attrs['averageHeartRate'] || attrs['heartRate']) {
      const val = parseFloat(attrs['averageHeartRate'] ?? attrs['heartRate']);
      if (!isNaN(val)) avgHr = val;
    } else if (heartRates.length > 0) {
      avgHr = heartRates.reduce((a, b) => a + b, 0) / heartRates.length;
    }

    const startTime = attrs['startDate'] ? new Date(attrs['startDate']).getTime() : 0;
    const endTime = attrs['endDate'] ? new Date(attrs['endDate']).getTime() : startTime;

    if (avgHr === null) {
      if (startTime > 0) {
        pendingWorkouts.push({
          activityType,
          durationMinutes,
          measuredAt,
          startTime,
          endTime,
        });
      }
      return;
    }

    // 4. Zone 2 evaluation: HR between 60% and 70% HRmax (HRmax = 220 - Alter)
    const age = resolveAge(options, dobFromXml);
    const hrMax = 220 - age;
    const zone2Min = 0.60 * hrMax;
    const zone2Max = 0.70 * hrMax;

    if (avgHr >= zone2Min && avgHr <= zone2Max) {
      samples.push({
        metric: 'zone2_minutes',
        value: Math.round(durationMinutes * 10) / 10,
        unit: 'min',
        measuredAt: new Date(measuredAt).toISOString(),
        sourceKind: 'apple_health',
      });
    }
  }

  for await (const line of rl) {
    // ── <Me ...> ─────────────────────────────────────────────────────────────
    if (line.includes('<Me ')) {
      const meMatch = ME_TAG_RE.exec(line);
      if (meMatch) {
        const attrs = parseAttrs(meMatch[1]);
        if (attrs['HKCharacteristicTypeIdentifierDateOfBirth']) {
          dobFromXml = attrs['HKCharacteristicTypeIdentifierDateOfBirth'];
        }
      }
    }

    // ── <Correlation ...> ───────────────────────────────────────────────────
    if (line.includes('<Correlation ')) {
      const cMatch = CORRELATION_OPEN_RE.exec(line);
      if (cMatch) {
        const attrs = parseAttrs(cMatch[1]);
        const isClosed = cMatch[2] === '/>' || line.includes('</Correlation>');

        if (attrs['type'] === 'HKCorrelationTypeIdentifierBloodPressure') {
          if (attrs['value']) {
            const val = parseFloat(attrs['value']);
            const measuredAt = attrs['endDate'] ?? attrs['startDate'];
            if (!isNaN(val) && measuredAt) {
              samples.push({
                metric: 'systolic_bp',
                value: val,
                unit: attrs['unit'] ?? 'mmHg',
                measuredAt: new Date(measuredAt).toISOString(),
                sourceKind: 'apple_health',
              });
            }
          }
          if (!isClosed) {
            currentCorrelation = attrs;
          }
        }
      }
    }

    if (currentCorrelation && CORRELATION_CLOSE_RE.test(line)) {
      currentCorrelation = null;
    }

    // ── <Workout ...> ───────────────────────────────────────────────────────
    if (line.includes('<Workout ')) {
      const wMatch = WORKOUT_OPEN_RE.exec(line);
      if (wMatch) {
        const attrs = parseAttrs(wMatch[1]);
        const isClosed = wMatch[2] === '/>' || line.includes('</Workout>');

        if (isClosed) {
          handleWorkout(attrs, {}, []);
        } else {
          currentWorkout = { attrs, metadata: {}, heartRates: [] };
        }
      }
    }

    if (currentWorkout) {
      if (line.includes('<MetadataEntry ')) {
        const mMatch = METADATA_TAG_RE.exec(line);
        if (mMatch) {
          const mAttrs = parseAttrs(mMatch[1]);
          if (mAttrs['key'] && mAttrs['value']) {
            currentWorkout.metadata[mAttrs['key']] = mAttrs['value'];
          }
        }
      }

      if (line.includes('<Record ')) {
        const rMatch = RECORD_TAG_RE.exec(line);
        if (rMatch) {
          const rAttrs = parseAttrs(rMatch[1]);
          if (rAttrs['type'] === 'HKQuantityTypeIdentifierHeartRate') {
            const hr = parseFloat(rAttrs['value']);
            if (!isNaN(hr)) currentWorkout.heartRates.push(hr);
          }
        }
      }

      if (WORKOUT_CLOSE_RE.test(line)) {
        handleWorkout(currentWorkout.attrs, currentWorkout.metadata, currentWorkout.heartRates);
        currentWorkout = null;
      }
    }

    // ── <Record ...> ────────────────────────────────────────────────────────
    if (line.includes('<Record ')) {
      const match = RECORD_TAG_RE.exec(line);
      if (!match) continue;

      const attrs = parseAttrs(match[1]);
      const type = attrs['type'];

      // Blood Pressure Systolic (standalone or inside Correlation)
      if (
        type === 'HKQuantityTypeIdentifierBloodPressureSystolic' ||
        (currentCorrelation?.['type'] === 'HKCorrelationTypeIdentifierBloodPressure' && type?.includes('BloodPressureSystolic'))
      ) {
        const rawValue = parseFloat(attrs['value']);
        if (!isNaN(rawValue)) {
          const measuredAt = attrs['endDate'] ?? attrs['startDate'] ?? currentCorrelation?.['endDate'] ?? currentCorrelation?.['startDate'];
          if (measuredAt) {
            samples.push({
              metric: 'systolic_bp',
              value: rawValue,
              unit: attrs['unit'] ?? 'mmHg',
              measuredAt: new Date(measuredAt).toISOString(),
              sourceKind: 'apple_health',
            });
            continue;
          }
        }
      }

      // Sleep Analysis (Category or Quantity identifier)
      if (type === 'HKCategoryTypeIdentifierSleepAnalysis' || type === 'HKQuantityTypeIdentifierSleepAnalysis') {
        const isAwake = (attrs['value'] ?? '').toLowerCase().includes('awake');
        let durationHours = 0;

        const rawValue = parseFloat(attrs['value']);
        if (!isNaN(rawValue)) {
          durationHours = rawValue / 3600;
        } else if (attrs['startDate'] && attrs['endDate']) {
          durationHours = (new Date(attrs['endDate']).getTime() - new Date(attrs['startDate']).getTime()) / (1000 * 3600);
        }

        const measuredAt = attrs['endDate'] ?? attrs['startDate'];
        if (!isAwake && durationHours > 0 && measuredAt) {
          samples.push({
            metric: 'sleep_duration',
            value: Math.round(durationHours * 100) / 100,
            unit: 'h',
            measuredAt: new Date(measuredAt).toISOString(),
            sourceKind: 'apple_health',
          });
        }

        if (!isAwake && attrs['startDate']) {
          trackSleepOnset(attrs['startDate']);
        }
        continue;
      }

      // Heart rate (collect for ambient workout matching + existing resting_hr mapping)
      if (type === 'HKQuantityTypeIdentifierHeartRate') {
        const hr = parseFloat(attrs['value']);
        const measuredAt = attrs['endDate'] ?? attrs['startDate'];
        if (!isNaN(hr) && measuredAt) {
          ambientHeartRates.push({ value: hr, time: new Date(measuredAt).getTime() });
          samples.push({
            metric: 'resting_hr',
            value: hr,
            unit: attrs['unit'] ?? 'bpm',
            measuredAt: new Date(measuredAt).toISOString(),
            sourceKind: 'apple_health',
          });
          continue;
        }
      }

      // Standard quantity mappings
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
  }

  // ── Post-stream: resolve pending workouts with ambient HR ─────────────────
  if (pendingWorkouts.length > 0 && ambientHeartRates.length > 0) {
    const age = resolveAge(options, dobFromXml);
    const hrMax = 220 - age;
    const zone2Min = 0.60 * hrMax;
    const zone2Max = 0.70 * hrMax;

    for (const pw of pendingWorkouts) {
      const matchingHrs = ambientHeartRates
        .filter((hr) => hr.time >= pw.startTime && hr.time <= pw.endTime)
        .map((hr) => hr.value);

      if (matchingHrs.length > 0) {
        const avgHr = matchingHrs.reduce((a, b) => a + b, 0) / matchingHrs.length;
        if (avgHr >= zone2Min && avgHr <= zone2Max) {
          samples.push({
            metric: 'zone2_minutes',
            value: Math.round(pw.durationMinutes * 10) / 10,
            unit: 'min',
            measuredAt: new Date(pw.measuredAt).toISOString(),
            sourceKind: 'apple_health',
          });
        }
      }
    }
  }

  // ── Post-stream: calculate sleep consistency (StdDev of sleep onset times) ─
  if (sleepOnsetsByDay.size >= 2) {
    const entries = Array.from(sleepOnsetsByDay.values());
    const minutesList = entries.map((e) => e.minFromNoon);
    const mean = minutesList.reduce((sum, v) => sum + v, 0) / minutesList.length;
    const variance = minutesList.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (minutesList.length - 1);
    const stdDev = Math.sqrt(variance);

    const latestDate = entries.reduce((latest, curr) => (curr.date > latest ? curr.date : latest), entries[0].date);

    samples.push({
      metric: 'sleep_consistency',
      value: Math.round(stdDev * 10) / 10,
      unit: 'min',
      measuredAt: latestDate.toISOString(),
      sourceKind: 'apple_health',
    });
  }

  return samples;
}
