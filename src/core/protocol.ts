import {
  AnywayNodeId,
  GeoLocation,
  MessageDestination,
  MessagePriority,
  NodeCapabilities,
  UnixMillis,
} from './model';

export const CORE_PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [CORE_PROTOCOL_VERSION] as const;
export type CoreProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export const MAX_ENVELOPE_BYTES = 256 * 1024;
export const MAX_RELAY_HOPS = 32;
export const MAX_MESSAGE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Control records must never inherit the multi-day lifetime of user content. */
export const MAX_CAPABILITY_LIFETIME_MS = 10 * 60 * 1000;
export const MAX_RECEIPT_LIFETIME_MS = 2 * 60 * 60 * 1000;

export interface RelaySigningOnlyIdentity {
  kind: 'signing-only';
  nodeId: AnywayNodeId;
  signingPublicKey: string;
}

export interface RelayFullSignerIdentity {
  kind: 'full';
  nodeId: AnywayNodeId;
  signingPublicKey: string;
  boxPublicKey: string;
  attestation: string;
}

/** Full only where E2E origin material is required; compact on later hops. */
export type RelaySignerIdentity = RelaySigningOnlyIdentity | RelayFullSignerIdentity;

/**
 * One authenticated transition in the append-only relay chain. The signed
 * claim binds the immutable origin envelope, the complete resulting path and
 * the digest of the preceding chain state. Every hop embeds its signing key;
 * the first content hop additionally embeds the origin's authenticated box
 * key so delayed E2E content remains decryptable without an online directory.
 */
export interface RelayHopAttestation {
  algorithm: 'ed25519';
  scope: 'relay-hop-v1';
  signerNodeId: AnywayNodeId;
  signerKeyId: string;
  /** Self-contained signing identity; full only where E2E origin material is needed. */
  signerIdentity: RelaySignerIdentity;
  hopIndex: number;
  hopLimit: number;
  messageFingerprint: string;
  previousChainDigest: string;
  nextNodeId: AnywayNodeId;
  resultingPathDigest: string;
  valueBase64: string;
}

export interface RelayHeader {
  relayable: true;
  hopLimit: number;
  hopCount: number;
  /** Origin first; the latest relay is last. Nodes must never repeat. */
  path: AnywayNodeId[];
  /** Exactly one authenticated transition for every traveled hop. */
  attestations: RelayHopAttestation[];
}

export interface EnvelopeSignature {
  algorithm: 'ed25519';
  /** Covers immutable fields and the hop limit, never traveled hop count/path. */
  scope: 'immutable-envelope-v1';
  signerKeyId: string;
  valueBase64: string;
}

interface RelayableEnvelopeBase {
  protocolVersion: CoreProtocolVersion;
  messageId: string;
  originId: AnywayNodeId;
  destination: MessageDestination;
  priority: MessagePriority;
  createdAt: UnixMillis;
  expiresAt: UnixMillis;
  relay: RelayHeader;
  signature: EnvelopeSignature;
}

export interface TextPayload {
  type: 'text';
  text: string;
}

export interface LocationPayload {
  type: 'location';
  location: GeoLocation;
  note?: string;
}

export interface SosPayload {
  type: 'sos';
  text?: string;
  location?: GeoLocation;
}

/**
 * Opaque application payload. Relays route and persist it without access to
 * plaintext. Encryption/decryption belongs to a dedicated, audited crypto
 * layer; this protocol deliberately implements no cryptographic primitive.
 */
export interface SealedPayload {
  type: 'sealed';
  plaintextType: 'text' | 'location' | 'sos' | 'application-data';
  algorithm: string;
  recipientKeyId: string;
  nonceBase64: string;
  ciphertextBase64: string;
}

export type ContentPayload = TextPayload | LocationPayload | SosPayload | SealedPayload;

export interface ContentEnvelope extends RelayableEnvelopeBase {
  kind: 'content';
  payload: ContentPayload;
}

export interface CapabilityEnvelope extends RelayableEnvelopeBase {
  kind: 'capability';
  payload: {
    nodeId: AnywayNodeId;
    identity: {
      nodeId: AnywayNodeId;
      signingPublicKey: string;
      boxPublicKey: string;
      attestation: string;
    };
    displayName: string;
    color: string;
    capabilities: NodeCapabilities;
    topologySequence: number;
    neighbors: Array<{
      nodeId: AnywayNodeId;
      transports: string[];
    }>;
  };
}

export type ReceiptStatus = 'accepted-by-relay' | 'delivered-to-destination';

export interface ReceiptEnvelope extends RelayableEnvelopeBase {
  kind: 'receipt';
  payload: {
    receiptFor: string;
    /** Digest of the referred envelope's immutable fields and origin signature. */
    receiptForFingerprint: string;
    status: ReceiptStatus;
    reportingNodeId: AnywayNodeId;
    observedAt: UnixMillis;
    transportReceiptId?: string;
  };
}

export type RelayableEnvelope =
  | ContentEnvelope
  | CapabilityEnvelope
  | ReceiptEnvelope;

export type EnvelopeValidationCode =
  | 'not-an-object'
  | 'unsupported-version'
  | 'invalid-base'
  | 'invalid-destination'
  | 'invalid-relay-header'
  | 'invalid-payload'
  | 'private-payload-not-sealed'
  | 'oversize';

export interface EnvelopeValidationError {
  code: EnvelopeValidationCode;
  path: string;
  message: string;
}

export type EnvelopeValidationResult =
  | { ok: true; value: RelayableEnvelope }
  | { ok: false; errors: EnvelopeValidationError[] };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isNodeId(value: unknown): value is AnywayNodeId {
  return isBoundedString(value, 128);
}

function isDestination(value: unknown): value is MessageDestination {
  if (!isRecord(value)) return false;
  if (value.kind === 'broadcast') return true;
  if (value.kind === 'direct') return isNodeId(value.nodeId);
  if (value.kind === 'group') return isBoundedString(value.groupId, 128);
  return false;
}

function isPriority(value: unknown): value is MessagePriority {
  return value === 'normal' || value === 'important' || value === 'sos';
}

function isLocation(value: unknown): value is GeoLocation {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    isFiniteNumber(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    (value.accuracyMeters === undefined ||
      (isFiniteNumber(value.accuracyMeters) && value.accuracyMeters >= 0)) &&
    isFiniteNumber(value.acquiredAt) &&
    (value.altitudeMeters === undefined || isFiniteNumber(value.altitudeMeters)) &&
    (value.altitudeAccuracyMeters === undefined ||
      (isFiniteNumber(value.altitudeAccuracyMeters) && value.altitudeAccuracyMeters >= 0)) &&
    (value.headingDegrees === undefined ||
      (isFiniteNumber(value.headingDegrees) &&
        value.headingDegrees >= 0 &&
        value.headingDegrees <= 360)) &&
    (value.speedMetersPerSecond === undefined ||
      (isFiniteNumber(value.speedMetersPerSecond) && value.speedMetersPerSecond >= 0)) &&
    (value.provider === undefined ||
      value.provider === 'gnss' ||
      value.provider === 'network' ||
      value.provider === 'fused' ||
      value.provider === 'unknown')
  );
}

function isMetricFreeTransportCapability(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const availability = value.availability;
  return (
    isBoundedString(value.kind, 64) &&
    (availability === 'supported' ||
      availability === 'unsupported' ||
      availability === 'temporarily-unavailable' ||
      availability === 'unknown') &&
    typeof value.canDiscover === 'boolean' &&
    typeof value.canAdvertise === 'boolean' &&
    typeof value.canInitiateLinks === 'boolean' &&
    typeof value.canAcceptLinks === 'boolean' &&
    typeof value.supportsDuplex === 'boolean' &&
    typeof value.supportsBackgroundOperation === 'boolean' &&
    typeof value.supportsRanging === 'boolean' &&
    (value.maxConcurrentLinks === undefined ||
      isIntegerInRange(value.maxConcurrentLinks, 0, 1024)) &&
    (value.maxPayloadBytes === undefined ||
      isIntegerInRange(value.maxPayloadBytes, 1, MAX_ENVELOPE_BYTES))
  );
}

function isNodeCapabilities(value: unknown): value is NodeCapabilities {
  if (!isRecord(value) || !isRecord(value.transports)) return false;
  if (
    !Array.isArray(value.protocolVersions) ||
    value.protocolVersions.length > 32 ||
    !value.protocolVersions.every((version) => isIntegerInRange(version, 1, 65_535))
  ) {
    return false;
  }

  if (!Object.values(value.transports).every(isMetricFreeTransportCapability)) return false;

  return (
    typeof value.supportsStoreAndForward === 'boolean' &&
    typeof value.supportsMultipath === 'boolean' &&
    typeof value.supportsEndToEndEncryption === 'boolean' &&
    typeof value.supportsLocationPayloads === 'boolean' &&
    isIntegerInRange(value.maxRelayHops, 0, MAX_RELAY_HOPS) &&
    isIntegerInRange(value.maxEnvelopeBytes, 1, MAX_ENVELOPE_BYTES) &&
    isFiniteNumber(value.updatedAt)
  );
}

function isContentPayload(value: unknown): value is ContentPayload {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'text':
      return isBoundedString(value.text, 32_768, true);
    case 'location':
      return (
        isLocation(value.location) &&
        (value.note === undefined || isBoundedString(value.note, 2_048, true))
      );
    case 'sos':
      return (
        (value.text === undefined || isBoundedString(value.text, 4_096, true)) &&
        (value.location === undefined || isLocation(value.location)) &&
        (value.text !== undefined || value.location !== undefined)
      );
    case 'sealed':
      return (
        (value.plaintextType === 'text' ||
          value.plaintextType === 'location' ||
          value.plaintextType === 'sos' ||
          value.plaintextType === 'application-data') &&
        isBoundedString(value.algorithm, 128) &&
        isBoundedString(value.recipientKeyId, 256) &&
        isBoundedString(value.nonceBase64, 512) &&
        isBoundedString(value.ciphertextBase64, MAX_ENVELOPE_BYTES)
      );
    default:
      return false;
  }
}

function isSignature(value: unknown): value is EnvelopeSignature {
  if (!isRecord(value)) return false;
  return (
    value.algorithm === 'ed25519' &&
    value.scope === 'immutable-envelope-v1' &&
    isBoundedString(value.signerKeyId, 256) &&
    isBoundedString(value.valueBase64, 512)
  );
}

function isDigest(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('sha512-trunc256:') &&
    value.length >= 48 &&
    value.length <= 128
  );
}

function isRelayHopAttestation(value: unknown): value is RelayHopAttestation {
  if (!isRecord(value)) return false;
  const identity = isRecord(value.signerIdentity) ? value.signerIdentity : null;
  const validSigningIdentity =
    !!identity &&
    identity.kind === 'signing-only' &&
    Object.keys(identity).every(
      (key) => key === 'kind' || key === 'nodeId' || key === 'signingPublicKey',
    ) &&
    isNodeId(identity.nodeId) &&
    isBoundedString(identity.signingPublicKey, 256);
  const validFullIdentity =
    !!identity &&
    identity.kind === 'full' &&
    Object.keys(identity).every(
      (key) =>
        key === 'kind' ||
        key === 'nodeId' ||
        key === 'signingPublicKey' ||
        key === 'boxPublicKey' ||
        key === 'attestation',
    ) &&
    isNodeId(identity.nodeId) &&
    isBoundedString(identity.signingPublicKey, 256) &&
    isBoundedString(identity.boxPublicKey, 256) &&
    isBoundedString(identity.attestation, 512);
  return (
    value.algorithm === 'ed25519' &&
    value.scope === 'relay-hop-v1' &&
    isNodeId(value.signerNodeId) &&
    isBoundedString(value.signerKeyId, 256) &&
    !!identity &&
    identity.nodeId === value.signerNodeId &&
    (validSigningIdentity || validFullIdentity) &&
    isIntegerInRange(value.hopIndex, 1, MAX_RELAY_HOPS) &&
    isIntegerInRange(value.hopLimit, 0, MAX_RELAY_HOPS) &&
    isDigest(value.messageFingerprint) &&
    isDigest(value.previousChainDigest) &&
    isNodeId(value.nextNodeId) &&
    isDigest(value.resultingPathDigest) &&
    isBoundedString(value.valueBase64, 512)
  );
}

function validateRelayHeader(
  value: unknown,
  originId: AnywayNodeId,
): value is RelayHeader {
  if (!isRecord(value) || value.relayable !== true) return false;
  if (
    !isIntegerInRange(value.hopLimit, 0, MAX_RELAY_HOPS) ||
    !isIntegerInRange(value.hopCount, 0, MAX_RELAY_HOPS) ||
    value.hopCount > value.hopLimit ||
    !Array.isArray(value.path) ||
    value.path.length !== value.hopCount + 1 ||
    value.path.length > MAX_RELAY_HOPS + 1 ||
    !value.path.every(isNodeId) ||
    value.path[0] !== originId ||
    !Array.isArray(value.attestations) ||
    value.attestations.length !== value.hopCount ||
    !value.attestations.every(isRelayHopAttestation)
  ) {
    return false;
  }
  const path = value.path as AnywayNodeId[];
  const attestations = value.attestations as RelayHopAttestation[];
  if (new Set(path).size !== path.length) return false;
  return attestations.every((attestation, index) => {
    const item = attestation as RelayHopAttestation;
    return (
      item.hopIndex === index + 1 &&
      item.hopLimit === value.hopLimit &&
      item.signerNodeId === path[index] &&
      item.nextNodeId === path[index + 1]
    );
  });
}

function validateBase(value: UnknownRecord, errors: EnvelopeValidationError[]): boolean {
  if (value.protocolVersion !== CORE_PROTOCOL_VERSION) {
    errors.push({
      code: 'unsupported-version',
      path: 'protocolVersion',
      message: `Supported protocol version is ${CORE_PROTOCOL_VERSION}.`,
    });
  }

  const validBase =
    isBoundedString(value.messageId, 128) &&
    isNodeId(value.originId) &&
    isPriority(value.priority) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.expiresAt) &&
    value.createdAt >= 0 &&
    value.expiresAt > value.createdAt &&
    value.expiresAt - value.createdAt <= MAX_MESSAGE_LIFETIME_MS &&
    isSignature(value.signature);

  if (!validBase) {
    errors.push({
      code: 'invalid-base',
      path: '$',
      message: 'Envelope identity, timestamps, priority or signature are invalid.',
    });
  }

  if (!isDestination(value.destination)) {
    errors.push({
      code: 'invalid-destination',
      path: 'destination',
      message: 'Destination must be broadcast, direct or group.',
    });
  }

  if (!isNodeId(value.originId) || !validateRelayHeader(value.relay, value.originId)) {
    errors.push({
      code: 'invalid-relay-header',
      path: 'relay',
      message: 'Relay path/hop counters are inconsistent or contain a loop.',
    });
  }

  return errors.length === 0;
}

/** Validate every untrusted network or persistence boundary before use. */
export function validateEnvelope(value: unknown): EnvelopeValidationResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [{ code: 'not-an-object', path: '$', message: 'Envelope must be an object.' }],
    };
  }

  try {
    if (encodedByteLength(JSON.stringify(value)) > MAX_ENVELOPE_BYTES) {
      return {
        ok: false,
        errors: [{ code: 'oversize', path: '$', message: 'Envelope exceeds the size limit.' }],
      };
    }
  } catch {
    return {
      ok: false,
      errors: [{ code: 'invalid-base', path: '$', message: 'Envelope is not serializable.' }],
    };
  }

  const errors: EnvelopeValidationError[] = [];
  validateBase(value, errors);

  if (value.kind === 'content') {
    if (!isContentPayload(value.payload)) {
      errors.push({ code: 'invalid-payload', path: 'payload', message: 'Invalid content payload.' });
    } else if (
      isDestination(value.destination) &&
      (value.destination.kind === 'direct' || value.destination.kind === 'group') &&
      value.payload.type !== 'sealed'
    ) {
      errors.push({
        code: 'private-payload-not-sealed',
        path: 'payload',
        message: 'Direct and group content must be end-to-end encrypted before routing.',
      });
    }
    const relay = isRecord(value.relay) ? value.relay : null;
    const firstAttestation =
      relay && Array.isArray(relay.attestations) ? relay.attestations[0] : undefined;
    if (
      firstAttestation !== undefined &&
      (!isRecord(firstAttestation) ||
        !isRecord(firstAttestation.signerIdentity) ||
        firstAttestation.signerIdentity.kind !== 'full')
    ) {
      errors.push({
        code: 'invalid-relay-header',
        path: 'relay.attestations[0].signerIdentity',
        message: 'The first content hop must carry the origin full public identity.',
      });
    }
  } else if (value.kind === 'capability') {
    const identity = isRecord(value.payload) && isRecord(value.payload.identity)
      ? value.payload.identity
      : null;
    const neighbors = isRecord(value.payload) ? value.payload.neighbors : null;
    if (
      !isRecord(value.payload) ||
      !isNodeId(value.payload.nodeId) ||
      value.payload.nodeId !== value.originId ||
      !identity ||
      identity.nodeId !== value.originId ||
      !isBoundedString(identity.signingPublicKey, 256) ||
      !isBoundedString(identity.boxPublicKey, 256) ||
      !isBoundedString(identity.attestation, 512) ||
      !isBoundedString(value.payload.displayName, 64) ||
      !isBoundedString(value.payload.color, 32) ||
      !isNodeCapabilities(value.payload.capabilities) ||
      !isIntegerInRange(value.payload.topologySequence, 0, Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(neighbors) ||
      neighbors.length > 64 ||
      !neighbors.every(
        (neighbor) =>
          isRecord(neighbor) &&
          isNodeId(neighbor.nodeId) &&
          Array.isArray(neighbor.transports) &&
          neighbor.transports.length <= 8 &&
          neighbor.transports.every((transport) => isBoundedString(transport, 64)),
      )
    ) {
      errors.push({
        code: 'invalid-payload',
        path: 'payload',
        message: 'Invalid capability advertisement.',
      });
    }
    if (
      isFiniteNumber(value.createdAt) &&
      isFiniteNumber(value.expiresAt) &&
      value.expiresAt - value.createdAt > MAX_CAPABILITY_LIFETIME_MS
    ) {
      errors.push({
        code: 'invalid-payload',
        path: 'expiresAt',
        message: 'Capability lifetime exceeds the control-plane limit.',
      });
    }
  } else if (value.kind === 'receipt') {
    const payload = value.payload;
    if (
      !isRecord(payload) ||
      !isBoundedString(payload.receiptFor, 128) ||
      !isDigest(payload.receiptForFingerprint) ||
      (payload.status !== 'accepted-by-relay' &&
        payload.status !== 'delivered-to-destination') ||
      !isNodeId(payload.reportingNodeId) ||
      payload.reportingNodeId !== value.originId ||
      !isFiniteNumber(payload.observedAt) ||
      (payload.transportReceiptId !== undefined &&
        !isBoundedString(payload.transportReceiptId, 256)) ||
      !isDestination(value.destination) ||
      value.destination.kind !== 'direct'
    ) {
      errors.push({ code: 'invalid-payload', path: 'payload', message: 'Invalid receipt.' });
    }
    if (
      isFiniteNumber(value.createdAt) &&
      isFiniteNumber(value.expiresAt) &&
      value.expiresAt - value.createdAt > MAX_RECEIPT_LIFETIME_MS
    ) {
      errors.push({
        code: 'invalid-payload',
        path: 'expiresAt',
        message: 'Receipt lifetime exceeds the control-plane limit.',
      });
    }
  } else {
    errors.push({ code: 'invalid-payload', path: 'kind', message: 'Unknown envelope kind.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as unknown as RelayableEnvelope };
}

export function encodeEnvelope(envelope: RelayableEnvelope): string {
  const validated = validateEnvelope(envelope);
  if (!validated.ok) {
    throw new Error(`Cannot encode invalid envelope: ${validated.errors[0]?.message ?? 'unknown'}`);
  }
  const encoded = JSON.stringify(validated.value);
  if (encodedByteLength(encoded) > MAX_ENVELOPE_BYTES) {
    throw new Error(`Envelope exceeds ${MAX_ENVELOPE_BYTES} encoded bytes.`);
  }
  return encoded;
}

export function decodeEnvelope(encoded: string): EnvelopeValidationResult {
  if (encodedByteLength(encoded) > MAX_ENVELOPE_BYTES) {
    return {
      ok: false,
      errors: [{ code: 'oversize', path: '$', message: 'Envelope exceeds the size limit.' }],
    };
  }
  try {
    return validateEnvelope(JSON.parse(encoded) as unknown);
  } catch {
    return {
      ok: false,
      errors: [{ code: 'not-an-object', path: '$', message: 'Envelope is not valid JSON.' }],
    };
  }
}

/** UTF-8 byte length without requiring a platform TextEncoder polyfill. */
export function encodedByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      index += 1;
    }
  }
  return bytes;
}

export function negotiateProtocolVersion(remoteVersions: readonly number[]): number | null {
  const mutuallySupported = SUPPORTED_PROTOCOL_VERSIONS.filter((version) =>
    remoteVersions.includes(version),
  );
  return mutuallySupported.length > 0 ? Math.max(...mutuallySupported) : null;
}

export function isExpired(envelope: RelayableEnvelope, now = Date.now()): boolean {
  return now >= envelope.expiresAt;
}

export type RelayBlockReason =
  | 'expired'
  | 'hop-limit-reached'
  | 'loop-detected'
  | 'path-not-at-current-node'
  | 'already-at-final-destination';

export type RelayDecision = { allowed: true } | { allowed: false; reason: RelayBlockReason };

/**
 * Decide whether currentNode may forward to nextHop. A node already at the end
 * of path is allowed (origin/previously prepared relay); appearing earlier is a loop.
 */
export function canRelayEnvelope(
  envelope: RelayableEnvelope,
  currentNode: AnywayNodeId,
  nextHop?: AnywayNodeId,
  now = Date.now(),
): RelayDecision {
  if (isExpired(envelope, now)) return { allowed: false, reason: 'expired' };
  if (envelope.relay.hopCount >= envelope.relay.hopLimit) {
    return { allowed: false, reason: 'hop-limit-reached' };
  }

  const currentIndex = envelope.relay.path.indexOf(currentNode);
  if (currentIndex < 0) {
    return { allowed: false, reason: 'path-not-at-current-node' };
  }
  if (currentIndex !== envelope.relay.path.length - 1) {
    return { allowed: false, reason: 'loop-detected' };
  }
  if (nextHop && envelope.relay.path.includes(nextHop)) {
    return { allowed: false, reason: 'loop-detected' };
  }
  if (
    envelope.destination.kind === 'direct' &&
    envelope.destination.nodeId === currentNode
  ) {
    return { allowed: false, reason: 'already-at-final-destination' };
  }
  return { allowed: true };
}

/**
 * Append a caller-created Ed25519 hop attestation. This function checks the
 * structural transition only; `verifyRelayChain` in `crypto.ts` performs the
 * digest and signature verification. Providers must never send the durable
 * custody copy directly: create/sign this hop immediately before transmission.
 */
export function appendRelayHopAttestation(
  envelope: RelayableEnvelope,
  currentNode: AnywayNodeId,
  nextHop: AnywayNodeId,
  attestation: RelayHopAttestation,
  now = Date.now(),
): RelayableEnvelope | null {
  const decision = canRelayEnvelope(envelope, currentNode, nextHop, now);
  if (!decision.allowed) return null;
  if (
    attestation.signerNodeId !== currentNode ||
    attestation.nextNodeId !== nextHop ||
    attestation.hopIndex !== envelope.relay.hopCount + 1
  ) return null;

  return {
    ...envelope,
    relay: {
      ...envelope.relay,
      hopCount: envelope.relay.hopCount + 1,
      path: [...envelope.relay.path, nextHop],
      attestations: [...envelope.relay.attestations, attestation],
    },
  };
}

export function isFinalDestination(
  envelope: RelayableEnvelope,
  nodeId: AnywayNodeId,
  groupIds: ReadonlySet<string> = new Set<string>(),
): boolean {
  if (envelope.destination.kind === 'broadcast') return true;
  if (envelope.destination.kind === 'direct') return envelope.destination.nodeId === nodeId;
  return groupIds.has(envelope.destination.groupId);
}
