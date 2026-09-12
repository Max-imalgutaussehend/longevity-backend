import { describe, it, expect } from 'vitest';
import { parseFhir, type FhirInput } from '../../adapters/fhir.js';
import bundleFixture from '../__fixtures__/fhir_bundle.json';

describe('parseFhir — Bundle of Observations', () => {
  const bundle = bundleFixture as FhirInput;

  it('maps known LOINC codes to metrics', () => {
    const samples = parseFhir(bundle);
    const metrics = samples.map((s) => s.metric).sort();
    expect(metrics).toEqual(['hba1c', 'hdl', 'hscrp', 'ldl', 'systolic_bp']);
  });

  it('ignores Observations with unmapped LOINC codes', () => {
    const samples = parseFhir(bundle);
    expect(samples).toHaveLength(5); // 6 entries, 1 unmapped (total cholesterol)
  });

  it('tags every sample with sourceKind lab', () => {
    const samples = parseFhir(bundle);
    expect(samples.every((s) => s.sourceKind === 'lab')).toBe(true);
  });

  it('normalizes mmol/L to mg/dL for HDL', () => {
    const samples = parseFhir(bundle);
    const hdl = samples.find((s) => s.metric === 'hdl');
    expect(hdl).toBeDefined();
    expect(hdl?.value).toBeCloseTo(1.4 * 38.67, 1);
    expect(hdl?.unit).toBe('mg/dL');
  });

  it('leaves already-mg/dL values (LDL) untouched', () => {
    const samples = parseFhir(bundle);
    const ldl = samples.find((s) => s.metric === 'ldl');
    expect(ldl?.value).toBe(110);
  });
});

describe('parseFhir — single Observation resource', () => {
  it('parses a standalone Observation (not wrapped in a Bundle)', () => {
    const samples = parseFhir({
      resourceType: 'Observation',
      code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] },
      valueQuantity: { value: 122, unit: 'mmHg' },
      effectiveDateTime: '2024-06-01T08:00:00Z',
    });

    expect(samples).toHaveLength(1);
    expect(samples[0].metric).toBe('systolic_bp');
    expect(samples[0].value).toBe(122);
  });
});

describe('parseFhir — malformed input', () => {
  it('returns an empty array for an empty Bundle', () => {
    expect(parseFhir({ resourceType: 'Bundle', entry: [] })).toEqual([]);
  });

  it('skips Observations missing valueQuantity', () => {
    const samples = parseFhir({
      resourceType: 'Bundle',
      entry: [{ resource: { resourceType: 'Observation', code: { coding: [{ code: '13457-7' }] } } }],
    });
    expect(samples).toEqual([]);
  });
});
