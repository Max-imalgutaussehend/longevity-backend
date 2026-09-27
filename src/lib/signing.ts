import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from 'node:crypto';

export interface SigningKeys {
  privateKey: string;
  publicKey: string;
}

export interface Ed25519Jwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
}

let devKeyPair: SigningKeys | null = null;

export function generateEd25519KeyPair(): SigningKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

export function getDevSigningKeys(): SigningKeys {
  if (!devKeyPair) {
    devKeyPair = generateEd25519KeyPair();
  }
  return devKeyPair;
}

export function isValidEd25519PrivateKey(pem: string): boolean {
  try {
    const k = createPrivateKey(pem);
    return k.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

export function isValidEd25519PublicKey(pem: string): boolean {
  try {
    const k = createPublicKey(pem);
    return k.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

export function getPublicKeyJwk(publicKeyPem: string): Ed25519Jwk | null {
  try {
    const keyObj = createPublicKey(publicKeyPem);
    if (keyObj.asymmetricKeyType !== 'ed25519') return null;
    const jwk = keyObj.export({ format: 'jwk' });
    if (!jwk.x || jwk.crv !== 'Ed25519') return null;
    return {
      kty: 'OKP',
      crv: 'Ed25519',
      x: jwk.x,
    };
  } catch {
    return null;
  }
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

