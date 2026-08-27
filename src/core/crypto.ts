import nacl from 'tweetnacl';

import {
  AnywayIdentity,
  PublicIdentity,
  canonicalJson,
  decryptFromPeer,
  encryptForPeer,
  signValue,
  toPublicIdentity,
  verifyPublicIdentity,
  verifySigningKeyBinding,
  verifyValue,
} from '../security';
import { AnywayNodeId } from './model';
import {
  appendRelayHopAttestation,
  CapabilityEnvelope,
  EnvelopeSignature,
  RelayHopAttestation,
  RelayableEnvelope,
  RelaySignerIdentity,
  SealedPayload,
} from './protocol';

type UnsignedEnvelope = Omit<RelayableEnvelope, 'signature'> & {
  signature?: EnvelopeSignature;
};

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Encode(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    if (codePoint > 0xffff) index += 1;
    if (codePoint < 0x80) bytes.push(codePoint);
    else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function bytesToBase64(bytes: ArrayLike<number>): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triplet = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += BASE64_CHARS[(triplet >> 18) & 0x3f];
    result += BASE64_CHARS[(triplet >> 12) & 0x3f];
    result += second === undefined ? '=' : BASE64_CHARS[(triplet >> 6) & 0x3f];
    result += third === undefined ? '=' : BASE64_CHARS[triplet & 0x3f];
  }
  return result;
}

/**
 * Fields an origin controls forever. The origin signs the maximum hop budget;
 * traveled state is then protected separately by the append-only per-hop
 * attestation chain.
 */
export function immutableEnvelopeForSigning(envelope: UnsignedEnvelope): unknown {
  const { relay, signature: _signature, ...immutable } = envelope;
  return {
    ...immutable,
    relayPolicy: {
      relayable: relay.relayable,
      hopLimit: relay.hopLimit,
    },
  };
}

/** SHA-512 truncated to 256 bits over canonical JSON, encoded for wire/storage. */
export function canonicalDigest(value: unknown): string {
  const bytes = Uint8Array.from(utf8Encode(canonicalJson(value)));
  return `sha512-trunc256:${bytesToBase64(nacl.hash(bytes).slice(0, 32))}`;
}

/**
 * Stable identity of a logical message. Mutable route state is intentionally
 * excluded, while the deterministic Ed25519 origin signature is included.
 */
export function immutableEnvelopeFingerprint(envelope: UnsignedEnvelope): string {
  return canonicalDigest({
    immutableEnvelope: immutableEnvelopeForSigning(envelope),
    originSignature: envelope.signature ?? null,
  });
}

export type RelayHopAttestationClaim = Omit<RelayHopAttestation, 'valueBase64'>;

function relayChainRootDigest(envelope: RelayableEnvelope): string {
  return canonicalDigest({
    scope: 'relay-chain-root-v1',
    messageFingerprint: immutableEnvelopeFingerprint(envelope),
    hopLimit: envelope.relay.hopLimit,
    path: [envelope.originId],
  });
}

/** Digest of the complete signed previous link, used by the next link. */
export function relayHopAttestationDigest(attestation: RelayHopAttestation): string {
  return canonicalDigest(attestation);
}

export type RelaySigningIdentity = Pick<
  PublicIdentity,
  'nodeId' | 'signingPublicKey'
>;

function hasExactlyKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

/** Validate either self-contained relay certificate without trusting a directory. */
export function verifyRelaySignerIdentity(identity: RelaySignerIdentity): boolean {
  if (!identity || typeof identity !== 'object' || !verifySigningKeyBinding(identity)) {
    return false;
  }
  if (identity.kind === 'signing-only') {
    return hasExactlyKeys(identity, ['kind', 'nodeId', 'signingPublicKey']);
  }
  if (identity.kind !== 'full') return false;
  return (
    hasExactlyKeys(identity, [
      'kind',
      'nodeId',
      'signingPublicKey',
      'boxPublicKey',
      'attestation',
    ]) &&
    verifyPublicIdentity(identity)
  );
}

function sameSigningIdentity(
  left: RelaySigningIdentity,
  right: RelaySigningIdentity,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.signingPublicKey === right.signingPublicKey
  );
}

function publicIdentityFromRelaySigner(
  identity: RelaySignerIdentity,
): PublicIdentity | undefined {
  if (identity.kind !== 'full') return undefined;
  return {
    nodeId: identity.nodeId,
    signingPublicKey: identity.signingPublicKey,
    boxPublicKey: identity.boxPublicKey,
    attestation: identity.attestation,
  };
}

function requiresFullRelaySigner(envelope: RelayableEnvelope): boolean {
  return envelope.kind === 'content' && envelope.relay.hopCount === 0;
}

/**
 * Produce the exact value an external signer must sign for the next hop. No
 * key material is generated here; the supplied certificate is part of the
 * claim and must belong to `currentNode`. The first content transition needs
 * a full identity; all other transitions may use the compact signing form.
 */
export function relayHopAttestationForSigning(
  envelope: RelayableEnvelope,
  currentNode: AnywayNodeId,
  nextHop: AnywayNodeId,
  signerIdentity: RelaySignerIdentity,
): RelayHopAttestationClaim | null {
  const path = envelope.relay.path;
  if (
    path[path.length - 1] !== currentNode ||
    path.includes(nextHop) ||
    envelope.relay.hopCount >= envelope.relay.hopLimit ||
    signerIdentity.nodeId !== currentNode ||
    !verifyRelaySignerIdentity(signerIdentity) ||
    (requiresFullRelaySigner(envelope) && signerIdentity.kind !== 'full')
  ) {
    return null;
  }
  const previous = envelope.relay.attestations[envelope.relay.attestations.length - 1];
  return {
    algorithm: 'ed25519',
    scope: 'relay-hop-v1',
    signerNodeId: currentNode,
    signerKeyId: currentNode,
    signerIdentity,
    hopIndex: envelope.relay.hopCount + 1,
    hopLimit: envelope.relay.hopLimit,
    messageFingerprint: immutableEnvelopeFingerprint(envelope),
    previousChainDigest: previous
      ? relayHopAttestationDigest(previous)
      : relayChainRootDigest(envelope),
    nextNodeId: nextHop,
    resultingPathDigest: canonicalDigest([...path, nextHop]),
  };
}

/**
 * Attach an externally produced signature only if its certificate and
 * signature verify. This is the integration point for hardware/external keys.
 */
export function createRelayHopAttestation(
  envelope: RelayableEnvelope,
  currentNode: AnywayNodeId,
  nextHop: AnywayNodeId,
  signerIdentity: RelaySignerIdentity,
  valueBase64: string,
): RelayHopAttestation | null {
  const claim = relayHopAttestationForSigning(
    envelope,
    currentNode,
    nextHop,
    signerIdentity,
  );
  if (!claim || !verifyValue(claim, valueBase64, signerIdentity.signingPublicKey)) return null;
  return { ...claim, valueBase64 };
}

/** Sign the next transition with an existing local identity; creates no keys. */
export function signRelayHopAttestation(
  envelope: RelayableEnvelope,
  currentNode: AnywayNodeId,
  nextHop: AnywayNodeId,
  identity: AnywayIdentity,
): RelayHopAttestation | null {
  if (identity.nodeId !== currentNode) return null;
  const signerIdentity: RelaySignerIdentity = requiresFullRelaySigner(envelope)
    ? { kind: 'full', ...toPublicIdentity(identity) }
    : {
        kind: 'signing-only',
        nodeId: identity.nodeId,
        signingPublicKey: identity.signingPublicKey,
      };
  const claim = relayHopAttestationForSigning(
    envelope,
    currentNode,
    nextHop,
    signerIdentity,
  );
  if (!claim) return null;
  return { ...claim, valueBase64: signValue(claim, identity.signingSecretKey) };
}

/**
 * Prepare the authenticated wire copy for one outbound hop. The store retains
 * the pre-hop custody copy so multiple routes can receive independently signed
 * branches without corrupting durable state.
 */
export function advanceEnvelopeForRelay(
  envelope: RelayableEnvelope,
  currentNode: AnywayNodeId,
  nextHop: AnywayNodeId,
  identity: AnywayIdentity,
  now = Date.now(),
): RelayableEnvelope | null {
  const attestation = signRelayHopAttestation(envelope, currentNode, nextHop, identity);
  if (!attestation) return null;
  return appendRelayHopAttestation(envelope, currentNode, nextHop, attestation, now);
}

export type RelayIdentityResolver = (
  nodeId: AnywayNodeId,
  signerKeyId: string,
) => PublicIdentity | undefined;

/** Full E2E identity from a capability payload or the first content hop. */
export function originIdentityFromRelayChain(
  envelope: RelayableEnvelope,
): PublicIdentity | undefined {
  if (envelope.kind === 'capability') return envelope.payload.identity;
  const first = envelope.relay.attestations[0];
  return first?.signerNodeId === envelope.originId
    ? publicIdentityFromRelaySigner(first.signerIdentity)
    : undefined;
}

/** Signing material sufficient to authenticate an origin envelope. */
export function originSigningIdentityFromRelayChain(
  envelope: RelayableEnvelope,
): RelaySigningIdentity | undefined {
  if (envelope.kind === 'capability') {
    return {
      nodeId: envelope.payload.identity.nodeId,
      signingPublicKey: envelope.payload.identity.signingPublicKey,
    };
  }
  const first = envelope.relay.attestations[0];
  if (!first || first.signerNodeId !== envelope.originId) return undefined;
  return {
    nodeId: first.signerIdentity.nodeId,
    signingPublicKey: first.signerIdentity.signingPublicKey,
  };
}

/**
 * Verify origin authenticity plus every append-only route transition. The
 * optional resolver enforces local signing-key continuity; embedded signing
 * certificates keep delayed/store-forward envelopes independently verifiable.
 */
export function verifyRelayChain(
  envelope: RelayableEnvelope,
  resolveIdentity?: RelayIdentityResolver,
): boolean {
  if (
    !envelope.signature ||
    !Number.isSafeInteger(envelope.relay.hopCount) ||
    !Number.isSafeInteger(envelope.relay.hopLimit) ||
    envelope.relay.hopCount < 0 ||
    envelope.relay.hopCount > envelope.relay.hopLimit ||
    envelope.relay.path.length !== envelope.relay.hopCount + 1 ||
    envelope.relay.attestations.length !== envelope.relay.hopCount ||
    envelope.relay.path[0] !== envelope.originId ||
    new Set(envelope.relay.path).size !== envelope.relay.path.length
  ) {
    return false;
  }
  const embeddedOriginIdentity = originIdentityFromRelayChain(envelope);
  const originSigningIdentity =
    originSigningIdentityFromRelayChain(envelope) ??
    resolveIdentity?.(envelope.originId, envelope.signature.signerKeyId);
  if (
    !originSigningIdentity ||
    !verifySigningKeyBinding(originSigningIdentity) ||
    originSigningIdentity.nodeId !== envelope.originId ||
    (embeddedOriginIdentity !== undefined &&
      !verifyPublicIdentity(embeddedOriginIdentity)) ||
    (envelope.kind === 'content' &&
      envelope.relay.hopCount > 0 &&
      embeddedOriginIdentity === undefined) ||
    !verifyEnvelopeSignature(envelope, originSigningIdentity.signingPublicKey)
  ) {
    return false;
  }
  const knownOrigin = resolveIdentity?.(
    envelope.originId,
    envelope.signature.signerKeyId,
  );
  if (
    knownOrigin &&
    (!verifyPublicIdentity(knownOrigin) ||
      !sameSigningIdentity(knownOrigin, originSigningIdentity))
  ) {
    return false;
  }

  const messageFingerprint = immutableEnvelopeFingerprint(envelope);
  let previousChainDigest = relayChainRootDigest(envelope);
  for (let index = 0; index < envelope.relay.attestations.length; index += 1) {
    const attestation = envelope.relay.attestations[index];
    const expectedSigner = envelope.relay.path[index];
    const expectedNext = envelope.relay.path[index + 1];
    const identity = attestation.signerIdentity;
    if (
      attestation.algorithm !== 'ed25519' ||
      attestation.scope !== 'relay-hop-v1' ||
      attestation.hopIndex !== index + 1 ||
      attestation.hopLimit !== envelope.relay.hopLimit ||
      attestation.signerNodeId !== expectedSigner ||
      attestation.signerKeyId !== expectedSigner ||
      attestation.nextNodeId !== expectedNext ||
      attestation.messageFingerprint !== messageFingerprint ||
      attestation.previousChainDigest !== previousChainDigest ||
      attestation.resultingPathDigest !==
        canonicalDigest(envelope.relay.path.slice(0, index + 2)) ||
      identity.nodeId !== expectedSigner ||
      !verifyRelaySignerIdentity(identity) ||
      (envelope.kind === 'content' && index === 0 && identity.kind !== 'full') ||
      (index === 0 && !sameSigningIdentity(identity, originSigningIdentity))
    ) {
      return false;
    }
    const knownIdentity = resolveIdentity?.(expectedSigner, attestation.signerKeyId);
    if (
      knownIdentity &&
      (!verifyPublicIdentity(knownIdentity) ||
        !sameSigningIdentity(knownIdentity, identity))
    ) {
      return false;
    }
    const { valueBase64, ...claim } = attestation;
    if (!verifyValue(claim, valueBase64, identity.signingPublicKey)) return false;
    previousChainDigest = relayHopAttestationDigest(attestation);
  }
  return true;
}

export function signEnvelope<T extends RelayableEnvelope>(
  envelope: Omit<T, 'signature'>,
  identity: AnywayIdentity,
): T {
  if (envelope.originId !== identity.nodeId) {
    throw new Error('Cannot sign an envelope for another origin.');
  }
  const signature: EnvelopeSignature = {
    algorithm: 'ed25519',
    scope: 'immutable-envelope-v1',
    signerKeyId: identity.nodeId,
    valueBase64: signValue(immutableEnvelopeForSigning(envelope), identity.signingSecretKey),
  };
  return { ...envelope, signature } as T;
}

function capabilityIdentity(envelope: RelayableEnvelope): PublicIdentity | null {
  if (envelope.kind !== 'capability') return null;
  return envelope.payload.identity;
}

/**
 * Verifies both node-key binding and immutable envelope authenticity. A
 * capability envelope bootstraps its own public key; other messages require
 * the already authenticated key retained for the origin (TOFU continuity).
 */
export function verifyEnvelopeSignature(
  envelope: RelayableEnvelope,
  knownSigningPublicKey?: string,
): boolean {
  const signature = envelope.signature;
  if (
    !signature ||
    signature.algorithm !== 'ed25519' ||
    signature.scope !== 'immutable-envelope-v1' ||
    signature.signerKeyId !== envelope.originId
  ) {
    return false;
  }

  const advertisedIdentity = capabilityIdentity(envelope);
  if (advertisedIdentity && !verifyPublicIdentity(advertisedIdentity)) return false;
  const publicKey = advertisedIdentity?.signingPublicKey ?? knownSigningPublicKey;
  if (
    !publicKey ||
    !verifySigningKeyBinding({ nodeId: envelope.originId, signingPublicKey: publicKey })
  ) {
    return false;
  }
  return verifyValue(
    immutableEnvelopeForSigning(envelope),
    signature.valueBase64,
    publicKey,
  );
}

export function sealPayloadForPeer(
  plaintextType: SealedPayload['plaintextType'],
  plaintext: string,
  recipient: PublicIdentity,
  sender: AnywayIdentity,
): SealedPayload {
  if (!verifyPublicIdentity(recipient)) {
    throw new Error('Recipient identity is not cryptographically valid.');
  }
  const sealed = encryptForPeer(plaintext, recipient.boxPublicKey, sender);
  return {
    type: 'sealed',
    plaintextType,
    algorithm: sealed.algorithm,
    recipientKeyId: recipient.nodeId,
    nonceBase64: sealed.nonce,
    ciphertextBase64: sealed.ciphertext,
  };
}

export function openSealedPayload(
  payload: SealedPayload,
  originIdentity: PublicIdentity,
  recipient: AnywayIdentity,
): string | null {
  if (
    payload.algorithm !== 'nacl-box-v1' ||
    payload.recipientKeyId !== recipient.nodeId ||
    !verifyPublicIdentity(originIdentity)
  ) {
    return null;
  }
  return decryptFromPeer(
    {
      algorithm: 'nacl-box-v1',
      nonce: payload.nonceBase64,
      ciphertext: payload.ciphertextBase64,
      senderBoxPublicKey: originIdentity.boxPublicKey,
    },
    recipient,
  );
}

export function capabilityHasValidIdentity(envelope: CapabilityEnvelope): boolean {
  return (
    envelope.payload.identity.nodeId === envelope.originId &&
    verifyPublicIdentity(envelope.payload.identity)
  );
}

/** Stable diagnostic fingerprint; never contains secret key material. */
export function identityFingerprint(identity: PublicIdentity): string {
  return canonicalJson({
    nodeId: identity.nodeId,
    signingPublicKey: identity.signingPublicKey.slice(0, 16),
    boxPublicKey: identity.boxPublicKey.slice(0, 16),
  });
}
