import yauzl from 'yauzl';
import { Readable } from 'node:stream';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

export function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(ZIP_MAGIC);
}

// Real Apple Health exports nest the XML under apple_health_export/Export.xml
// alongside export_cda.xml and workout-routes/*.gpx, which we ignore.
const EXPORT_XML_RE = /(^|\/)Export\.xml$/i;

export class AppleHealthZipError extends Error {}

export async function extractExportXml(zipBuffer: Buffer): Promise<Readable> {
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
          resolve(stream);
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
