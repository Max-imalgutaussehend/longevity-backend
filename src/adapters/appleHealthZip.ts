import yauzl from 'yauzl';
import { PassThrough, Readable, Transform } from 'node:stream';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

export function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(ZIP_MAGIC);
}

// Real Apple Health exports nest the XML under apple_health_export/Export.xml
// alongside export_cda.xml and workout-routes/*.gpx, which we ignore.
const EXPORT_XML_RE = /(^|\/)Export\.xml$/i;

// Guards against zip-bomb decompression: a small compressed archive that
// expands to an unbounded size and exhausts memory/CPU while streaming.
export const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

export class AppleHealthZipError extends Error {}

function boundedByteCounter(limit: number, onExceeded: () => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk, _enc, callback) {
      total += chunk.length;
      if (total > limit) {
        onExceeded();
        callback(new AppleHealthZipError('Das entpackte Archiv überschreitet die zulässige Maximalgröße.'));
        return;
      }
      callback(null, chunk);
    },
  });
}

export async function extractExportXml(zipBuffer: Buffer, maxUncompressedBytes: number = MAX_UNCOMPRESSED_BYTES): Promise<Readable> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(new AppleHealthZipError('Die Datei ist kein gültiges ZIP-Archiv.'));
        return;
      }

      let found = false;

      zipfile.on('error', () => {
        zipfile.close();
        reject(new AppleHealthZipError('Das ZIP-Archiv konnte nicht gelesen werden.'));
      });

      zipfile.on('entry', (entry) => {
        if (found) return;

        if (!EXPORT_XML_RE.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        if (entry.uncompressedSize > maxUncompressedBytes) {
          zipfile.close();
          reject(new AppleHealthZipError('Das entpackte Archiv überschreitet die zulässige Maximalgröße.'));
          return;
        }

        found = true;
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            zipfile.close();
            reject(new AppleHealthZipError('Export.xml konnte im ZIP nicht geöffnet werden.'));
            return;
          }
          // The zipfile handle (central directory state) is no longer needed
          // once the entry's own read stream is open — release it explicitly
          // rather than relying on readEntry()/'end' to ever fire again.
          stream.on('end', () => zipfile.close());

          const bounded = boundedByteCounter(maxUncompressedBytes, () => {
            stream.unpipe();
            stream.destroy();
            zipfile.close();
          });
          const output = new PassThrough();
          stream.on('error', () => output.destroy(new AppleHealthZipError('Das entpackte Archiv überschreitet die zulässige Maximalgröße oder ist beschädigt.')));
          stream.pipe(bounded).pipe(output);
          bounded.on('error', (boundedErr) => output.destroy(boundedErr));
          resolve(output);
        });
      });

      zipfile.on('end', () => {
        if (!found) {
          reject(new AppleHealthZipError('Im ZIP-Archiv wurde keine apple_health_export/Export.xml gefunden.'));
        }
      });

      zipfile.readEntry();
    });
  });
}
