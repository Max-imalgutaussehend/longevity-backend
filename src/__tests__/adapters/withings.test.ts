import { describe, it, expect } from 'vitest';
import {
  parseWithingsMeasures,
  parseWithingsActivity,
  parseWithingsSleep,
  fetchWithingsSamples,
  type WithingsMeasureResponse,
} from '../../adapters/withings.js';
import rawFixture from '../__fixtures__/withings_getmeas.json';

const fixture = rawFixture as WithingsMeasureResponse;

describe('parseWithingsMeasures', () => {
  it('maps type 9 to systolic_bp and type 11 to resting_hr, ignoring diastolic (type 10)', () => {
    const samples = parseWithingsMeasures(fixture);

    const systolic = samples.filter(s => s.metric === 'systolic_bp');
    const hr = samples.filter(s => s.metric === 'resting_hr');
    const diastolic = samples.filter(s => (s.metric as string) === 'diastolic_bp');

    expect(systolic).toHaveLength(2);
    expect(hr).toHaveLength(2);
    expect(diastolic).toHaveLength(0);
  });

  it('applies the Withings unit scale (value * 10^unit)', () => {
    const samples = parseWithingsMeasures(fixture);
    const systolic = samples.filter(s => s.metric === 'systolic_bp');

    expect(systolic[0].value).toBe(122);
    expect(systolic[1].value).toBeCloseTo(118.5, 5);
  });

  it('tags every sample with sourceKind withings', () => {
    const samples = parseWithingsMeasures(fixture);
    expect(samples.every(s => s.sourceKind === 'withings')).toBe(true);
  });

  it('returns an empty array when there are no measure groups', () => {
    const samples = parseWithingsMeasures({ status: 0, body: { measuregrps: [] } });
    expect(samples).toEqual([]);
  });
});

describe('parseWithingsActivity', () => {
  it('maps steps per day', () => {
    const samples = parseWithingsActivity({
      status: 0,
      body: { activities: [{ date: '2024-06-01', steps: 8421 }] },
    });

    expect(samples).toEqual([{
      metric: 'steps',
      value: 8421,
      unit: 'steps',
      measuredAt: new Date('2024-06-01').toISOString(),
      sourceKind: 'withings',
    }]);
  });
});

describe('parseWithingsSleep', () => {
  it('converts start/end timestamps into sleep duration in hours', () => {
    const startdate = 1717200000;
    const enddate = startdate + 7.5 * 3600;

    const samples = parseWithingsSleep({ status: 0, body: { series: [{ startdate, enddate }] } });

    expect(samples).toHaveLength(1);
    expect(samples[0].metric).toBe('sleep_duration');
    expect(samples[0].value).toBeCloseTo(7.5, 5);
    expect(samples[0].sourceKind).toBe('withings');
  });

  it('safely handles invalid date values without throwing', () => {
    const samples = parseWithingsSleep({
      status: 0,
      body: { series: [{ startdate: 1717200000, enddate: 1717200000 + 3600, date: 'invalid-date' }] },
    });
    expect(samples).toHaveLength(1);
    expect(isNaN(new Date(samples[0].measuredAt).getTime())).toBe(false);
  });

  it('supports getsummary format with data.total_sleep_time', () => {
    const samples = parseWithingsSleep({
      status: 0,
      body: {
        series: [{
          date: '2024-06-01',
          data: { total_sleep_time: 28800 },
        }],
      },
    });
    expect(samples).toHaveLength(1);
    expect(samples[0].metric).toBe('sleep_duration');
    expect(samples[0].value).toBe(8);
  });

  it('safely returns empty array when body is undefined or status is non-zero', () => {
    expect(parseWithingsMeasures(null)).toEqual([]);
    expect(parseWithingsMeasures({ status: 247, error: 'invalid params' })).toEqual([]);
    expect(parseWithingsActivity(null)).toEqual([]);
    expect(parseWithingsActivity({ status: 247, error: 'invalid params' })).toEqual([]);
    expect(parseWithingsSleep(null)).toEqual([]);
    expect(parseWithingsSleep({ status: 247, error: 'invalid params' })).toEqual([]);
  });
});

describe('fetchWithingsSamples', () => {
  it('sends correct parameters and aggregates samples even if one endpoint fails', async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    const requestedBodies: string[] = [];

    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      requestedUrls.push(String(url));
      requestedBodies.push(init?.body ? String(init.body) : '');

      const urlStr = String(url);
      if (urlStr.includes('/measure')) {
        return {
          ok: true,
          json: async () => fixture,
        } as unknown as Response;
      }
      if (urlStr.includes('/activity')) {
        // Simulate endpoint returning an error response without body
        return {
          ok: true,
          json: async () => ({ status: 247, error: 'The syntax of the request or its parameters is incorrect' }),
        } as unknown as Response;
      }
      if (urlStr.includes('/sleep')) {
        return {
          ok: true,
          json: async () => ({
            status: 0,
            body: {
              series: [{
                date: '2024-06-01',
                data: { total_sleep_time: 27000 },
              }],
            },
          }),
        } as unknown as Response;
      }
      return { ok: false, json: async () => ({}) } as unknown as Response;
    }) as typeof globalThis.fetch;

    try {
      const samples = await fetchWithingsSamples('fake-token');

      // Check endpoints were called
      expect(requestedUrls.some((u) => u.includes('/measure'))).toBe(true);
      expect(requestedUrls.some((u) => u.includes('/activity'))).toBe(true);
      expect(requestedUrls.some((u) => u.includes('/sleep'))).toBe(true);

      // Check request bodies contained required parameters
      expect(requestedBodies.some((b) => b.includes('action=getactivity') && b.includes('startdateymd='))).toBe(true);
      expect(requestedBodies.some((b) => b.includes('action=getsummary') && b.includes('data_fields='))).toBe(true);

      // Verify that failure in activity endpoint did not crash sync; measures and sleep samples still returned
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.some((s) => s.metric === 'systolic_bp')).toBe(true);
      expect(samples.some((s) => s.metric === 'sleep_duration')).toBe(true);
      expect(samples.some((s) => s.metric === 'steps')).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
