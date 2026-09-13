import { describe, it, expect } from 'vitest';
import { parseFhirBundle } from '../../adapters/fhir.js';
import fixture from '../__fixtures__/fhir_bundle.json';

describe('parseFhirBundle', () => {
  it('parses all known LOINC codes from a Bundle', () => {
    const samples = parseFhirBundle(fixture);
    expect(samples).toHaveLength(5);
    const metrics = samples.map((s) => s.metric);
    expect(metrics).toContain('ldl');
    expect(metrics).toContain('hdl');
    expect(metrics).toContain('hba1c');
    expect(metrics).toContain('hscrp');
    expect(metrics).toContain('systolic_bp');
  });

  it('skips unknown LOINC codes', () => {
    const samples = parseFhirBundle(fixture);
    expect(samples.every((s) => s.metric !== undefined)).toBe(true);
    expect(samples).toHaveLength(5); // not 6 — unknown-1 is skipped
  });

  it('keeps LDL in mg/dL unchanged', () => {
    const samples = parseFhirBundle(fixture);
    const ldl = samples.find((s) => s.metric === 'ldl');
    expect(ldl?.value).toBe(110);
    expect(ldl?.unit).toBe('mg/dL');
  });

  it('converts HDL from mmol/L to mg/dL', () => {
    const samples = parseFhirBundle(fixture);
    const hdl = samples.find((s) => s.metric === 'hdl');
    // 1.4 mmol/L * 38.67 ≈ 54.1 mg/dL
    expect(hdl?.unit).toBe('mg/dL');
    expect(hdl?.value).toBeCloseTo(54.1, 0);
  });

  it('keeps HbA1c in % unchanged', () => {
    const samples = parseFhirBundle(fixture);
    const hba1c = samples.find((s) => s.metric === 'hba1c');
    expect(hba1c?.value).toBe(5.4);
    expect(hba1c?.unit).toBe('%');
  });

  it('keeps hsCRP in mg/L unchanged', () => {
    const samples = parseFhirBundle(fixture);
    const hscrp = samples.find((s) => s.metric === 'hscrp');
    expect(hscrp?.value).toBe(0.8);
    expect(hscrp?.unit).toBe('mg/L');
  });

  it('keeps systolic BP in mmHg unchanged (mm[Hg] unit code)', () => {
    const samples = parseFhirBundle(fixture);
    const bp = samples.find((s) => s.metric === 'systolic_bp');
    expect(bp?.value).toBe(118);
    expect(bp?.unit).toBe('mmHg');
  });

  it('sets sourceKind to lab', () => {
    const samples = parseFhirBundle(fixture);
    expect(samples.every((s) => s.sourceKind === 'lab')).toBe(true);
  });

  it('parses a single Observation (not wrapped in Bundle)', () => {
    const singleObs = {
      resourceType: 'Observation',
      code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] },
      valueQuantity: { value: 42, unit: 'mmol/mol' },
      effectiveDateTime: '2026-01-01',
    };
    const samples = parseFhirBundle(singleObs);
    expect(samples).toHaveLength(1);
    // 42 mmol/mol → (42/10.929) + 2.15 ≈ 6.0 %
    expect(samples[0].metric).toBe('hba1c');
    expect(samples[0].value).toBeCloseTo(6.0, 0);
    expect(samples[0].unit).toBe('%');
  });

  it('returns empty array for empty Bundle', () => {
    expect(parseFhirBundle({ resourceType: 'Bundle', entry: [] })).toEqual([]);
  });

  it('returns empty array for invalid input', () => {
    expect(parseFhirBundle(null)).toEqual([]);
    expect(parseFhirBundle({})).toEqual([]);
    expect(parseFhirBundle('not json')).toEqual([]);
  });
});
