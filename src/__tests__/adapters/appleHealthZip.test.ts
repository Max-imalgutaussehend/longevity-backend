import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikeZip, extractExportXml, AppleHealthZipError } from '../../adapters/appleHealthZip.js';
import { parseAppleHealthXml } from '../../adapters/appleHealth.js';
import { buildTestZip } from '../helpers/buildTestZip.js';

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

describe('extractExportXml — zip-bomb protection (#109)', () => {
  it('rejects an entry whose declared uncompressedSize exceeds the limit, without reading it', async () => {
    const content = Buffer.from('<HealthData>small on disk</HealthData>');
    const zipBuf = buildTestZip('apple_health_export/Export.xml', content, {
      declaredUncompressedSize: 10 * 1024 * 1024, // lies: claims 10MB
    });

    await expect(extractExportXml(zipBuf, 1024)).rejects.toThrow(AppleHealthZipError);
  });

  it('aborts streaming once real decompressed bytes exceed the limit, even if the header understates the size', async () => {
    // Highly compressible payload: header claims a tiny uncompressedSize (a
    // lie an attacker fully controls), but the real decompressed output is
    // much larger — the byte-counting transform must catch this at read time.
    const bombContent = Buffer.alloc(64 * 1024, 0); // compresses to a few hundred bytes
    const zipBuf = buildTestZip('apple_health_export/Export.xml', bombContent, {
      declaredUncompressedSize: 10, // lies: understates real size
    });

    const stream = await extractExportXml(zipBuf, 1024); // limit far below the real 64KB payload

    await expect(
      new Promise((resolve, reject) => {
        let total = 0;
        stream.on('data', (c) => { total += (c as Buffer).length; });
        stream.on('end', () => resolve(total));
        stream.on('error', reject);
      }),
    ).rejects.toThrow(AppleHealthZipError);
  });

  it('accepts a small archive comfortably under the limit', async () => {
    const content = Buffer.from('<HealthData>fits easily</HealthData>');
    const zipBuf = buildTestZip('apple_health_export/Export.xml', content);

    const stream = await extractExportXml(zipBuf, 1024 * 1024);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c) => chunks.push(c as Buffer));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    expect(Buffer.concat(chunks).toString('utf8')).toBe(content.toString('utf8'));
  });
});
