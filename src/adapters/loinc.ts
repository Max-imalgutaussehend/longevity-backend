import type { Sample } from '../score/types.js';

export const LOINC_MAP: Record<string, { metric: Sample['metric']; unit: string }> = {
  '13457-7': { metric: 'ldl', unit: 'mg/dL' },
  '2085-9': { metric: 'hdl', unit: 'mg/dL' },
  '4548-4': { metric: 'hba1c', unit: '%' },
  '30522-7': { metric: 'hscrp', unit: 'mg/L' },
  '8480-6': { metric: 'systolic_bp', unit: 'mmHg' },
};

// mmol/L → mg/dL for cholesterol values (LDL/HDL): factor 38.67
const MMOL_TO_MGDL_LIPIDS = 38.67;

export function normalizeUnit(metric: Sample['metric'], value: number, unit: string): number {
  const u = unit.toLowerCase();

  if ((metric === 'ldl' || metric === 'hdl') && (u === 'mmol/l' || u === 'mmol/dl')) {
    return value * MMOL_TO_MGDL_LIPIDS;
  }

  if (metric === 'hba1c' && (u === 'mmol/mol')) {
    // IFCC mmol/mol → NGSP %
    return (value / 10.929) + 2.15;
  }

  return value;
}
