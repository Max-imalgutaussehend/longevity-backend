import type { Sample } from '../score/types.js';
import { LOINC_MAP, normalizeUnit } from './loinc.js';

interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

interface FhirCodeableConcept {
  coding?: FhirCoding[];
}

interface FhirQuantity {
  value?: number;
  unit?: string;
}

interface FhirObservation {
  resourceType: 'Observation';
  code?: FhirCodeableConcept;
  valueQuantity?: FhirQuantity;
  effectiveDateTime?: string;
  issued?: string;
}

interface FhirBundleEntry {
  resource?: FhirObservation | { resourceType: string };
}

interface FhirBundle {
  resourceType: 'Bundle';
  entry?: FhirBundleEntry[];
}

export type FhirInput = FhirBundle | FhirObservation;

function isObservation(resource: unknown): resource is FhirObservation {
  return !!resource && typeof resource === 'object' && (resource as { resourceType?: string }).resourceType === 'Observation';
}

function loincCode(observation: FhirObservation): string | null {
  const codings = observation.code?.coding ?? [];
  const loinc = codings.find((c) => c.system?.includes('loinc') || /^\d{1,5}-\d$/.test(c.code ?? ''));
  return loinc?.code ?? null;
}

function parseObservation(observation: FhirObservation): Sample | null {
  const code = loincCode(observation);
  if (!code) return null;

  const mapping = LOINC_MAP[code];
  if (!mapping) return null;

  const quantity = observation.valueQuantity;
  if (!quantity || typeof quantity.value !== 'number') return null;

  const measuredAt = observation.effectiveDateTime ?? observation.issued;
  if (!measuredAt) return null;

  const value = normalizeUnit(mapping.metric, quantity.value, quantity.unit ?? mapping.unit);

  return {
    metric: mapping.metric,
    value,
    unit: mapping.unit,
    measuredAt: new Date(measuredAt).toISOString(),
    sourceKind: 'lab',
  };
}

export function parseFhir(input: FhirInput): Sample[] {
  const observations: FhirObservation[] = input.resourceType === 'Bundle'
    ? (input.entry ?? []).map((e) => e.resource).filter(isObservation)
    : (isObservation(input) ? [input] : []);

  const samples: Sample[] = [];
  for (const observation of observations) {
    const sample = parseObservation(observation);
    if (sample) samples.push(sample);
  }

  return samples;
}
