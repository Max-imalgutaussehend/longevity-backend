import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikeZip, extractExportXml, AppleHealthZipError } from '../../adapters/appleHealthZip.js';
import { parseAppleHealthXml } from '../../adapters/appleHealth.js';

const fixturePath = join(__dirname, '..', '__fixtures__', 'apple_health_mini.zip');

function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(c as Buffer));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

describe('looksLikeZip', () => {
  it('detects a real ZIP by its magic bytes', () => {
    const zipBuffer = readFileSync(fixturePath);
    expect(looksLikeZip(zipBuffer)).toBe(true);
  });

  it('returns false for plain XML content', () => {
    const xmlBuffer = Buffer.from('<?xml version="1.0"?><HealthData></HealthData>');
    expect(looksLikeZip(xmlBuffer)).toBe(false);
  });

  it('returns false for a buffer shorter than the magic number', () => {
    expect(looksLikeZip(Buffer.from('PK'))).toBe(false);
  });
});

describe('extractExportXml', () => {
  it('extracts apple_health_export/Export.xml, ignoring export_cda.xml and gpx routes', async () => {
    const zipBuffer = readFileSync(fixturePath);
    const stream = await extractExportXml(zipBuffer);
    const content = await streamToString(stream);

    expect(content).toContain('HKQuantityTypeIdentifierVO2Max');
    expect(content).not.toContain('ClinicalDocument');
  });

  it('feeds correctly into parseAppleHealthXml end-to-end', async () => {
    const zipBuffer = readFileSync(fixturePath);
    const stream = await extractExportXml(zipBuffer);
    const samples = await parseAppleHealthXml(stream);

    expect(samples.some((s) => s.metric === 'vo2max' && s.value === 44)).toBe(true);
    expect(samples.some((s) => s.metric === 'steps' && s.value === 9001)).toBe(true);
  });

  it('rejects a ZIP with no Export.xml entry', async () => {
    // A trivially valid empty zip (PK\x05\x06 end-of-central-directory record, no entries)
    const emptyZip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
    await expect(extractExportXml(emptyZip)).rejects.toThrow(AppleHealthZipError);
  });

  it('rejects a buffer that is not a valid ZIP at all', async () => {
    const notAZip = Buffer.from('this is not a zip file');
    await expect(extractExportXml(notAZip)).rejects.toThrow(AppleHealthZipError);
  });
});
