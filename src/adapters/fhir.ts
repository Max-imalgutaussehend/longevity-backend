import type { Sample } from '../score/types.js';

// LOINC code → our metric key + unit normalizer
const LOINC_MAP: Record<string, {
  metric: Extract<Sample['metric'], 'ldl' | 'hdl' | 'hba1c' | 'hscrp' | 'systolic_bp'>;
  toMgDl?: boolean;  // convert mmol/L → mg/dL (cholesterol)
  toPercent?: boolean;  // convert mmol/mol → %  (HbA1c IFCC)
  unit: string;
}> = {
  '13457-7': { metric: 'ldl',        toMgDl: true,    unit: 'mg/dL' },
  '2085-9':  { metric: 'hdl',        toMgDl: true,    unit: 'mg/dL' },
  '4548-4':  { metric: 'hba1c',      toPercent: true, unit: '%'     },
  '30522-7': { metric: 'hscrp',                       unit: 'mg/L'  },
  '8480-6':  { metric: 'systolic_bp',                 unit: 'mmHg'  },
};

interface FhirQuantity {
  value?: number;
  unit?: string;
}

interface FhirCoding {
  system?: string;
  code?: string;
}

interface FhirObservation {
  resourceType: 'Observation';
  code?: { coding?: FhirCoding[] };
  valueQuantity?: FhirQuantity;
  effectiveDateTime?: string;
  effectivePeriod?: { start?: string; end?: string };
}

interface FhirBundle {
  resourceType: 'Bundle';
  entry?: Array<{ resource?: unknown }>;
}

function normalizeUnit(value: number, unit: string | undefined, toMgDl?: boolean, toPercent?: boolean): number {
  const u = (unit ?? '').toLowerCase().replace(/\s/g, '');

  if (toMgDl) {
    if (u === 'mmol/l') return Math.round(value * 38.67 * 10) / 10;
    return value;
  }

  if (toPercent) {
    // HbA1c IFCC (mmol/mol) → DCCT/NGSP (%)
    if (u === 'mmol/mol') return Math.round(((value / 10.929) + 2.15) * 10) / 10;
    return value;
  }

  // hsCRP: mg/dL → mg/L
  if (u === 'mg/dl') return value * 10;
  // μg/L → mg/L
  if (u === 'µg/l' || u === 'ug/l') return value / 1000;

  return value;
}

function parseDate(obs: FhirObservation): Date {
  const dt = obs.effectiveDateTime ?? obs.effectivePeriod?.end ?? obs.effectivePeriod?.start;
  return dt ? new Date(dt) : new Date();
}

function extractObservations(resource: unknown): FhirObservation[] {
  if (!resource || typeof resource !== 'object') return [];
  const r = resource as { resourceType?: string };

  if (r.resourceType === 'Observation') return [r as FhirObservation];

  if (r.resourceType === 'Bundle') {
    const bundle = r as FhirBundle;
    return (bundle.entry ?? [])
      .map((e) => e.resource)
      .flatMap((res) => extractObservations(res));
  }

  return [];
}

export function parseFhirBundle(json: unknown): Sample[] {
  const observations = extractObservations(json);
  const results: Sample[] = [];

  for (const obs of observations) {
    const coding = obs.code?.coding ?? [];
    const loincCode = coding.find((c) => c.system === 'http://loinc.org')?.code;
    if (!loincCode) continue;

    const mapping = LOINC_MAP[loincCode];
    if (!mapping) continue;

    const raw = obs.valueQuantity?.value;
    if (raw === undefined || raw === null) continue;

    const value = normalizeUnit(raw, obs.valueQuantity?.unit, mapping.toMgDl, mapping.toPercent);

    results.push({
      metric: mapping.metric,
      value,
      unit: mapping.unit,
      measuredAt: parseDate(obs).toISOString(),
      sourceKind: 'lab',
    });
  }

  return results;
}
