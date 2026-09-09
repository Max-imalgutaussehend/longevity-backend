import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';

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
  const sign = createSign('SHA512');
  sign.update(payload);
  sign.end();
  return sign.sign(privateKeyPem, 'base64url');
}

export function verifyTokenSignature(payload: string, signature: string, publicKeyPem: string): boolean {
  try {
    const verify = createVerify('SHA512');
    verify.update(payload);
    verify.end();
    return verify.verify(publicKeyPem, signature, 'base64url');
  } catch {
    return false;
  }
}

export function buildTokenPayload(tokenId: string, bandLow: number, bandHigh: number, expiresAt: string): string {
  return `${tokenId}:${bandLow}:${bandHigh}:${expiresAt}`;
}
