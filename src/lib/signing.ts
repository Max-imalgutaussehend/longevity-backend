import { generateKeyPairSync, sign, verify } from 'node:crypto';

export interface SigningKeys {
  privateKey: string;
  publicKey: string;
}

export function generateEd25519KeyPair(): SigningKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

export function signTokenPayload(payload: string, privateKeyPem: string): string {
  return sign(null, Buffer.from(payload, 'utf8'), privateKeyPem).toString('base64url');
}

export function verifyTokenSignature(payload: string, signature: string, publicKeyPem: string): boolean {
  try {
    return verify(null, Buffer.from(payload, 'utf8'), publicKeyPem, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

export function buildTokenPayload(tokenId: string, bandLow: number, bandHigh: number, expiresAt: string): string {
  return `${tokenId}:${bandLow}:${bandHigh}:${expiresAt}`;
}
