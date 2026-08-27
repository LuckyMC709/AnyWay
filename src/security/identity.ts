import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';

import {
  base64ToBytes,
  bytesToBase64,
  utf8Decode,
  utf8Encode,
} from '../mesh/base64';

// SecureStore only accepts /^[\w.-]+$/ — colons throw on *every* call, including
// reads, so a ':' here made the app unable to start at all. Dots are the safe
// separator. No migration path is needed: the old key could never be written.
const IDENTITY_STORAGE_KEY = 'anyway.crypto-identity.v1';

export type AnywayIdentity = {
  nodeId: string;
  signingPublicKey: string;
  signingSecretKey: string;
  boxPublicKey: string;
  boxSecretKey: string;
};

export type PublicIdentity = Pick<
  AnywayIdentity,
  'nodeId' | 'signingPublicKey' | 'boxPublicKey'
> & {
  attestation: string;
};

function bytesToHex(bytes: ArrayLike<number>): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 1) {
    result += bytes[index].toString(16).padStart(2, '0');
  }
  return result;
}

function deriveNodeId(signingPublicKey: Uint8Array): string {
  // Node identity is a stable 128-bit fingerprint of the complete Ed25519
  // public key, never a BLE/Wi-Fi address. The complete key and attestation
  // are still required to authenticate the advertised binding.
  return `aw-${bytesToHex(nacl.hash(signingPublicKey).slice(0, 16))}`;
}

/** Public, deterministic binding used by compact relay signing certificates. */
export function deriveNodeIdFromSigningPublicKey(signingPublicKey: string): string {
  const bytes = base64ToBytes(signingPublicKey);
  if (
    bytes.length !== nacl.sign.publicKeyLength ||
    bytesToBase64(bytes) !== signingPublicKey
  ) {
    throw new Error('Invalid canonical Ed25519 public key.');
  }
  return deriveNodeId(bytes);
}

/** Verify a NodeId/public-signing-key binding without requiring a box key. */
export function verifySigningKeyBinding(identity: {
  nodeId: string;
  signingPublicKey: string;
}): boolean {
  try {
    return deriveNodeIdFromSigningPublicKey(identity.signingPublicKey) === identity.nodeId;
  } catch {
    return false;
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function isStoredIdentity(value: unknown): value is AnywayIdentity {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AnywayIdentity>;
  const structurallyValid = (
    typeof item.nodeId === 'string' &&
    typeof item.signingPublicKey === 'string' &&
    typeof item.signingSecretKey === 'string' &&
    typeof item.boxPublicKey === 'string' &&
    typeof item.boxSecretKey === 'string' &&
    base64ToBytes(item.signingPublicKey).length === nacl.sign.publicKeyLength &&
    base64ToBytes(item.signingSecretKey).length === nacl.sign.secretKeyLength &&
    base64ToBytes(item.boxPublicKey).length === nacl.box.publicKeyLength &&
    base64ToBytes(item.boxSecretKey).length === nacl.box.secretKeyLength
  );
  if (!structurallyValid) return false;

  try {
    const signingPublicKey = base64ToBytes(item.signingPublicKey as string);
    const signingSecretKey = base64ToBytes(item.signingSecretKey as string);
    const boxPublicKey = base64ToBytes(item.boxPublicKey as string);
    const boxSecretKey = base64ToBytes(item.boxSecretKey as string);
    // Length checks alone are insufficient: a partially corrupted secure-store
    // record could retain a valid NodeId while its private halves no longer
    // produce signatures/decryption keys matching the advertised public keys.
    return (
      bytesToBase64(signingPublicKey) === item.signingPublicKey &&
      bytesToBase64(signingSecretKey) === item.signingSecretKey &&
      bytesToBase64(boxPublicKey) === item.boxPublicKey &&
      bytesToBase64(boxSecretKey) === item.boxSecretKey &&
      equalBytes(
        nacl.sign.keyPair.fromSecretKey(signingSecretKey).publicKey,
        signingPublicKey,
      ) &&
      equalBytes(nacl.box.keyPair.fromSecretKey(boxSecretKey).publicKey, boxPublicKey)
    );
  } catch {
    return false;
  }
}

let identityPromise: Promise<AnywayIdentity> | null = null;

async function loadOrCreateIdentity(): Promise<AnywayIdentity> {
  const stored = await SecureStore.getItemAsync(IDENTITY_STORAGE_KEY);
  if (stored) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (isStoredIdentity(parsed)) {
        const derived = deriveNodeId(base64ToBytes(parsed.signingPublicKey));
        if (derived === parsed.nodeId) return parsed;
      }
    } catch {
      // Corrupt secure storage is replaced with a fresh identity below.
    }
  }

  const signingSeed = Crypto.getRandomBytes(nacl.sign.seedLength);
  const boxSecret = Crypto.getRandomBytes(nacl.box.secretKeyLength);
  const signing = nacl.sign.keyPair.fromSeed(signingSeed);
  const box = nacl.box.keyPair.fromSecretKey(boxSecret);
  const identity: AnywayIdentity = {
    nodeId: deriveNodeId(signing.publicKey),
    signingPublicKey: bytesToBase64(signing.publicKey),
    signingSecretKey: bytesToBase64(signing.secretKey),
    boxPublicKey: bytesToBase64(box.publicKey),
    boxSecretKey: bytesToBase64(box.secretKey),
  };
  await SecureStore.setItemAsync(IDENTITY_STORAGE_KEY, JSON.stringify(identity), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return identity;
}

export function getOrCreateIdentity(): Promise<AnywayIdentity> {
  if (!identityPromise) {
    identityPromise = loadOrCreateIdentity().catch((error) => {
      identityPromise = null;
      throw error;
    });
  }
  return identityPromise;
}

/** Canonical JSON for signatures: object keys are recursively sorted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    // Locale-independent UTF-16/code-unit order: signatures must be identical
    // on phones configured with different languages.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function signValue(value: unknown, signingSecretKey: string): string {
  const signature = nacl.sign.detached(
    Uint8Array.from(utf8Encode(canonicalJson(value))),
    base64ToBytes(signingSecretKey)
  );
  return bytesToBase64(signature);
}

export function verifyValue(
  value: unknown,
  signature: string,
  signingPublicKey: string
): boolean {
  try {
    const signatureBytes = base64ToBytes(signature);
    const publicKeyBytes = base64ToBytes(signingPublicKey);
    // The shared codec intentionally tolerates malformed input for legacy UI
    // decoding. Cryptographic values must not: alternate textual encodings of
    // one signature would otherwise create distinct immutable fingerprints.
    if (
      signatureBytes.length !== nacl.sign.signatureLength ||
      publicKeyBytes.length !== nacl.sign.publicKeyLength ||
      bytesToBase64(signatureBytes) !== signature ||
      bytesToBase64(publicKeyBytes) !== signingPublicKey
    ) {
      return false;
    }
    return nacl.sign.detached.verify(
      Uint8Array.from(utf8Encode(canonicalJson(value))),
      signatureBytes,
      publicKeyBytes
    );
  } catch {
    return false;
  }
}

function publicBinding(identity: Pick<AnywayIdentity, 'nodeId' | 'signingPublicKey' | 'boxPublicKey'>) {
  return {
    nodeId: identity.nodeId,
    signingPublicKey: identity.signingPublicKey,
    boxPublicKey: identity.boxPublicKey,
  };
}

export function toPublicIdentity(identity: AnywayIdentity): PublicIdentity {
  const binding = publicBinding(identity);
  return {
    ...binding,
    attestation: signValue(binding, identity.signingSecretKey),
  };
}

export function verifyPublicIdentity(identity: PublicIdentity): boolean {
  try {
    const boxKey = base64ToBytes(identity.boxPublicKey);
    return (
      verifySigningKeyBinding(identity) &&
      boxKey.length === nacl.box.publicKeyLength &&
      bytesToBase64(boxKey) === identity.boxPublicKey &&
      verifyValue(publicBinding(identity), identity.attestation, identity.signingPublicKey)
    );
  } catch {
    return false;
  }
}

export type EncryptedPayload = {
  algorithm: 'nacl-box-v1';
  nonce: string;
  ciphertext: string;
  senderBoxPublicKey: string;
};

export function encryptForPeer(
  plaintext: string,
  recipientBoxPublicKey: string,
  sender: AnywayIdentity
): EncryptedPayload {
  const nonce = Crypto.getRandomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(
    Uint8Array.from(utf8Encode(plaintext)),
    nonce,
    base64ToBytes(recipientBoxPublicKey),
    base64ToBytes(sender.boxSecretKey)
  );
  return {
    algorithm: 'nacl-box-v1',
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
    senderBoxPublicKey: sender.boxPublicKey,
  };
}

export function decryptFromPeer(
  payload: EncryptedPayload,
  recipient: AnywayIdentity
): string | null {
  try {
    const opened = nacl.box.open(
      base64ToBytes(payload.ciphertext),
      base64ToBytes(payload.nonce),
      base64ToBytes(payload.senderBoxPublicKey),
      base64ToBytes(recipient.boxSecretKey)
    );
    return opened ? utf8Decode(opened) : null;
  } catch {
    return null;
  }
}
