import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Platform } from 'react-native';

import BleMesh, {
  BleMeshPeer,
  BleMeshRadioState,
  WifiAwareState,
} from '../../modules/ble-mesh/src';
import {
  CapabilityEnvelope,
  ContentEnvelope,
  CORE_PROTOCOL_VERSION,
  DiagnosticEvent,
  DiagnosticRingBuffer,
  GeoLocation,
  Link,
  MessagePriority,
  MessageStoreStats,
  NodeCapabilities,
  PersistentMessageStore,
  ReceiptEnvelope,
  RelayableEnvelope,
  SealedPayload,
  advanceEnvelopeForRelay,
  anywayCoreStorage,
  capabilityHasValidIdentity,
  decodeEnvelope,
  encodedByteLength,
  encodeEnvelope,
  isFinalDestination,
  immutableEnvelopeFingerprint,
  openSealedPayload,
  originIdentityFromRelayChain,
  sealPayloadForPeer,
  scoreLink,
  selectRoutes,
  signEnvelope,
  verifyRelayChain,
} from '../core';
import {
  AnywayIdentity,
  PublicIdentity,
  getOrCreateIdentity,
  signValue,
  toPublicIdentity,
  verifyPublicIdentity,
  verifyValue,
} from '../security';
import {
  clearStoredMessages,
  discardLegacyV1Data,
  getStoredColor,
  getStoredConversations,
  getStoredKnownPeers,
  getStoredMeshEnabled,
  getStoredMessagesByConversation,
  getStoredNickname,
  getStoredTtl,
  setStoredColor as persistColorToDisk,
  setStoredConversations,
  setStoredKnownPeers,
  setStoredMeshEnabled,
  setStoredMessagesByConversation,
  setStoredNickname as persistNicknameToDisk,
  setStoredTtl as persistTtlToDisk,
} from '../storage';
import { base64ToUtf8, utf8ToBase64 } from './base64';
import { DEFAULT_COLOR, defaultColorForNodeId, isValidPaletteColor } from './color';
import { MeshEdge, MeshNode, computeMeshEdges, findArticulationPoints } from './graph';
import { generateMessageId } from './identity';
import {
  requestBlePermissions,
  requestNotificationPermission,
  requestWifiAwarePermission,
} from './permissions';
import { ANNOUNCE_INTERVAL_MS, DEFAULT_TTL, MeshTarget } from './protocol';
import {
  BROADCAST_CONVERSATION_ID,
  ChatMessage,
  Conversation,
  DemoEvent,
  KnownPeer,
  directConversationId,
  groupConversationId,
} from './types';

export type MeshStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'unsupported'
  | 'missing-permissions'
  | 'bluetooth-off'
  | 'radio-error'
  // Startup failed before the mesh could run at all. Kept distinct from
  // 'radio-error' so a storage/identity fault is never reported as a Bluetooth
  // problem — they need completely different fixes from the user.
  | 'init-error';

/** Startup steps, in order. Naming the failing one makes a boot failure diagnosable. */
export type HydrationStage =
  | 'identity'
  | 'preferences'
  | 'legacy-purge'
  | 'store-open'
  | 'reconcile';

export type HydrationFailure = {
  stage: HydrationStage;
  message: string;
  /** Recoverable stages degrade to empty state; fatal ones block startup. */
  fatal: boolean;
};

/** Which radio an endpoint belongs to. One peer can be reachable on several. */
export type PeerTransport = 'ble' | 'wifi-aware';

export type PeerInfo = {
  address: string;
  rssi: number | null;
  rssiKnown: boolean;
  connected: boolean;
  nodeId?: string;
  nickname?: string;
  lastSeen: number;
  /** Defaults to BLE: the only transport that currently carries traffic. */
  transport?: PeerTransport;
  /** Round-trip time of the identity handshake, the one latency sample we get for free. */
  handshakeRttMs?: number;
  /** When this endpoint first came up, used to score how settled the link is. */
  establishedAt?: number;
};

/**
 * A peer as the app thinks of it: one stable identity that may be reachable over
 * several radios at once. Endpoints are transport-specific and disposable; the
 * `nodeId` is what conversations, routing and delivery are keyed on.
 */
export type PeerSession = {
  nodeId: string;
  nickname?: string;
  endpoints: PeerInfo[];
  /** The endpoint currently carrying traffic, chosen by score with hysteresis. */
  activeTransport: PeerTransport | null;
  transports: PeerTransport[];
};

export type NearbyDevice = {
  key: string;
  nodeId?: string;
  nickname?: string;
  color?: string;
  address: string;
  rssi: number | null;
  rssiKnown: boolean;
  connected: boolean;
  lastSeen: number;
};

export type ConversationSummary = {
  conversation: Conversation;
  lastMessage?: ChatMessage;
};

export type RssiSample = { ts: number; rssi: number };

export type EmergencyInput = {
  target: MeshTarget;
  text?: string;
  location?: GeoLocation;
  priority: 'important' | 'sos';
};

export type MeshContextValue = {
  hydrated: boolean;
  /** Set when startup failed outright; `null` once the app is usable. */
  hydrationFailure: HydrationFailure | null;
  /** Non-fatal startup problems: the app booted, but some stored data was dropped. */
  hydrationWarnings: HydrationFailure[];
  status: MeshStatus;
  meshEnabled: boolean;
  nodeId: string | null;
  nickname: string | null;
  ttl: number;
  color: string;
  peers: PeerInfo[];
  /** One entry per identity, with every radio it is currently reachable on. */
  peerSessions: PeerSession[];
  nearbyDevices: NearbyDevice[];
  meshGraph: MeshNode[];
  meshEdges: MeshEdge[];
  articulationPoints: Set<string>;
  knownPeers: KnownPeer[];
  conversationSummaries: ConversationSummary[];
  demoEvents: DemoEvent[];
  capabilities: NodeCapabilities;
  links: Link[];
  coreLinks: Link[];
  storeStats: MessageStoreStats;
  diagnostics: DiagnosticEvent[];
  diagnosticEvents: DiagnosticEvent[];
  exportDiagnostics: () => string;
  getRssiHistory: (address: string) => RssiSample[];
  getMessages: (conversationId: string) => ChatMessage[];
  setNickname: (name: string) => Promise<void>;
  setTtl: (ttl: number) => Promise<void>;
  setColor: (color: string) => Promise<void>;
  sendText: (target: MeshTarget, text: string) => Promise<void>;
  sendEmergency: (input: EmergencyInput) => Promise<void>;
  createGroup: (name: string, memberNodeIds: string[]) => Promise<string>;
  setActiveConversation: (conversationId: string | null) => void;
  clearAllMessages: () => Promise<void>;
  requestStart: () => Promise<void>;
  restartMesh: () => Promise<void>;
  stopMesh: () => Promise<void>;
  batteryOptimizationIgnored: boolean;
  radioState: BleMeshRadioState;
  wifiAwareState: WifiAwareState;
  /** Android's system-wide battery saver, used by routing policy. */
  powerSaveMode: boolean;
  requestIgnoreBatteryOptimizations: () => void;
};

type TopologyInfo = {
  nickname: string;
  color: string;
  neighbors: Array<{ nodeId: string; transports: string[] }>;
  hopsAway: number;
  sequence: number;
  lastAnnounceTs: number;
};

type PrivateApplicationPayload =
  | { kind: 'direct-text'; text: string; displayId: string }
  | {
      kind: 'group-text';
      groupId: string;
      text: string;
      displayId: string;
    }
  | {
      kind: 'emergency';
      text?: string;
      location?: GeoLocation;
      priority: 'important' | 'sos';
      displayId: string;
    }
  | {
      kind: 'group-emergency';
      groupId: string;
      text?: string;
      location?: GeoLocation;
      priority: 'important' | 'sos';
      displayId: string;
    }
  | {
      kind: 'group-invite';
      groupId: string;
      groupName: string;
      ownerNodeId: string;
      revision: number;
      memberIds: string[];
      members: Array<{
        nodeId: string;
        nickname: string;
        color: string;
        identity: PublicIdentity;
      }>;
    };

type BleHandshakeChallenge = {
  wireType: 'anyway-ble-handshake-v1';
  kind: 'challenge';
  challengeId: string;
  nonce: string;
  expiresAt: number;
};

type BleHandshakeResponse = {
  wireType: 'anyway-ble-handshake-v1';
  kind: 'response';
  challengeId: string;
  nonce: string;
  expiresAt: number;
  responderIdentity: PublicIdentity;
  signature: string;
};

type BleHandshakeFrame = BleHandshakeChallenge | BleHandshakeResponse;

const MeshContext = createContext<MeshContextValue | null>(null);

const PEER_STALE_MS = 2 * 60 * 1000;
const TOPOLOGY_EXPIRY_MS = ANNOUNCE_INTERVAL_MS * 3;
const CAPABILITY_LIFETIME_MS = TOPOLOGY_EXPIRY_MS;
const DEMO_EVENT_LIMIT = 80;
const RSSI_HISTORY_LIMIT = 40;
const UNKNOWN_RSSI: null = null;
const RADIO_CONFIRM_TIMEOUT_MS = 5_000;
const RADIO_SETTLE_MS = 400;
const FORWARD_BATCH_SIZE = 48;
/**
 * The native side queues at most MAX_QUEUED_FRAGMENTS_PER_PEER (512) fragments
 * per peer and `enqueueFragments` is all-or-nothing, so how many messages fit
 * depends entirely on the negotiated MTU. At 517 a ~1.2 KB envelope is ~3
 * fragments and 48 of them fit easily; at the 23-byte floor the same envelope
 * is ~86 fragments and only about six fit — so asking for 48 meant ~42 of them
 * were rejected *after* each had already paid a relay-chain verification, an
 * Ed25519 signature and a whole-store persist, and each rejection then entered
 * exponential backoff as if the transport had failed. That is a ~28x
 * difference in effective batch capacity between two phones on the same pair,
 * which is most of what "one phone is always the slower one" is made of.
 */
const NATIVE_FRAGMENT_QUEUE = 512;
const FRAGMENT_HEADER_BYTES = 6;
/** Bluetooth caps a GATT attribute value at 512 octets whatever the ATT MTU. */
const MAX_ATTRIBUTE_VALUE_BYTES = 512;
const MIN_FORWARD_BATCH_SIZE = 4;
/** Rough upper bound for a signed, relayed envelope, used only for sizing. */
const TYPICAL_ENVELOPE_BYTES = 1_200;
const MAX_TEXT_CHARACTERS = 2_048;
const MAX_GROUP_MEMBERS = 8;
/** MTU 23, 6-byte fragment header, 512 fragments in the current dense BLE runtime. */
const BLE_BASELINE_ENVELOPE_BYTES = 7_168;
const BLE_HANDSHAKE_LIFETIME_MS = 15_000;
/**
 * How much better a rival endpoint must score before traffic moves to it. Small
 * enough that a genuinely faster radio wins quickly, large enough that two
 * comparable links never trade the peer back and forth message by message.
 */
const ENDPOINT_SWITCH_MARGIN = 0.12;
/**
 * How long an unchanged profile may go without being re-announced. Must stay
 * below TOPOLOGY_EXPIRY_MS or peers would age this node out of their topology
 * between refreshes.
 */
const CAPABILITY_REFRESH_MS = 45_000;
const RECEIPT_REISSUE_COOLDOWN_MS = 30_000;
const RECEIPT_LIFETIME_MS = 2 * 60 * 60 * 1000;
/** UI batching only; it never changes native BLE discovery/scan cadence. */
const DIAGNOSTIC_UI_BATCH_MS = 300;

const EMPTY_STORE_STATS: MessageStoreStats = {
  entries: 0,
  bytes: 0,
  byPriority: { normal: 0, important: 0, sos: 0 },
  pending: 0,
  forwarded: 0,
  delivered: 0,
  seenIds: 0,
};

const EMPTY_RADIO_STATE: BleMeshRadioState = {
  bluetoothEnabled: false,
  hasPermissions: false,
  starting: false,
  running: false,
  advertising: false,
  scanning: false,
  gattServerReady: false,
  generation: 0,
  connectedPeers: 0,
  outgoingConnections: 0,
  incomingConnections: 0,
};

const EMPTY_WIFI_AWARE_STATE: WifiAwareState = {
  supported: false,
  available: false,
  hasPermission: false,
  starting: false,
  running: false,
  attached: false,
  publishing: false,
  subscribing: false,
  generation: 0,
  discoveredPeers: 0,
  connectedPeers: 0,
  powerSaveMode: false,
  foregroundServiceActive: false,
  maxFrameBytes: 256 * 1024,
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalized 0 (cheap) to 1 (expensive). BLE is the substrate precisely because
 * it is cheap enough to leave running; a Wi-Fi Aware data path costs far more to
 * hold open, so the router should only prefer it when the payload earns it.
 */
const TRANSPORT_ENERGY_COST: Record<PeerTransport, number> = {
  ble: 0.15,
  'wifi-aware': 0.75,
};

/**
 * Rough bytes/second per transport. For BLE the negotiated MTU is the dominant
 * term: one GATT operation carries `mtu - 3 - 6` payload bytes and the stack
 * sustains roughly one operation per connection interval.
 */
function estimateThroughput(transport: PeerTransport, mtu: number): number {
  if (transport === 'wifi-aware') return 1_500_000;
  const perOperation = Math.max(1, mtu - 3 - 6);
  const operationsPerSecond = 25;
  return perOperation * operationsPerSecond;
}

/** A link that has stayed up is worth more than one that just appeared. */
function linkStability(establishedAt: number | undefined, now: number): number {
  if (establishedAt === undefined) return 0.5;
  const minutes = Math.max(0, now - establishedAt) / 60_000;
  return Math.min(1, 0.35 + minutes / 5);
}

/**
 * How far along a message is, as a number the UI can compare. Terminal outcomes
 * ('expired', 'failed') sit outside the ladder: they are set deliberately and
 * must never be overwritten by a routine retry stamp either.
 */
const MESSAGE_STATE_RANK: Record<string, number> = {
  created: 0,
  stored: 1,
  received: 1,
  pending: 2,
  forwarded: 3,
  delivered: 4,
  expired: 5,
  failed: 5,
};

function rankMessageState(state: string | undefined): number {
  return state === undefined ? -1 : MESSAGE_STATE_RANK[state] ?? 0;
}

/**
 * The time a message is *placed at* in a conversation: the sender's own
 * `createdAt`, but never later than the moment this phone actually received it.
 *
 * Neither clock works alone here. `createdAt` is stamped by whoever wrote the
 * message, and two phones in a blackout have no time source to agree on, so a
 * sender running fast can drop a message above ones that were written after it.
 * `storedAt` is stamped locally and so is skew-proof — but it is arrival order,
 * and in a store-and-forward mesh arrival order is deliberately *not*
 * chronological: `getForwardCandidates` drains a backlog by priority and fewest
 * attempts, so a peer can hand us an 11:00 message before the 10:00 one it has
 * been carrying longer. Ordering purely by arrival would show that backlog
 * upside down.
 *
 * Clamping keeps the sender's chronology, which is the thing worth preserving,
 * and only overrides it where it is provably wrong: a message cannot have been
 * written after it was received. Ties fall back to arrival, then to `id`, so
 * the sort is total and stable across re-renders.
 *
 * What this still does not fix is a sender whose clock runs *slow* — nothing
 * local can detect that. The real cure is a per-peer clock offset measured
 * during the handshake, which today carries no timestamp to measure with.
 */
function displayTimeOf(message: ChatMessage): number {
  return Math.min(message.createdAt, message.storedAt);
}

function compareForDisplay(left: ChatMessage, right: ChatMessage): number {
  const leftAt = displayTimeOf(left);
  const rightAt = displayTimeOf(right);
  if (leftAt !== rightAt) return leftAt - rightAt;
  if (left.storedAt !== right.storedAt) return left.storedAt - right.storedAt;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Readable one-liner for any thrown value, so a boot failure can be shown on screen. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message ? `${error.name}: ${error.message}` : error.name;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? 'Error desconocido';
  } catch {
    return 'Error desconocido';
  }
}

function retentionFor(priority: MessagePriority): number {
  if (priority === 'sos') return 7 * 24 * 60 * 60 * 1000;
  if (priority === 'important') return 3 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function uiHopCount(networkHopCount: number): number {
  return Math.max(0, networkHopCount - 1);
}

function normalizeRadioState(value: BleMeshRadioState): BleMeshRadioState {
  // The dense native inspection fields are optional on older bridges. Keep
  // them absent instead of manufacturing zero/false observations.
  return { ...value };
}

function nativeCapabilitiesOrNull(): ReturnType<typeof BleMesh.getCapabilities> | null {
  try {
    return typeof BleMesh.getCapabilities === 'function' ? BleMesh.getCapabilities() : null;
  } catch {
    return null;
  }
}

function buildCapabilities(
  radio: BleMeshRadioState,
  aware: WifiAwareState = EMPTY_WIFI_AWARE_STATE,
): NodeCapabilities {
  const now = Date.now();
  const native = nativeCapabilitiesOrNull();
  const baselineMaxMessageBytes =
    native?.baselineMaxMessageBytes ?? BLE_BASELINE_ENVELOPE_BYTES;
  const bleSupported = native?.ble.supported ?? Platform.OS === 'android';
  const bleAvailable = bleSupported && radio.bluetoothEnabled && radio.hasPermissions;
  const awareAvailability = aware.running
    ? 'supported'
    : !native
    ? 'unknown'
    : !native.wifiAware.supported || !native.wifiAware.automaticTransport
      ? 'unsupported'
      : native.wifiAware.available
        ? 'supported'
        : 'temporarily-unavailable';
  const directAvailability = !native
    ? 'unknown'
    : native.wifiDirect.supported
      ? 'supported'
      : 'unsupported';

  return {
    protocolVersions: [CORE_PROTOCOL_VERSION],
    transports: {
      ble: {
        kind: 'ble',
        availability: bleSupported
          ? bleAvailable
            ? 'supported'
            : 'temporarily-unavailable'
          : 'unsupported',
        canDiscover: native?.ble.scanningAvailable ?? bleSupported,
        canAdvertise: native?.ble.advertisingAvailable ?? bleSupported,
        canInitiateLinks: bleSupported,
        canAcceptLinks: native?.ble.advertisingSupported ?? bleSupported,
        supportsDuplex: true,
        // The native radio/FGS survives UI detach, but message routing still
        // requires the JS runtime (`messagingHeadlessDurable=false`).
        supportsBackgroundOperation: false,
        supportsRanging: false,
        maxConcurrentLinks: native?.maxLogicalLinks ?? radio.logicalLinkBudget,
        maxPayloadBytes: baselineMaxMessageBytes,
        evidence: {
          source: native ? 'runtime-probe' : 'inferred',
          observedAt: now,
          detail: 'Persistent radio runtime; JS engine required for DTN messaging',
        },
      },
      'wifi-aware': {
        kind: 'wifi-aware',
        availability: awareAvailability,
        canDiscover: aware.running,
        canAdvertise: aware.running,
        canInitiateLinks: aware.running,
        canAcceptLinks: aware.running,
        supportsDuplex: true,
        supportsBackgroundOperation: false,
        supportsRanging: false,
        maxConcurrentLinks: 4,
        maxPayloadBytes: aware.maxFrameBytes,
        evidence: {
          source: native ? 'runtime-probe' : 'inferred',
          observedAt: now,
          detail: aware.running
            ? 'Automatic encrypted Wi-Fi Aware data path active'
            : aware.error ?? 'Automatic data path available when hardware permits',
        },
      },
      'wifi-direct': {
        kind: 'wifi-direct',
        availability: directAvailability,
        canDiscover: false,
        canAdvertise: false,
        canInitiateLinks: false,
        canAcceptLinks: false,
        supportsDuplex: true,
        supportsBackgroundOperation: false,
        supportsRanging: false,
        evidence: {
          source: native ? 'runtime-probe' : 'inferred',
          observedAt: now,
          detail: 'Capability only; explicit user-mediated links are future work',
        },
      },
    },
    supportsStoreAndForward: true,
    supportsMultipath: true,
    supportsEndToEndEncryption: true,
    supportsLocationPayloads: true,
    maxRelayHops: 10,
    maxEnvelopeBytes: baselineMaxMessageBytes,
    updatedAt: now,
  };
}

function capabilityShapeKey(value: NodeCapabilities): string {
  return JSON.stringify({
    ...value,
    updatedAt: 0,
    transports: Object.fromEntries(
      Object.entries(value.transports).map(([key, transport]) => [
        key,
        {
          ...transport,
          evidence: transport.evidence
            ? { ...transport.evidence, observedAt: 0 }
            : undefined,
        },
      ]),
    ),
  });
}

function isValidRequiredText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Array.from(value).length <= MAX_TEXT_CHARACTERS
  );
}

function isValidOptionalText(value: unknown): value is string | undefined {
  return value === undefined || isValidRequiredText(value);
}

function isPrivatePayload(value: unknown): value is PrivateApplicationPayload {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (typeof item.kind !== 'string') return false;
  if (item.kind === 'direct-text') {
    return (
      isValidRequiredText(item.text) &&
      typeof item.displayId === 'string'
    );
  }
  if (item.kind === 'group-text') {
    return (
      typeof item.groupId === 'string' &&
      isValidRequiredText(item.text) &&
      typeof item.displayId === 'string'
    );
  }
  if (item.kind === 'emergency' || item.kind === 'group-emergency') {
    return (
      (item.kind !== 'group-emergency' || typeof item.groupId === 'string') &&
      isValidOptionalText(item.text) &&
      (item.location === undefined || isGeoLocation(item.location)) &&
      (item.priority === 'important' || item.priority === 'sos') &&
      typeof item.displayId === 'string' &&
      (item.text !== undefined || item.location !== undefined)
    );
  }
  if (item.kind === 'group-invite') {
    return (
      typeof item.groupId === 'string' &&
      typeof item.groupName === 'string' &&
      item.groupName.length <= 64 &&
      typeof item.ownerNodeId === 'string' &&
      typeof item.revision === 'number' &&
      Number.isSafeInteger(item.revision) &&
      item.revision >= 1 &&
      Array.isArray(item.memberIds) &&
      item.memberIds.length <= MAX_GROUP_MEMBERS &&
      item.memberIds.every((id) => typeof id === 'string') &&
      Array.isArray(item.members) &&
      item.members.length <= MAX_GROUP_MEMBERS &&
      item.members.every((member) => {
        if (!member || typeof member !== 'object') return false;
        const profile = member as Record<string, unknown>;
        return (
          typeof profile.nodeId === 'string' &&
          typeof profile.nickname === 'string' &&
          typeof profile.color === 'string' &&
          !!profile.identity &&
          typeof profile.identity === 'object'
        );
      })
    );
  }
  return false;
}

function samePublicIdentity(left: PublicIdentity, right: PublicIdentity): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.signingPublicKey === right.signingPublicKey &&
    left.boxPublicKey === right.boxPublicKey &&
    left.attestation === right.attestation
  );
}

function isFiniteOptional(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isGeoLocation(value: unknown): value is GeoLocation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const altitudeAccuracy = item.altitudeAccuracyMeters;
  const heading = item.headingDegrees;
  const speed = item.speedMetersPerSecond;
  return (
    typeof item.latitude === 'number' &&
    Number.isFinite(item.latitude) &&
    item.latitude >= -90 &&
    item.latitude <= 90 &&
    typeof item.longitude === 'number' &&
    Number.isFinite(item.longitude) &&
    item.longitude >= -180 &&
    item.longitude <= 180 &&
    typeof item.acquiredAt === 'number' &&
    Number.isFinite(item.acquiredAt) &&
    (item.accuracyMeters === undefined ||
      (typeof item.accuracyMeters === 'number' &&
        Number.isFinite(item.accuracyMeters) &&
        item.accuracyMeters >= 0)) &&
    isFiniteOptional(item.altitudeMeters) &&
    isFiniteOptional(altitudeAccuracy) &&
    isFiniteOptional(heading) &&
    isFiniteOptional(speed) &&
    (altitudeAccuracy === undefined || altitudeAccuracy >= 0) &&
    (heading === undefined || (heading >= 0 && heading <= 360)) &&
    (speed === undefined || speed >= 0) &&
    (item.provider === undefined ||
      item.provider === 'gnss' ||
      item.provider === 'network' ||
      item.provider === 'fused' ||
      item.provider === 'unknown')
  );
}

function conversationIdFor(target: MeshTarget): string {
  if (target.kind === 'broadcast') return BROADCAST_CONVERSATION_ID;
  if (target.kind === 'direct') return directConversationId(target.nodeId);
  return groupConversationId(target.groupId);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isMeshTarget(value: unknown): value is MeshTarget {
  if (!isRecordValue(value)) return false;
  return (
    value.kind === 'broadcast' ||
    (value.kind === 'direct' && typeof value.nodeId === 'string') ||
    (value.kind === 'group' && typeof value.groupId === 'string')
  );
}

function isBleHandshakeFrame(value: unknown): value is BleHandshakeFrame {
  if (!isRecordValue(value) || value.wireType !== 'anyway-ble-handshake-v1') {
    return false;
  }
  if (
    (value.kind !== 'challenge' && value.kind !== 'response') ||
    typeof value.challengeId !== 'string' ||
    value.challengeId.length < 8 ||
    value.challengeId.length > 128 ||
    typeof value.nonce !== 'string' ||
    value.nonce.length < 8 ||
    value.nonce.length > 128 ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt)
  ) {
    return false;
  }
  if (value.kind === 'challenge') return true;
  if (
    !isRecordValue(value.responderIdentity) ||
    typeof value.responderIdentity.nodeId !== 'string' ||
    typeof value.responderIdentity.signingPublicKey !== 'string' ||
    typeof value.responderIdentity.boxPublicKey !== 'string' ||
    typeof value.responderIdentity.attestation !== 'string' ||
    typeof value.signature !== 'string'
  ) {
    return false;
  }
  return true;
}

function bleHandshakeResponseClaim(
  frame: Omit<BleHandshakeResponse, 'signature'>,
): unknown {
  return {
    scope: 'anyway-ble-address-binding-v1',
    wireType: frame.wireType,
    kind: frame.kind,
    challengeId: frame.challengeId,
    nonce: frame.nonce,
    expiresAt: frame.expiresAt,
    responderIdentity: frame.responderIdentity,
  };
}

function sanitizeStoredConversations(value: unknown): Record<string, Conversation> {
  if (!isRecordValue(value)) return {};
  const result: Record<string, Conversation> = {};
  for (const [id, candidate] of Object.entries(value)) {
    if (!isRecordValue(candidate) || candidate.id !== id) continue;
    if (
      candidate.kind !== 'broadcast' &&
      candidate.kind !== 'direct' &&
      candidate.kind !== 'group'
    ) {
      continue;
    }
    result[id] = {
      id,
      kind: candidate.kind,
      peerNodeId:
        typeof candidate.peerNodeId === 'string' ? candidate.peerNodeId : undefined,
      groupId: typeof candidate.groupId === 'string' ? candidate.groupId : undefined,
      groupName: typeof candidate.groupName === 'string' ? candidate.groupName : undefined,
      memberIds: Array.isArray(candidate.memberIds)
        ? candidate.memberIds.filter((member): member is string => typeof member === 'string')
        : undefined,
      ownerNodeId:
        typeof candidate.ownerNodeId === 'string' ? candidate.ownerNodeId : undefined,
      revision:
        typeof candidate.revision === 'number' && Number.isSafeInteger(candidate.revision)
          ? Math.max(0, candidate.revision)
          : undefined,
      unreadCount:
        typeof candidate.unreadCount === 'number' && Number.isFinite(candidate.unreadCount)
          ? Math.max(0, Math.floor(candidate.unreadCount))
          : 0,
    };
  }
  return result;
}

function sanitizeStoredMessages(value: unknown): Record<string, ChatMessage[]> {
  if (!isRecordValue(value)) return {};
  const result: Record<string, ChatMessage[]> = {};
  for (const [conversationId, rawList] of Object.entries(value)) {
    if (!Array.isArray(rawList)) continue;
    const list: ChatMessage[] = [];
    for (const candidate of rawList) {
      if (
        !isRecordValue(candidate) ||
        typeof candidate.id !== 'string' ||
        typeof candidate.senderId !== 'string' ||
        typeof candidate.senderName !== 'string' ||
        typeof candidate.senderColor !== 'string' ||
        typeof candidate.ts !== 'number' ||
        !Number.isFinite(candidate.ts) ||
        typeof candidate.text !== 'string' ||
        !isMeshTarget(candidate.to)
      ) {
        continue;
      }
      const path = Array.isArray(candidate.path)
        ? candidate.path.filter((node): node is string => typeof node === 'string')
        : [candidate.senderId];
      const networkHops =
        typeof candidate.networkHops === 'number' && Number.isFinite(candidate.networkHops)
          ? Math.max(0, Math.floor(candidate.networkHops))
          : typeof candidate.hops === 'number' && Number.isFinite(candidate.hops)
            ? Math.max(0, Math.floor(candidate.hops) + 1)
            : Math.max(0, path.length - 1);
      const allowedStates = new Set([
        'created',
        'stored',
        'pending',
        'forwarded',
        'received',
        'delivered',
        'expired',
        'failed',
      ]);
      list.push({
        id: candidate.id,
        senderId: candidate.senderId,
        senderName: candidate.senderName,
        senderColor: isValidPaletteColor(candidate.senderColor)
          ? candidate.senderColor
          : defaultColorForNodeId(candidate.senderId),
        ts: candidate.ts,
        createdAt:
          typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
            ? candidate.createdAt
            : candidate.ts,
        storedAt:
          typeof candidate.storedAt === 'number' && Number.isFinite(candidate.storedAt)
            ? candidate.storedAt
            : candidate.ts,
        sentAt:
          typeof candidate.sentAt === 'number' && Number.isFinite(candidate.sentAt)
            ? candidate.sentAt
            : undefined,
        receivedAt:
          typeof candidate.receivedAt === 'number' && Number.isFinite(candidate.receivedAt)
            ? candidate.receivedAt
            : undefined,
        to: candidate.to,
        text: candidate.text,
        hops: Math.max(0, networkHops - 1),
        networkHops,
        path,
        priority:
          candidate.priority === 'important' || candidate.priority === 'sos'
            ? candidate.priority
            : 'normal',
        state:
          typeof candidate.state === 'string' && allowedStates.has(candidate.state)
            ? (candidate.state as ChatMessage['state'])
            : candidate.senderId
              ? 'received'
              : 'stored',
        location: isGeoLocation(candidate.location) ? candidate.location : undefined,
        encrypted: candidate.encrypted === true,
        delivered: candidate.delivered === true,
        wireMessageIds: Array.isArray(candidate.wireMessageIds)
          ? Array.from(
              new Set(
                candidate.wireMessageIds.filter(
                  (item): item is string => typeof item === 'string' && item.length > 0,
                ),
              ),
            ).slice(0, MAX_GROUP_MEMBERS)
          : undefined,
      });
    }
    // Same ordering rule as appendMessage, so a restart cannot reshuffle a
    // conversation the user has already read.
    result[conversationId] = list.sort(compareForDisplay).slice(-300);
  }
  return result;
}

export function MeshProvider({ children }: { children: React.ReactNode }) {
  const diagnosticsBuffer = useRef(new DiagnosticRingBuffer(750)).current;
  const [diagnosticRevision, setDiagnosticRevision] = useState(0);
  const [status, setStatus] = useState<MeshStatus>('idle');
  const [meshEnabled, setMeshEnabled] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [hydrationFailure, setHydrationFailure] = useState<HydrationFailure | null>(null);
  const [hydrationWarnings, setHydrationWarnings] = useState<HydrationFailure[]>([]);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [nickname, setNicknameState] = useState<string | null>(null);
  const [ttl, setTtlState] = useState(DEFAULT_TTL);
  const [color, setColorState] = useState<string>(DEFAULT_COLOR);
  const [peers, setPeers] = useState<Record<string, PeerInfo>>({});
  const [knownPeers, setKnownPeers] = useState<Record<string, KnownPeer>>({});
  const [conversations, setConversations] = useState<Record<string, Conversation>>({});
  const [messagesByConversation, setMessagesByConversation] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [topology, setTopology] = useState<Record<string, TopologyInfo>>({});
  const [demoEvents, setDemoEvents] = useState<DemoEvent[]>([]);
  const [rssiHistory, setRssiHistory] = useState<Record<string, RssiSample[]>>({});
  const [batteryOptimizationIgnored, setBatteryOptimizationIgnored] = useState(true);
  const [radioState, setRadioState] = useState<BleMeshRadioState>(EMPTY_RADIO_STATE);
  const [wifiAwareState, setWifiAwareState] =
    useState<WifiAwareState>(EMPTY_WIFI_AWARE_STATE);
  const [capabilities, setCapabilities] = useState<NodeCapabilities>(() =>
    buildCapabilities(EMPTY_RADIO_STATE, EMPTY_WIFI_AWARE_STATE),
  );
  const [nativeLinkSnapshots, setNativeLinkSnapshots] = useState<
    ReturnType<typeof BleMesh.getLinkSnapshots>
  >([]);
  const [storeStats, setStoreStats] = useState<MessageStoreStats>(EMPTY_STORE_STATS);

  const identityRef = useRef<AnywayIdentity | null>(null);
  const storeRef = useRef<PersistentMessageStore | null>(null);
  const nodeIdRef = useRef<string | null>(null);
  const nicknameRef = useRef<string | null>(null);
  const ttlRef = useRef(DEFAULT_TTL);
  const colorRef = useRef<string>(DEFAULT_COLOR);
  const peersRef = useRef<Record<string, PeerInfo>>({});
  const topologyRef = useRef<Record<string, TopologyInfo>>({});
  const nativeLinkSnapshotsRef = useRef<ReturnType<typeof BleMesh.getLinkSnapshots>>([]);
  const capabilitiesRef = useRef(capabilities);
  const radioStateRef = useRef(radioState);
  const wifiAwareStateRef = useRef(wifiAwareState);
  const knownPeersRef = useRef<Record<string, KnownPeer>>({});
  const conversationsRef = useRef<Record<string, Conversation>>({});
  const messagesRef = useRef<Record<string, ChatMessage[]>>({});
  const activeConversationIdRef = useRef<string | null>(null);
  const addressToNodeIdRef = useRef(new Map<string, string>());
  const pendingHandshakeRef = useRef(new Map<string, BleHandshakeChallenge>());
  const handshakeResponseAtRef = useRef(new Map<string, number>());
  /** Challenge send time per address, so a verified response yields a latency sample. */
  const handshakeSentAtRef = useRef(new Map<string, number>());
  /**
   * Endpoint currently chosen per peer. Switching radios costs a link setup and
   * reorders traffic, so a challenger has to beat the incumbent by a margin
   * before it takes over — otherwise two similarly scored transports would
   * ping-pong on every message.
   */
  const activeEndpointRef = useRef(new Map<string, string>());
  /** Endpoint scoring needs the link table, which is defined further down. */
  const buildRoutingLinksRef = useRef<() => Link[]>(() => []);
  /** Profile fingerprint and timestamp, so an unchanged announce can be skipped. */
  const lastCapabilitySignatureRef = useRef<string | null>(null);
  const lastCapabilityAnnounceRef = useRef(0);
  const receiptCooldownRef = useRef(new Map<string, number>());
  const flushLocksRef = useRef(new Map<string, Promise<void>>());
  const wireToDisplayRef = useRef(new Map<string, { displayId: string; aggregate: boolean }>());
  // Millisecond epoch keeps the sequence increasing across ordinary JS/app
  // restarts without another durable metadata key.
  const topologySequenceRef = useRef(Date.now());
  const startInFlightRef = useRef<Promise<void> | null>(null);
  const restartInFlightRef = useRef<Promise<void> | null>(null);
  const hydrationInFlightRef = useRef<Promise<void> | null>(null);
  const hydratedRef = useRef(false);
  const clearMessagesInFlightRef = useRef<Promise<void> | null>(null);
  const clearingMessagesRef = useRef(false);
  const activeApplicationWritesRef = useRef(new Set<Promise<unknown>>());
  const activeInboundWritesRef = useRef(new Set<Promise<unknown>>());
  const radioGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const meshEnabledRef = useRef(true);
  const stopRequestedRef = useRef(false);
  const meshLifecycleIntentRef = useRef<'start' | 'stop' | null>(null);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const broadcastCapabilityRef = useRef<() => Promise<void>>(async () => undefined);

  nodeIdRef.current = nodeId;
  nicknameRef.current = nickname;
  ttlRef.current = ttl;
  colorRef.current = color;
  peersRef.current = peers;
  topologyRef.current = topology;
  nativeLinkSnapshotsRef.current = nativeLinkSnapshots;
  knownPeersRef.current = knownPeers;
  conversationsRef.current = conversations;
  messagesRef.current = messagesByConversation;
  radioStateRef.current = radioState;
  wifiAwareStateRef.current = wifiAwareState;

  const updateCapabilities = useCallback((currentRadio: BleMeshRadioState) => {
    const next = buildCapabilities(currentRadio, wifiAwareStateRef.current);
    if (capabilityShapeKey(capabilitiesRef.current) === capabilityShapeKey(next)) return;
    capabilitiesRef.current = next;
    setCapabilities(next);
    void broadcastCapabilityRef.current();
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = diagnosticsBuffer.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setDiagnosticRevision((value) => value + 1);
      }, DIAGNOSTIC_UI_BATCH_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [diagnosticsBuffer]);

  const enqueuePersistence = useCallback(
    (operation: () => Promise<void>): Promise<void> => {
      const run = persistenceQueueRef.current.catch(() => undefined).then(operation);
      persistenceQueueRef.current = run;
      // Callers that need a commit boundary await the returned promise. Older
      // UI-only callers remain best-effort, but failures are still observable.
      void run.catch((error) =>
        diagnosticsBuffer.error('store', 'local-history-write-failed', { error }),
      );
      return run;
    },
    [diagnosticsBuffer],
  );

  const replaceConversations = useCallback(
    (next: Record<string, Conversation>) => {
      conversationsRef.current = next;
      setConversations(next);
      void enqueuePersistence(() => setStoredConversations(next));
    },
    [enqueuePersistence],
  );

  const replaceKnownPeers = useCallback(
    (next: Record<string, KnownPeer>) => {
      knownPeersRef.current = next;
      setKnownPeers(next);
      void enqueuePersistence(() => setStoredKnownPeers(next));
    },
    [enqueuePersistence],
  );

  const replaceMessages = useCallback(
    (next: Record<string, ChatMessage[]>) => {
      messagesRef.current = next;
      setMessagesByConversation(next);
      void enqueuePersistence(() => setStoredMessagesByConversation(next));
    },
    [enqueuePersistence],
  );

  const refreshStoreStats = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    try {
      const next = await store.stats();
      if (mountedRef.current) setStoreStats(next);
    } catch (error) {
      diagnosticsBuffer.warn('store', 'stats-failed', { error });
    }
  }, [diagnosticsBuffer]);

  const refreshNativeInspection = useCallback((currentRadio?: BleMeshRadioState) => {
    try {
      if (typeof BleMesh.getLinkSnapshots === 'function') {
        const snapshots = BleMesh.getLinkSnapshots();
        nativeLinkSnapshotsRef.current = snapshots;
        setNativeLinkSnapshots(snapshots);
      }
    } catch (error) {
      diagnosticsBuffer.debug('transport', 'link-snapshot-unavailable', { error });
    }
    updateCapabilities(currentRadio ?? radioStateRef.current);
  }, [diagnosticsBuffer, updateCapabilities]);

  useEffect(() => {
    let cancelled = false;
    const warnings: HydrationFailure[] = [];
    // A recoverable stage must never brick startup: one unreadable record used
    // to leave the app permanently stuck on the error screen with no way to see
    // why. Losing that record and booting is strictly better than not booting.
    const recoverable = async <T,>(
      stage: HydrationStage,
      fallback: T,
      load: () => Promise<T>,
    ): Promise<T> => {
      try {
        return await load();
      } catch (error) {
        warnings.push({ stage, message: describeError(error), fatal: false });
        diagnosticsBuffer.warn('app', 'hydration-stage-degraded', {
          stage,
          error: describeError(error),
        });
        return fallback;
      }
    };

    const run = (async () => {
      let stage: HydrationStage = 'identity';
      try {
        const identity = await getOrCreateIdentity();

        stage = 'preferences';
        const [
          storedNickname,
          storedTtl,
          storedColor,
          storedConversations,
          storedMessages,
          storedPeers,
          storedMeshEnabled,
        ] =
          await Promise.all([
            recoverable('preferences', null, getStoredNickname),
            recoverable('preferences', null, getStoredTtl),
            recoverable('preferences', null, getStoredColor),
            recoverable('preferences', {} as Awaited<ReturnType<typeof getStoredConversations>>,
              getStoredConversations),
            recoverable('preferences', {} as Awaited<
              ReturnType<typeof getStoredMessagesByConversation>
            >, getStoredMessagesByConversation),
            recoverable('preferences', {} as Awaited<ReturnType<typeof getStoredKnownPeers>>,
              getStoredKnownPeers),
            recoverable('preferences', true, getStoredMeshEnabled),
          ]);

        stage = 'legacy-purge';
        await recoverable('legacy-purge', undefined, discardLegacyV1Data);

        stage = 'store-open';
        const store = new PersistentMessageStore(identity.nodeId, { storage: anywayCoreStorage });
        await store.initialize();
        if (cancelled) return;

        stage = 'reconcile';

        const safeKnownPeers: Record<string, KnownPeer> = {};
        const storedPeerValues = isRecordValue(storedPeers)
          ? Object.values(storedPeers)
          : [];
        for (const candidate of storedPeerValues) {
          if (
            !isRecordValue(candidate) ||
            typeof candidate.nodeId !== 'string' ||
            candidate.nodeId === identity.nodeId ||
            typeof candidate.nickname !== 'string' ||
            typeof candidate.color !== 'string'
          ) {
            continue;
          }
          const publicIdentity = candidate.identity as PublicIdentity | undefined;
          if (
            publicIdentity &&
            (publicIdentity.nodeId !== candidate.nodeId ||
              !verifyPublicIdentity(publicIdentity))
          ) {
            continue;
          }
          safeKnownPeers[candidate.nodeId] = {
            nodeId: candidate.nodeId,
            nickname: candidate.nickname.slice(0, 64),
            color: isValidPaletteColor(candidate.color)
              ? candidate.color
              : defaultColorForNodeId(candidate.nodeId),
            lastSeenTs:
              typeof candidate.lastSeenTs === 'number' && Number.isFinite(candidate.lastSeenTs)
                ? candidate.lastSeenTs
                : 0,
            identity: publicIdentity,
            // Capabilities are refreshed from a signed, schema-validated
            // capability envelope; do not trust an arbitrary persisted shape.
            capabilities: undefined,
            trust: candidate.trust === 'verified' ? 'verified' : 'key-observed',
          };
        }
        const seededConversations = sanitizeStoredConversations(storedConversations);
        const safeStoredMessages = sanitizeStoredMessages(storedMessages);
        if (!seededConversations[BROADCAST_CONVERSATION_ID]) {
          seededConversations[BROADCAST_CONVERSATION_ID] = {
            id: BROADCAST_CONVERSATION_ID,
            kind: 'broadcast',
            unreadCount: 0,
          };
        }

        identityRef.current = identity;
        storeRef.current = store;
        nodeIdRef.current = identity.nodeId;
        setNodeId(identity.nodeId);
        nicknameRef.current = storedNickname;
        setNicknameState(storedNickname);
        const nextTtl = storedTtl ? Math.max(1, Math.min(10, storedTtl)) : DEFAULT_TTL;
        ttlRef.current = nextTtl;
        setTtlState(nextTtl);
        const nextColor = storedColor ?? defaultColorForNodeId(identity.nodeId);
        colorRef.current = nextColor;
        setColorState(nextColor);
        conversationsRef.current = seededConversations;
        setConversations(seededConversations);
        let durableEntries = await store.snapshot();
        let reconciledFinalAck = false;
        const durableById = new Map(
          durableEntries.map((entry) => [entry.envelope.messageId, entry] as const),
        );
        const localPublicIdentity = toPublicIdentity(identity);
        for (const receiptEntry of durableEntries) {
          const receipt = receiptEntry.envelope;
          // Per-entry guard: reconciling stored receipts is a best-effort catch-up,
          // so one unreadable record must not prevent the app from starting.
          try {
            if (
              receipt.kind !== 'receipt' ||
              receipt.payload.status !== 'delivered-to-destination' ||
              !verifyRelayChain(receipt, (candidateNodeId) =>
                candidateNodeId === identity.nodeId
                  ? localPublicIdentity
                  : safeKnownPeers[candidateNodeId]?.identity,
              )
            ) {
              continue;
            }
            const original = durableById.get(receipt.payload.receiptFor);
            if (
              !original ||
              original.envelope.kind !== 'content' ||
              original.immutableFingerprint !== receipt.payload.receiptForFingerprint ||
              original.finalAck?.messageFingerprint ===
                receipt.payload.receiptForFingerprint ||
              receipt.destination.kind !== 'direct' ||
              receipt.destination.nodeId !== original.envelope.originId ||
              original.envelope.destination.kind !== 'direct' ||
              original.envelope.destination.nodeId !== receipt.originId ||
              receipt.payload.reportingNodeId !== receipt.originId
            ) {
              continue;
            }
            reconciledFinalAck =
              (await store.recordFinalAck(original.envelope.messageId, {
                destinationNodeId: receipt.originId,
                messageFingerprint: receipt.payload.receiptForFingerprint,
                acknowledgedAt: Date.now(),
                receiptMessageId: receipt.messageId,
                verified: true,
              })) || reconciledFinalAck;
          } catch (error) {
            diagnosticsBuffer.warn('app', 'receipt-reconcile-skipped', {
              error: describeError(error),
            });
          }
        }
        if (reconciledFinalAck) durableEntries = await store.snapshot();
        const durableOutgoing = new Map(
          durableEntries
            .filter((entry) => entry.envelope.originId === identity.nodeId)
            .map((entry) => [entry.envelope.messageId, entry] as const),
        );
        const reconciledMessages: Record<string, ChatMessage[]> = {};
        for (const [conversationId, list] of Object.entries(safeStoredMessages)) {
          reconciledMessages[conversationId] = list.map((message) => {
            const wireMessageIds =
              message.wireMessageIds && message.wireMessageIds.length > 0
                ? message.wireMessageIds
                : [message.id];
            if (message.senderId === identity.nodeId) {
              for (const wireMessageId of wireMessageIds) {
                wireToDisplayRef.current.set(wireMessageId, {
                  displayId: message.id,
                  aggregate: message.to.kind === 'group',
                });
              }
            }
            if (message.to.kind === 'group' && message.wireMessageIds?.length) {
              const durableCopies = message.wireMessageIds.map((wireMessageId) =>
                durableOutgoing.get(wireMessageId),
              );
              if (
                durableCopies.length > 0 &&
                durableCopies.every((entry) => !!entry?.finalAck)
              ) {
                return { ...message, state: 'delivered' as const, delivered: true };
              }
              if (
                durableCopies.length > 0 &&
                durableCopies.every(
                  (entry) =>
                    !!entry &&
                    (entry.state === 'forwarded' || entry.state === 'delivered'),
                )
              ) {
                return { ...message, state: 'forwarded' as const };
              }
              return message;
            }
            const durable =
              message.to.kind === 'group' ? undefined : durableOutgoing.get(message.id);
            if (durable?.finalAck) {
              return { ...message, state: 'delivered' as const, delivered: true };
            }
            if (durable?.state === 'forwarded' && message.state !== 'delivered') {
              return { ...message, state: 'forwarded' as const };
            }
            if (
              durable?.state === 'pending' &&
              (message.state === 'created' || message.state === 'stored')
            ) {
              return { ...message, state: 'pending' as const };
            }
            if (
              (durable?.state === 'stored' || durable?.state === 'received') &&
              message.state === 'created'
            ) {
              return { ...message, state: 'stored' as const };
            }
            return message;
          });
        }
        messagesRef.current = reconciledMessages;
        setMessagesByConversation(reconciledMessages);
        knownPeersRef.current = safeKnownPeers;
        setKnownPeers(safeKnownPeers);
        const effectiveMeshEnabled =
          meshLifecycleIntentRef.current === 'start'
            ? true
            : meshLifecycleIntentRef.current === 'stop'
              ? false
              : storedMeshEnabled;
        meshEnabledRef.current = effectiveMeshEnabled;
        setMeshEnabled(effectiveMeshEnabled);
        if (!effectiveMeshEnabled && Platform.OS === 'android') {
          try {
            BleMesh.stop();
          } catch {
            // Re-applying an explicit persisted pause is best effort.
          }
          setStatus('idle');
        }
        setStoreStats(await store.stats());
        diagnosticsBuffer.info('security', 'identity-loaded', { nodeId: identity.nodeId });
        hydratedRef.current = true;
        if (!cancelled) setHydrationWarnings(warnings);
        setHydrated(true);
      } catch (error) {
        const failure: HydrationFailure = {
          stage,
          message: describeError(error),
          fatal: true,
        };
        diagnosticsBuffer.error('app', 'hydration-failed', {
          stage,
          error: failure.message,
        });
        if (!cancelled) {
          setHydrationWarnings(warnings);
          setHydrationFailure(failure);
          setStatus('init-error');
        }
      }
    })();
    hydrationInFlightRef.current = run;
    void run
      .finally(() => {
        if (hydrationInFlightRef.current === run) hydrationInFlightRef.current = null;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [diagnosticsBuffer]);

  const pushDemoEvent = useCallback((event: DemoEvent) => {
    setDemoEvents((previous) => [...previous, event].slice(-DEMO_EVENT_LIMIT));
  }, []);

  const ensureDirectConversation = useCallback(
    (peerNodeId: string) => {
      const id = directConversationId(peerNodeId);
      if (conversationsRef.current[id]) return;
      replaceConversations({
        ...conversationsRef.current,
        [id]: { id, kind: 'direct', peerNodeId, unreadCount: 0 },
      });
    },
    [replaceConversations],
  );

  const upsertGroupConversation = useCallback(
    (
      groupId: string,
      groupName: string,
      memberIds: string[],
      ownerNodeId: string,
      revision: number,
    ) => {
      const id = groupConversationId(groupId);
      const previous = conversationsRef.current[id];
      replaceConversations({
        ...conversationsRef.current,
        [id]: {
          id,
          kind: 'group',
          groupId,
          groupName,
          memberIds: Array.from(new Set(memberIds)),
          ownerNodeId,
          revision,
          unreadCount: previous?.unreadCount ?? 0,
        },
      });
    },
    [replaceConversations],
  );

  const appendMessage = useCallback(
    (
      conversationId: string,
      message: ChatMessage,
      options: { incoming: boolean; directPeerNodeId?: string },
    ) => {
      const current = messagesRef.current[conversationId] ?? [];
      if (current.some((candidate) => candidate.id === message.id)) return;
      const nextList = [...current, message].sort(compareForDisplay).slice(-300);
      replaceMessages({ ...messagesRef.current, [conversationId]: nextList });

      // A store-and-forward message can arrive with a display time older than
      // everything retained, and in a conversation already at the 300 cap the
      // trim then drops the very message we were just handed. Counting it as
      // unread would put a badge on a chat with nothing new in it.
      const retained = nextList.some((candidate) => candidate.id === message.id);
      if (!retained) {
        diagnosticsBuffer.warn('store', 'message-trimmed-on-arrival', {
          conversationId,
          createdAt: message.createdAt,
          storedAt: message.storedAt,
        });
      }

      if (options.directPeerNodeId) ensureDirectConversation(options.directPeerNodeId);
      if (retained && options.incoming && activeConversationIdRef.current !== conversationId) {
        const conversation = conversationsRef.current[conversationId];
        if (conversation) {
          replaceConversations({
            ...conversationsRef.current,
            [conversationId]: {
              ...conversation,
              unreadCount: conversation.unreadCount + 1,
            },
          });
        }
      }
    },
    [diagnosticsBuffer, ensureDirectConversation, replaceConversations, replaceMessages],
  );

  const updateDisplayedMessage = useCallback(
    (
      messageId: string,
      update: Partial<Pick<ChatMessage, 'state' | 'sentAt' | 'delivered'>>,
    ) => {
      let changed = false;
      const next: Record<string, ChatMessage[]> = {};
      for (const [conversationId, list] of Object.entries(messagesRef.current)) {
        next[conversationId] = list.map((message) => {
          if (message.id !== messageId) return message;
          changed = true;
          const patch = { ...update };
          // Delivery progress only ever moves forward. The flush path stamps
          // 'pending' before and after every send attempt, and an entry is
          // re-offered every 45 s for as long as it lives — so without this
          // guard a message that was already delivered visibly falls back to a
          // single tick, over and over. Duplicate custody receipts caused the
          // same regression from 'delivered' to 'forwarded'.
          if (patch.state !== undefined && rankMessageState(patch.state) < rankMessageState(message.state)) {
            delete patch.state;
          }
          return { ...message, ...patch };
        });
      }
      if (changed) replaceMessages(next);
    },
    [replaceMessages],
  );

  /**
   * Android rotates BLE addresses, so one phone can authenticate under several
   * of them at once. Every extra link runs its own MTU negotiation, handshake
   * and capability exchange over the same radio, which is what collapsed the
   * negotiated MTU to the 23-byte floor and left the two directions using
   * different links. Keep the newest binding and hang up the rest.
   */
  const registerAuthenticatedPeer = useCallback(
    (
      identity: PublicIdentity,
      profile: { nickname: string; color: string; capabilities?: NodeCapabilities },
      options: { address?: string; direct: boolean },
    ): boolean => {
      if (!verifyPublicIdentity(identity) || identity.nodeId === nodeIdRef.current) return false;
      const previous = knownPeersRef.current[identity.nodeId];
      if (previous?.identity && !samePublicIdentity(previous.identity, identity)) {
        diagnosticsBuffer.error('security', 'identity-continuity-rejected', {
          nodeId: identity.nodeId,
        });
        return false;
      }
      const peer: KnownPeer = {
        nodeId: identity.nodeId,
        nickname: profile.nickname.slice(0, 64),
        color: isValidPaletteColor(profile.color)
          ? profile.color
          : defaultColorForNodeId(identity.nodeId),
        lastSeenTs: Date.now(),
        identity,
        capabilities: profile.capabilities ?? previous?.capabilities,
        trust: options.direct ? 'verified' : previous?.trust ?? 'key-observed',
      };
      replaceKnownPeers({ ...knownPeersRef.current, [peer.nodeId]: peer });

      if (options.direct && options.address) {
        addressToNodeIdRef.current.set(options.address, identity.nodeId);
        const existing = peersRef.current[options.address];
        const sentAt = handshakeSentAtRef.current.get(options.address);
        handshakeSentAtRef.current.delete(options.address);
        const rtt = sentAt !== undefined ? Math.max(1, Date.now() - sentAt) : undefined;
        const nextPeer: PeerInfo = {
          ...(existing ?? {
            address: options.address,
            rssi: UNKNOWN_RSSI,
            rssiKnown: false,
            connected: true,
            lastSeen: Date.now(),
          }),
          nodeId: identity.nodeId,
          nickname: peer.nickname,
          connected: existing?.connected ?? true,
          lastSeen: Date.now(),
          transport: existing?.transport ?? 'ble',
          handshakeRttMs: rtt ?? existing?.handshakeRttMs,
          establishedAt: existing?.establishedAt ?? Date.now(),
        };
        const nextPeers = { ...peersRef.current, [options.address]: nextPeer };
        peersRef.current = nextPeers;
        setPeers(nextPeers);
      }
      return true;
    },
    [diagnosticsBuffer, replaceKnownPeers],
  );

  const sendRawToEndpoint = useCallback(
    async (address: string, encoded: string, messageId: string): Promise<boolean> => {
      const endpoint = peersRef.current[address];
      const transport = endpoint?.transport ?? 'ble';
      const wireBytes = encodedByteLength(encoded);
      const limit =
        transport === 'wifi-aware'
          ? wifiAwareStateRef.current.maxFrameBytes
          : BLE_BASELINE_ENVELOPE_BYTES;
      if (wireBytes > limit) {
        diagnosticsBuffer.warn('transport', 'envelope-too-large', {
          address,
          transport,
          messageId,
          wireBytes,
          limit,
        });
        return false;
      }
      try {
        const base64 = utf8ToBase64(encoded);
        const accepted =
          transport === 'wifi-aware'
            ? await BleMesh.sendToWifiAwarePeer(address, base64)
            : await BleMesh.sendToPeer(address, base64);
        diagnosticsBuffer.debug('transport', 'native-send-result', {
          address,
          transport,
          messageId,
          acceptedByNativeQueue: accepted,
        });
        return accepted;
      } catch (error) {
        diagnosticsBuffer.warn('transport', 'native-send-failed', {
          address,
          transport,
          messageId,
          error,
        });
        return false;
      }
    },
    [diagnosticsBuffer],
  );

  const sendWire = useCallback(
    async (address: string, envelope: RelayableEnvelope): Promise<boolean> => {
      if (!meshEnabledRef.current) return false;
      return sendRawToEndpoint(address, encodeEnvelope(envelope), envelope.messageId);
    },
    [sendRawToEndpoint],
  );

  const sendHandshakeFrame = useCallback(
    async (address: string, frame: BleHandshakeFrame): Promise<boolean> => {
      try {
        if (!meshEnabledRef.current) return false;
        const encoded = JSON.stringify(frame);
        const accepted = await sendRawToEndpoint(address, encoded, frame.challengeId);
        diagnosticsBuffer.debug('security', 'link-handshake-send-result', {
          address,
          transport: peersRef.current[address]?.transport ?? 'ble',
          kind: frame.kind,
          challengeId: frame.challengeId,
          acceptedByNativeQueue: accepted,
        });
        return accepted;
      } catch (error) {
        diagnosticsBuffer.warn('security', 'link-handshake-send-failed', {
          address,
          kind: frame.kind,
          error,
        });
        return false;
      }
    },
    [diagnosticsBuffer, sendRawToEndpoint],
  );

  const startHandshake = useCallback(
    async (address: string): Promise<void> => {
      if (!identityRef.current || !peersRef.current[address]?.connected) return;
      const now = Date.now();
      const pending = pendingHandshakeRef.current.get(address);
      if (pending && pending.expiresAt > now) return;
      const challenge: BleHandshakeChallenge = {
        wireType: 'anyway-ble-handshake-v1',
        kind: 'challenge',
        challengeId: generateMessageId(),
        nonce: generateMessageId(),
        expiresAt: now + BLE_HANDSHAKE_LIFETIME_MS,
      };
      pendingHandshakeRef.current.set(address, challenge);
      handshakeSentAtRef.current.set(address, Date.now());
      const accepted = await sendHandshakeFrame(address, challenge);
      if (!accepted && pendingHandshakeRef.current.get(address) === challenge) {
        pendingHandshakeRef.current.delete(address);
        handshakeSentAtRef.current.delete(address);
      }
    },
    [sendHandshakeFrame],
  );

  const handleHandshakeFrame = useCallback(
    async (fromAddress: string, frame: BleHandshakeFrame): Promise<void> => {
      const identity = identityRef.current;
      const now = Date.now();
      if (!identity || !peersRef.current[fromAddress]?.connected) return;

      if (frame.kind === 'challenge') {
        const lastResponseAt = handshakeResponseAtRef.current.get(fromAddress) ?? 0;
        if (now - lastResponseAt < 1_000) return;
        handshakeResponseAtRef.current.set(fromAddress, now);
        const unsigned: Omit<BleHandshakeResponse, 'signature'> = {
          wireType: 'anyway-ble-handshake-v1',
          kind: 'response',
          challengeId: frame.challengeId,
          nonce: frame.nonce,
          expiresAt: frame.expiresAt,
          responderIdentity: toPublicIdentity(identity),
        };
        await sendHandshakeFrame(fromAddress, {
          ...unsigned,
          signature: signValue(
            bleHandshakeResponseClaim(unsigned),
            identity.signingSecretKey,
          ),
        });
        void startHandshake(fromAddress);
        return;
      }

      const pending = pendingHandshakeRef.current.get(fromAddress);
      if (
        !pending ||
        pending.expiresAt <= now ||
        pending.challengeId !== frame.challengeId ||
        pending.nonce !== frame.nonce ||
        pending.expiresAt !== frame.expiresAt
      ) {
        diagnosticsBuffer.warn('security', 'ble-handshake-unmatched-response', {
          fromAddress,
          challengeId: frame.challengeId,
        });
        return;
      }
      if (
        !verifyPublicIdentity(frame.responderIdentity) ||
        !verifyValue(
          bleHandshakeResponseClaim(frame),
          frame.signature,
          frame.responderIdentity.signingPublicKey,
        )
      ) {
        diagnosticsBuffer.warn('security', 'ble-handshake-signature-rejected', {
          fromAddress,
        });
        return;
      }
      const known = knownPeersRef.current[frame.responderIdentity.nodeId];
      const alreadyMapped = addressToNodeIdRef.current.get(fromAddress);
      if (alreadyMapped && alreadyMapped !== frame.responderIdentity.nodeId) {
        diagnosticsBuffer.error('security', 'ble-address-rebinding-rejected', {
          fromAddress,
          alreadyMapped,
          claimedNodeId: frame.responderIdentity.nodeId,
        });
        return;
      }
      if (known?.identity && !samePublicIdentity(known.identity, frame.responderIdentity)) {
        diagnosticsBuffer.error('security', 'ble-handshake-key-continuity-rejected', {
          fromAddress,
          nodeId: frame.responderIdentity.nodeId,
        });
        return;
      }
      const registered = registerAuthenticatedPeer(
        frame.responderIdentity,
        {
          nickname:
            known?.nickname ?? `Usuario ${frame.responderIdentity.nodeId.slice(-5)}`,
          color: known?.color ?? defaultColorForNodeId(frame.responderIdentity.nodeId),
          capabilities: known?.capabilities,
        },
        { address: fromAddress, direct: true },
      );
      if (!registered) return;
      pendingHandshakeRef.current.delete(fromAddress);
      diagnosticsBuffer.info('security', 'ble-address-binding-verified', {
        fromAddress,
        nodeId: frame.responderIdentity.nodeId,
      });
      void broadcastCapabilityRef.current();
    },
    [diagnosticsBuffer, registerAuthenticatedPeer, sendHandshakeFrame, startHandshake],
  );

  /**
   * Picks which radio actually carries traffic to one peer. This is the whole
   * hybrid decision, and it lives here because sending is already keyed by
   * nodeId — a peer reachable over BLE and Wi-Fi at once must still receive each
   * message once, not once per radio.
   *
   * Selection is sticky: switching transports costs a link setup and reorders
   * in-flight traffic, so a challenger has to beat the incumbent by
   * ENDPOINT_SWITCH_MARGIN before it takes over.
   */
  const connectedAddressForNode = useCallback(
    (peerNodeId: string, priority: MessagePriority = 'normal'): string | null => {
      const now = Date.now();
      const endpoints = Object.values(peersRef.current).filter(
        (candidate) => candidate.connected && candidate.nodeId === peerNodeId,
      );
      if (endpoints.length === 0) {
        activeEndpointRef.current.delete(peerNodeId);
        return null;
      }
      if (endpoints.length === 1) {
        activeEndpointRef.current.set(peerNodeId, endpoints[0].address);
        return endpoints[0].address;
      }

      const links = buildRoutingLinksRef.current();
      const scoreFor = (peer: PeerInfo): number => {
        const transport = peer.transport ?? 'ble';
        // Match this endpoint's own link, so each address is scored with the
        // MTU, RSSI and error count actually measured on it.
        const linkId = `${transport}:${nodeIdRef.current}:${peerNodeId}:${peer.address}`;
        const link =
          links.find((candidate) => candidate.id === linkId) ??
          links.find(
            (candidate) =>
              candidate.to === peerNodeId && candidate.transportKind === transport,
          );
        if (!link) return 0;
        const conserving =
          priority === 'sos' || wifiAwareStateRef.current.powerSaveMode;
        return scoreLink(
          link,
          {
            priority,
            sizeBytes: 0,
            prefersLowEnergy: conserving,
            prefersLowLatency: !conserving,
            prefersHighThroughput: priority === 'normal' && !conserving,
          },
          now,
        ).total;
      };

      let best = endpoints[0];
      let bestScore = scoreFor(best);
      for (const candidate of endpoints.slice(1)) {
        const score = scoreFor(candidate);
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }

      const incumbentAddress = activeEndpointRef.current.get(peerNodeId);
      const incumbent = endpoints.find((peer) => peer.address === incumbentAddress);
      if (incumbent && incumbent.address !== best.address) {
        const incumbentScore = scoreFor(incumbent);
        if (bestScore - incumbentScore < ENDPOINT_SWITCH_MARGIN) return incumbent.address;
        diagnosticsBuffer.info('routing', 'endpoint-switched', {
          nodeId: peerNodeId,
          from: incumbent.transport ?? 'ble',
          to: best.transport ?? 'ble',
          gain: Number((bestScore - incumbentScore).toFixed(3)),
        });
      }
      activeEndpointRef.current.set(peerNodeId, best.address);
      return best.address;
    },
    [diagnosticsBuffer],
  );

  const buildRoutingLinks = useCallback((): Link[] => {
    const localId = nodeIdRef.current;
    if (!localId) return [];
    const now = Date.now();
    const result: Link[] = [];
    const seen = new Set<string>();

    for (const peer of Object.values(peersRef.current)) {
      if (!peer.connected || !peer.nodeId) continue;
      const snapshot = nativeLinkSnapshotsRef.current.find(
        (candidate) =>
          (peer.transport ?? 'ble') === 'ble' && candidate.address === peer.address,
      );
      const transport: PeerTransport = peer.transport ?? 'ble';
      // Keyed by endpoint, not just by peer: Android hands the same phone out
      // under more than one address, and collapsing those into one link made
      // every endpoint score identically — so the hysteresis below could never
      // fire and selection fell back to object-key order, scoring one endpoint
      // with another's measured MTU.
      const id = `${transport}:${localId}:${peer.nodeId}:${peer.address}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const mtu = snapshot?.mtu;
      const failures = snapshot?.failureCount ?? 0;
      result.push({
        id,
        from: localId,
        to: peer.nodeId,
        transportId: transport,
        transportKind: transport,
        direction: 'duplex',
        state: snapshot && snapshot.state !== 'ready' ? 'degraded' : 'active',
        mtuBytes: mtu,
        metrics: {
          rssiDbm:
            peer.rssiKnown && peer.rssi !== null
              ? {
                  value: peer.rssi,
                  provenance: 'measured',
                  observedAt: peer.lastSeen,
                  sampleCount: 1,
                }
              : { provenance: 'unknown' },
          // The scorer weights eight dimensions but only ever received RSSI, so
          // every other axis fell back to its unknown default — including the
          // three that actually separate one radio from another. None of these
          // need new instrumentation; they were already being observed and
          // thrown away.
          latencyMs:
            peer.handshakeRttMs !== undefined
              ? {
                  value: peer.handshakeRttMs,
                  provenance: 'measured',
                  observedAt: peer.lastSeen,
                  sampleCount: 1,
                }
              : { provenance: 'unknown' },
          throughputBytesPerSecond:
            transport === 'wifi-aware' || mtu !== undefined
              ? {
                  value: estimateThroughput(transport, mtu ?? 23),
                  provenance: 'estimated',
                  observedAt: peer.lastSeen,
                }
              : { provenance: 'unknown' },
          energyCost: {
            value: TRANSPORT_ENERGY_COST[transport],
            provenance: 'estimated',
            observedAt: now,
          },
          successRatio: {
            value: 1 / (1 + failures),
            provenance: failures > 0 ? 'measured' : 'estimated',
            observedAt: peer.lastSeen,
          },
          stabilityRatio: {
            value: linkStability(peer.establishedAt, now),
            provenance: 'estimated',
            observedAt: peer.lastSeen,
          },
          counters: snapshot ? { errors: failures } : {},
        },
        connectedAt: peer.establishedAt,
        lastStateChangeAt: peer.establishedAt ?? peer.lastSeen,
        lastActivityAt: peer.lastSeen,
      });
    }

    for (const [from, info] of Object.entries(topologyRef.current)) {
      if (now - info.lastAnnounceTs >= TOPOLOGY_EXPIRY_MS) continue;
      for (const neighbor of info.neighbors) {
        if (from === localId || neighbor.nodeId === localId || from === neighbor.nodeId) continue;
        for (const transport of neighbor.transports) {
          const id = `advertised:${from}:${neighbor.nodeId}:${transport}`;
          if (seen.has(id)) continue;
          seen.add(id);
          result.push({
            id,
            from,
            to: neighbor.nodeId,
            transportId: transport,
            transportKind: transport,
            direction: 'from-to-only',
            // A signed, fresh advertisement is useful route evidence, but it
            // is not a locally measured active link.
            state: 'degraded',
            metrics: { counters: {} },
            lastStateChangeAt: info.lastAnnounceTs,
            lastActivityAt: info.lastAnnounceTs,
          });
        }
      }
    }
    return result;
  }, []);
  buildRoutingLinksRef.current = buildRoutingLinks;

  const selectNextHops = useCallback(
    (envelope: RelayableEnvelope): Set<string> => {
      const localId = nodeIdRef.current;
      if (!localId) return new Set<string>();
      const connectedIds = new Set(
        Object.values(peersRef.current)
          .filter((peer) => peer.connected && peer.nodeId)
          .map((peer) => peer.nodeId as string),
      );
      if (envelope.destination.kind !== 'direct') return connectedIds;

      const excluded = new Set(envelope.relay.path.filter((node) => node !== localId));
      const allLinks = buildRoutingLinks().filter(
        (link) =>
          !excluded.has(link.to) &&
          (link.from === localId || !excluded.has(link.from)),
      );
      const profile = {
        priority: envelope.priority,
        sizeBytes: encodedByteLength(encodeEnvelope(envelope)),
        prefersLowLatency:
          envelope.priority !== 'sos' && !wifiAwareStateRef.current.powerSaveMode,
        prefersHighThroughput:
          envelope.priority === 'normal' && !wifiAwareStateRef.current.powerSaveMode,
        prefersLowEnergy:
          envelope.priority === 'sos' || wifiAwareStateRef.current.powerSaveMode,
      };
      const selection = selectRoutes(
        localId,
        envelope.destination.nodeId,
        allLinks,
        profile,
        {
          maxHops: Math.max(1, envelope.relay.hopLimit - envelope.relay.hopCount),
          maxCandidates: 12,
          maxSosPaths: 3,
        },
      );
      const selected = new Set<string>();
      for (const route of selection.selected) {
        const firstHop = route.hops[0]?.to;
        if (firstHop && connectedIds.has(firstHop)) selected.add(firstHop);
      }
      if (envelope.priority === 'important') {
        const failover = selection.alternatives.find((route) => {
          const firstHop = route.hops[0]?.to;
          return !!firstHop && connectedIds.has(firstHop) && !selected.has(firstHop);
        });
        const failoverHop = failover?.hops[0]?.to;
        if (failoverHop) selected.add(failoverHop);
      }
      if (selected.size > 0) {
        diagnosticsBuffer.info('routing', 'route-selected', {
          messageId: envelope.messageId,
          destination: envelope.destination.nodeId,
          priority: envelope.priority,
          nextHops: Array.from(selected),
          multipath: selected.size > 1,
        });
        return selected;
      }

      const localLinks = allLinks
        .filter((link) => link.from === localId && connectedIds.has(link.to))
        .map((link) => ({ link, score: scoreLink(link, profile).total }))
        .sort((left, right) => right.score - left.score);
      const fallbackLimit =
        envelope.priority === 'sos'
          ? localLinks.length
          : envelope.priority === 'important'
            ? 2
            : 1;
      const fallback = new Set(
        localLinks.slice(0, fallbackLimit).map((candidate) => candidate.link.to),
      );
      diagnosticsBuffer.info('routing', 'dtn-fallback-selected', {
        messageId: envelope.messageId,
        destination: envelope.destination.nodeId,
        priority: envelope.priority,
        nextHops: Array.from(fallback),
      });
      return fallback;
    },
    [buildRoutingLinks, diagnosticsBuffer],
  );

  /** How many envelopes this endpoint's fragment queue can actually accept. */
  const forwardBatchSizeFor = useCallback((address: string): number => {
    const snapshot = nativeLinkSnapshotsRef.current.find(
      (candidate) => candidate.address === address,
    );
    const mtu = snapshot?.mtu;
    // No BLE snapshot means a Wi-Fi Aware endpoint, which is stream-oriented
    // and has no per-peer fragment ceiling to respect.
    if (mtu === undefined) return FORWARD_BATCH_SIZE;
    const perFragment = Math.max(
      1,
      Math.min(mtu - 3, MAX_ATTRIBUTE_VALUE_BYTES) - FRAGMENT_HEADER_BYTES,
    );
    const fragmentsPerEnvelope = Math.max(
      1,
      Math.ceil(TYPICAL_ENVELOPE_BYTES / perFragment),
    );
    const fits = Math.floor(NATIVE_FRAGMENT_QUEUE / fragmentsPerEnvelope);
    return Math.max(MIN_FORWARD_BATCH_SIZE, Math.min(FORWARD_BATCH_SIZE, fits));
  }, []);

  const flushForPeer = useCallback(
    (peerNodeId: string): Promise<void> => {
      const previous = flushLocksRef.current.get(peerNodeId) ?? Promise.resolve();
      const run = previous
        .catch(() => undefined)
        .then(async () => {
          if (clearingMessagesRef.current) return;
          const store = storeRef.current;
          const primaryForBatch = connectedAddressForNode(peerNodeId);
          if (!store || !primaryForBatch) return;
          const candidates = await store.getForwardCandidates({
            peerId: peerNodeId,
            limit: forwardBatchSizeFor(primaryForBatch),
          });
          for (const candidate of candidates) {
            let claimSettled = false;
            try {
              if (clearingMessagesRef.current) continue;
              const identity = identityRef.current;
              const localId = nodeIdRef.current;
              if (!identity || !localId) continue;
              const localPublicIdentity = toPublicIdentity(identity);
              const custodyCopyVerified = verifyRelayChain(
                candidate.envelope,
                (candidateNodeId) =>
                  candidateNodeId === localId
                    ? localPublicIdentity
                    : knownPeersRef.current[candidateNodeId]?.identity,
              );
              if (!custodyCopyVerified) {
                diagnosticsBuffer.error('security', 'durable-relay-chain-rejected', {
                  messageId: candidate.envelope.messageId,
                });
                continue;
              }
              const selectedNextHops = selectNextHops(candidate.entry.envelope);
              if (!selectedNextHops.has(peerNodeId)) continue;
              const primaryAddress = connectedAddressForNode(
                peerNodeId,
                candidate.entry.envelope.priority,
              );
              if (!primaryAddress) continue;
              const wireEnvelope = advanceEnvelopeForRelay(
                candidate.envelope,
                localId,
                peerNodeId,
                identity,
              );
              if (!wireEnvelope) {
                diagnosticsBuffer.warn('security', 'relay-hop-signing-failed', {
                  messageId: candidate.envelope.messageId,
                  peerNodeId,
                });
                continue;
              }
              const display = wireToDisplayRef.current.get(candidate.envelope.messageId);
              if (display) {
                updateDisplayedMessage(display.displayId, { state: 'pending' });
              }
              const attemptedAt = Date.now();
              // SOS is redundant only over links which are already ready. It
              // does not wake the expensive Wi-Fi radio merely to duplicate a
              // frame, so the low-energy discovery policy remains intact.
              const endpointAddresses =
                candidate.entry.envelope.priority === 'sos'
                  ? [
                      primaryAddress,
                      ...Object.values(peersRef.current)
                        .filter(
                          (peer) =>
                            peer.connected &&
                            peer.nodeId === peerNodeId &&
                            peer.address !== primaryAddress,
                        )
                        .map((peer) => peer.address),
                    ]
                  : [primaryAddress];
              const attempts = await Promise.all(
                endpointAddresses.map(async (endpointAddress) => ({
                  endpointAddress,
                  accepted: await sendWire(endpointAddress, wireEnvelope),
                })),
              );
              const acceptedAttempt = attempts.find((attempt) => attempt.accepted);
              const accepted = acceptedAttempt !== undefined;
              const recordedAddress = acceptedAttempt?.endpointAddress ?? primaryAddress;
              const transportId =
                peersRef.current[recordedAddress]?.transport ?? 'ble';
              diagnosticsBuffer.info('routing', 'transport-attempts', {
                messageId: candidate.envelope.messageId,
                peerNodeId,
                attempts: attempts.map((attempt) => ({
                  transport:
                    peersRef.current[attempt.endpointAddress]?.transport ?? 'ble',
                  accepted: attempt.accepted,
                })),
              });
              claimSettled = await store.recordForwardAttempt(
                candidate.envelope.messageId,
                {
                  nextHopId: peerNodeId,
                  transportId,
                  attemptedAt,
                  accepted,
                  errorCode: accepted ? undefined : 'native-send-rejected',
                },
                accepted ? `${transportId}-native-queue:${attemptedAt}` : undefined,
                candidate.claimId,
              );
              if (!claimSettled) {
                // The send happened but its durable claim was gone, so the
                // outcome was thrown away: no attempt recorded, no backoff, no
                // breaker count, and the same envelope re-selected next sweep.
                // This used to be completely silent.
                diagnosticsBuffer.warn('store', 'forward-claim-expired', {
                  messageId: candidate.envelope.messageId,
                  peerNodeId,
                  accepted,
                });
              }
              if (accepted && display) {
                updateDisplayedMessage(display.displayId, {
                  // Native queue admission is not remote custody. Only a
                  // verified accepted-by-relay receipt advances to forwarded.
                  state: 'pending',
                  sentAt: attemptedAt,
                });
              }
            } catch (error) {
              diagnosticsBuffer.warn('routing', 'forward-candidate-failed', {
                messageId: candidate.envelope.messageId,
                peerNodeId,
                error,
              });
            } finally {
              if (!claimSettled) {
                await store.releaseForwardClaim(candidate.claimId).catch((error) =>
                  diagnosticsBuffer.warn('store', 'forward-claim-release-failed', {
                    messageId: candidate.envelope.messageId,
                    peerNodeId,
                    error,
                  }),
                );
              }
            }
          }
          await refreshStoreStats();
        })
        .catch((error) => {
          diagnosticsBuffer.warn('routing', 'peer-flush-failed', {
            peerNodeId,
            error,
          });
        })
        .finally(() => {
          if (flushLocksRef.current.get(peerNodeId) === run) {
            flushLocksRef.current.delete(peerNodeId);
          }
        });
      flushLocksRef.current.set(peerNodeId, run);
      return run;
    },
    [
      connectedAddressForNode,
      diagnosticsBuffer,
      refreshStoreStats,
      selectNextHops,
      sendWire,
      updateDisplayedMessage,
    ],
  );

  const flushAllConnected = useCallback(async () => {
    const ids = new Set<string>();
    for (const peer of Object.values(peersRef.current)) {
      if (peer.connected && peer.nodeId) ids.add(peer.nodeId);
    }
    await Promise.all(Array.from(ids, (id) => flushForPeer(id)));
  }, [flushForPeer]);

  const createBaseEnvelope = useCallback(
    (destination: MeshTarget, priority: MessagePriority, lifetimeMs: number) => {
      const identity = identityRef.current;
      if (!identity) throw new Error('Identity is not ready.');
      const createdAt = Date.now();
      return {
        protocolVersion: CORE_PROTOCOL_VERSION,
        messageId: generateMessageId(),
        originId: identity.nodeId,
        destination,
        priority,
        createdAt,
        expiresAt: createdAt + lifetimeMs,
        relay: {
          relayable: true as const,
          hopLimit: ttlRef.current,
          hopCount: 0,
          path: [identity.nodeId],
          attestations: [],
        },
      };
    },
    [],
  );

  const persistOriginated = useCallback(
    async (envelope: RelayableEnvelope): Promise<boolean> => {
      const store = storeRef.current;
      const identity = identityRef.current;
      if (!store || !identity) return false;
      const sizeProbeNextHop =
        envelope.destination.kind === 'direct'
          ? envelope.destination.nodeId
          : 'aw-00000000000000000000000000000000';
      const firstHopProbe = advanceEnvelopeForRelay(
        envelope,
        identity.nodeId,
        sizeProbeNextHop,
        identity,
      );
      const wireBytes = firstHopProbe
        ? encodedByteLength(encodeEnvelope(firstHopProbe))
        : Number.POSITIVE_INFINITY;
      if (wireBytes > BLE_BASELINE_ENVELOPE_BYTES) {
        diagnosticsBuffer.warn('protocol', 'origin-envelope-exceeds-ble-baseline', {
          messageId: envelope.messageId,
          wireBytes,
          limit: BLE_BASELINE_ENVELOPE_BYTES,
        });
        return false;
      }
      try {
        const result = await store.storeEnvelope(envelope, {
          originatedLocally: true,
          isFinalRecipient: envelope.destination.kind === 'broadcast',
        });
        diagnosticsBuffer.info('store', 'origin-persisted', {
          messageId: envelope.messageId,
          kind: envelope.kind,
          status: result.status,
        });
        await refreshStoreStats();
        return result.status === 'stored';
      } catch (error) {
        diagnosticsBuffer.error('store', 'origin-persist-failed', {
          messageId: envelope.messageId,
          error,
        });
        return false;
      }
    },
    [diagnosticsBuffer, refreshStoreStats],
  );

  const persistOriginatedBatch = useCallback(
    async (envelopes: RelayableEnvelope[]): Promise<boolean> => {
      const store = storeRef.current;
      const identity = identityRef.current;
      if (!store || !identity || envelopes.length === 0) return false;
      for (const envelope of envelopes) {
        const sizeProbeNextHop =
          envelope.destination.kind === 'direct'
            ? envelope.destination.nodeId
            : 'aw-00000000000000000000000000000000';
        const firstHopProbe = advanceEnvelopeForRelay(
          envelope,
          identity.nodeId,
          sizeProbeNextHop,
          identity,
        );
        const wireBytes = firstHopProbe
          ? encodedByteLength(encodeEnvelope(firstHopProbe))
          : Number.POSITIVE_INFINITY;
        if (wireBytes > BLE_BASELINE_ENVELOPE_BYTES) {
          diagnosticsBuffer.warn('protocol', 'origin-envelope-exceeds-ble-baseline', {
            messageId: envelope.messageId,
            wireBytes,
            limit: BLE_BASELINE_ENVELOPE_BYTES,
          });
          return false;
        }
      }
      try {
        const result = await store.storeEnvelopesAtomically(
          envelopes.map((envelope) => ({
            envelope,
            context: {
              originatedLocally: true,
              isFinalRecipient: envelope.destination.kind === 'broadcast',
            },
          })),
        );
        diagnosticsBuffer.info('store', 'origin-batch-persisted', {
          messageIds: envelopes.map((envelope) => envelope.messageId),
          status: result.status,
        });
        await refreshStoreStats();
        return result.status === 'committed';
      } catch (error) {
        diagnosticsBuffer.error('store', 'origin-batch-persist-failed', {
          messageIds: envelopes.map((envelope) => envelope.messageId),
          error,
        });
        return false;
      }
    },
    [diagnosticsBuffer, refreshStoreStats],
  );

  const createContentEnvelope = useCallback(
    (
      destination: MeshTarget,
      priority: MessagePriority,
      payload: ContentEnvelope['payload'],
      messageId?: string,
    ): ContentEnvelope => {
      const identity = identityRef.current;
      if (!identity) throw new Error('Identity is not ready.');
      const base = createBaseEnvelope(destination, priority, retentionFor(priority));
      const unsigned = {
        ...base,
        messageId: messageId ?? base.messageId,
        kind: 'content' as const,
        payload,
      };
      return signEnvelope<ContentEnvelope>(unsigned, identity);
    },
    [createBaseEnvelope],
  );

  const issueFinalReceipt = useCallback(
    async (original: ContentEnvelope) => {
      const identity = identityRef.current;
      if (!identity || original.destination.kind !== 'direct') return;
      const cooldownKey = `final:${original.messageId}:${original.originId}`;
      const now = Date.now();
      if ((receiptCooldownRef.current.get(cooldownKey) ?? 0) > now) {
        await flushAllConnected();
        return;
      }
      receiptCooldownRef.current.set(cooldownKey, now + RECEIPT_REISSUE_COOLDOWN_MS);
      const base = createBaseEnvelope(
        { kind: 'direct', nodeId: original.originId },
        original.priority,
        RECEIPT_LIFETIME_MS,
      );
      const receipt = signEnvelope<ReceiptEnvelope>(
        {
          ...base,
          kind: 'receipt',
          payload: {
            receiptFor: original.messageId,
            receiptForFingerprint: immutableEnvelopeFingerprint(original),
            status: 'delivered-to-destination',
            reportingNodeId: identity.nodeId,
            observedAt: Date.now(),
          },
        },
        identity,
      );
      if (await persistOriginated(receipt)) await flushAllConnected();
      else receiptCooldownRef.current.delete(cooldownKey);
    },
    [createBaseEnvelope, flushAllConnected, persistOriginated],
  );

  const issueCustodyReceipt = useCallback(
    async (original: ContentEnvelope, previousHop: string) => {
      const identity = identityRef.current;
      if (!identity || previousHop === identity.nodeId) return;
      const cooldownKey = `custody:${original.messageId}:${previousHop}`;
      const now = Date.now();
      if ((receiptCooldownRef.current.get(cooldownKey) ?? 0) > now) {
        await flushAllConnected();
        return;
      }
      receiptCooldownRef.current.set(cooldownKey, now + RECEIPT_REISSUE_COOLDOWN_MS);
      const base = createBaseEnvelope(
        { kind: 'direct', nodeId: previousHop },
        original.priority,
        RECEIPT_LIFETIME_MS,
      );
      const receipt = signEnvelope<ReceiptEnvelope>(
        {
          ...base,
          kind: 'receipt',
          payload: {
            receiptFor: original.messageId,
            receiptForFingerprint: immutableEnvelopeFingerprint(original),
            status: 'accepted-by-relay',
            reportingNodeId: identity.nodeId,
            observedAt: Date.now(),
          },
        },
        identity,
      );
      if (await persistOriginated(receipt)) await flushAllConnected();
      else receiptCooldownRef.current.delete(cooldownKey);
    },
    [createBaseEnvelope, flushAllConnected, persistOriginated],
  );

  const createChatMessage = useCallback(
    (options: {
      envelope: ContentEnvelope;
      displayId?: string;
      target: MeshTarget;
      text?: string;
      location?: GeoLocation;
      incoming: boolean;
      encrypted: boolean;
      wireMessageIds?: string[];
    }): ChatMessage => {
      const peer = knownPeersRef.current[options.envelope.originId];
      const now = Date.now();
      return {
        id: options.displayId ?? options.envelope.messageId,
        senderId: options.envelope.originId,
        senderName:
          options.envelope.originId === nodeIdRef.current
            ? nicknameRef.current ?? 'Vos'
            : peer?.nickname ?? `Usuario ${options.envelope.originId.slice(-5)}`,
        senderColor:
          options.envelope.originId === nodeIdRef.current
            ? colorRef.current
            : peer?.color ?? defaultColorForNodeId(options.envelope.originId),
        ts: options.envelope.createdAt,
        createdAt: options.envelope.createdAt,
        storedAt: now,
        receivedAt: options.incoming ? now : undefined,
        to: options.target,
        text: options.text ?? '',
        hops: uiHopCount(options.envelope.relay.hopCount),
        networkHops: options.envelope.relay.hopCount,
        path: options.envelope.relay.path,
        priority: options.envelope.priority,
        state: options.incoming ? 'received' : 'created',
        location: options.location,
        encrypted: options.encrypted,
        wireMessageIds: options.wireMessageIds,
      };
    },
    [],
  );

  const processPrivatePayload = useCallback(
    async (
      envelope: ContentEnvelope,
      payload: PrivateApplicationPayload,
    ): Promise<boolean> => {
      const localId = nodeIdRef.current;
      if (!localId) return false;
      if (payload.kind === 'group-invite') {
        if (
          envelope.originId !== payload.ownerNodeId ||
          !payload.memberIds.includes(payload.ownerNodeId) ||
          !payload.memberIds.includes(localId) ||
          new Set(payload.memberIds).size !== payload.memberIds.length
        ) {
          return false;
        }
        const memberProfiles = new Map(payload.members.map((member) => [member.nodeId, member]));
        if (
          memberProfiles.size !== payload.memberIds.length ||
          payload.memberIds.some((memberId) => !memberProfiles.has(memberId))
        ) {
          return false;
        }
        for (const memberId of payload.memberIds) {
          const member = memberProfiles.get(memberId);
          if (
            !member ||
            member.identity.nodeId !== member.nodeId ||
            !verifyPublicIdentity(member.identity)
          ) {
            return false;
          }
          const known = knownPeersRef.current[memberId]?.identity;
          if (known && !samePublicIdentity(known, member.identity)) return false;
        }
        const conversationId = groupConversationId(payload.groupId);
        const existing = conversationsRef.current[conversationId];
        if (existing) {
          if (
            existing.kind !== 'group' ||
            existing.ownerNodeId !== payload.ownerNodeId ||
            payload.revision < (existing.revision ?? 0)
          ) {
            return false;
          }
          if (payload.revision === existing.revision) {
            const previousMembers = new Set(existing.memberIds ?? []);
            const isExactReplay =
              existing.groupName === payload.groupName &&
              previousMembers.size === payload.memberIds.length &&
              payload.memberIds.every((memberId) => previousMembers.has(memberId));
            if (!isExactReplay) return false;
            try {
              await enqueuePersistence(() =>
                setStoredConversations(conversationsRef.current),
              );
              return true;
            } catch {
              return false;
            }
          }
        }
        for (const member of payload.members) {
          if (
            !member ||
            typeof member.nodeId !== 'string' ||
            typeof member.nickname !== 'string' ||
            typeof member.color !== 'string' ||
            !member.identity ||
            member.identity.nodeId !== member.nodeId ||
            member.nodeId === localId
          ) {
            continue;
          }
          registerAuthenticatedPeer(
            member.identity,
            { nickname: member.nickname, color: member.color },
            { direct: false },
          );
        }
        upsertGroupConversation(
          payload.groupId,
          payload.groupName,
          payload.memberIds,
          payload.ownerNodeId,
          payload.revision,
        );
        try {
          await enqueuePersistence(() =>
            setStoredConversations(conversationsRef.current),
          );
          return true;
        } catch {
          return false;
        }
      }

      const isGroup = payload.kind === 'group-text' || payload.kind === 'group-emergency';
      const target: MeshTarget = isGroup
        ? { kind: 'group', groupId: payload.groupId }
        : { kind: 'direct', nodeId: localId };
      const conversationId = isGroup
        ? groupConversationId(payload.groupId)
        : directConversationId(envelope.originId);
      if (isGroup) {
        const conversation = conversationsRef.current[conversationId];
        if (
          !conversation?.ownerNodeId ||
          !conversation.revision ||
          !conversation.memberIds?.includes(localId) ||
          !conversation.memberIds.includes(envelope.originId)
        ) {
          return false;
        }
      }
      const text = payload.text;
      const location =
        payload.kind === 'emergency' || payload.kind === 'group-emergency'
          ? payload.location
          : undefined;
      appendMessage(
        conversationId,
        createChatMessage({
          envelope,
          target,
          text,
          location,
          incoming: true,
          encrypted: true,
        }),
        {
          incoming: true,
          directPeerNodeId: isGroup ? undefined : envelope.originId,
        },
      );
      try {
        await enqueuePersistence(() =>
          setStoredMessagesByConversation(messagesRef.current),
        );
        return true;
      } catch {
        return false;
      }
    },
    [
      appendMessage,
      createChatMessage,
      enqueuePersistence,
      registerAuthenticatedPeer,
      upsertGroupConversation,
    ],
  );

  const processContentAtDestination = useCallback(
    async (envelope: ContentEnvelope): Promise<boolean> => {
      if (envelope.payload.type === 'sealed') {
        const identity = identityRef.current;
        const originIdentity = knownPeersRef.current[envelope.originId]?.identity;
        if (!identity || !originIdentity) return false;
        const plaintext = openSealedPayload(envelope.payload, originIdentity, identity);
        if (!plaintext) {
          diagnosticsBuffer.warn('security', 'sealed-payload-open-failed', {
            messageId: envelope.messageId,
            originId: envelope.originId,
          });
          return false;
        }
        try {
          const parsed: unknown = JSON.parse(plaintext);
          if (!isPrivatePayload(parsed)) return false;
          return await processPrivatePayload(envelope, parsed);
        } catch (error) {
          diagnosticsBuffer.warn('protocol', 'private-payload-invalid-json', { error });
          return false;
        }
      }

      if (envelope.destination.kind !== 'broadcast') return false;
      let text = '';
      let location: GeoLocation | undefined;
      if (envelope.payload.type === 'text') {
        if (!isValidRequiredText(envelope.payload.text)) return false;
        text = envelope.payload.text;
      }
      if (envelope.payload.type === 'sos') {
        if (
          !isValidOptionalText(envelope.payload.text) ||
          (envelope.payload.location !== undefined &&
            !isGeoLocation(envelope.payload.location)) ||
          (envelope.payload.text === undefined && envelope.payload.location === undefined)
        ) {
          return false;
        }
        text = envelope.payload.text ?? '';
        location = envelope.payload.location;
      }
      if (envelope.payload.type === 'location') {
        if (
          !isGeoLocation(envelope.payload.location) ||
          !isValidOptionalText(envelope.payload.note)
        ) {
          return false;
        }
        text = envelope.payload.note ?? '';
        location = envelope.payload.location;
      }
      appendMessage(
        BROADCAST_CONVERSATION_ID,
        createChatMessage({
          envelope,
          target: { kind: 'broadcast' },
          text,
          location,
          incoming: true,
          encrypted: false,
        }),
        { incoming: true },
      );
      try {
        await enqueuePersistence(() =>
          setStoredMessagesByConversation(messagesRef.current),
        );
        return true;
      } catch {
        return false;
      }
    },
    [
      appendMessage,
      createChatMessage,
      diagnosticsBuffer,
      enqueuePersistence,
      processPrivatePayload,
    ],
  );

  const applyVerifiedReceipt = useCallback(
    async (receipt: ReceiptEnvelope) => {
      const store = storeRef.current;
      if (!store) return;
      const original = await store.findEntry(receipt.payload.receiptFor);
      if (
        !original ||
        original.immutableFingerprint !== receipt.payload.receiptForFingerprint
      ) {
        diagnosticsBuffer.warn('security', 'receipt-does-not-match-original', {
          receiptFor: receipt.payload.receiptFor,
          reportingNodeId: receipt.originId,
        });
        return;
      }
      if (original.envelope.kind !== 'content') return;

      if (receipt.payload.status === 'accepted-by-relay') {
        if (
          receipt.destination.kind !== 'direct' ||
          receipt.destination.nodeId !== nodeIdRef.current ||
          receipt.payload.reportingNodeId !== receipt.originId
        ) {
          return;
        }
        const wasAttemptedForReporter = original.attempts.some(
          (attempt) => attempt.nextHopId === receipt.originId && attempt.accepted,
        );
        if (!wasAttemptedForReporter) {
          diagnosticsBuffer.warn('security', 'custody-receipt-without-send-attempt', {
            receiptFor: receipt.payload.receiptFor,
            reportingNodeId: receipt.originId,
          });
          return;
        }
        if (original.envelope.originId === nodeIdRef.current) {
          const display = wireToDisplayRef.current.get(receipt.payload.receiptFor);
          if (display) {
            if (display.aggregate) {
              const visible = Object.values(messagesRef.current)
                .flat()
                .find((message) => message.id === display.displayId);
              const wireMessageIds = visible?.wireMessageIds;
              if (wireMessageIds?.length) {
                const latestById = await store.findEntries(wireMessageIds);
                if (
                  wireMessageIds.every((wireMessageId) => {
                    const entry = latestById.get(wireMessageId);
                    return (
                      !!entry &&
                      (entry.state === 'forwarded' ||
                        entry.state === 'delivered' ||
                        !!entry.finalAck)
                    );
                  })
                ) {
                  updateDisplayedMessage(display.displayId, { state: 'forwarded' });
                }
              }
            } else {
              updateDisplayedMessage(display.displayId, { state: 'forwarded' });
            }
          }
        }
        await refreshStoreStats();
        return;
      }

      if (
        receipt.destination.kind !== 'direct' ||
        receipt.destination.nodeId !== original.envelope.originId ||
        original.envelope.destination.kind !== 'direct' ||
        original.envelope.destination.nodeId !== receipt.originId ||
        receipt.payload.reportingNodeId !== receipt.originId
      ) {
        diagnosticsBuffer.warn('security', 'final-receipt-wrong-destination', {
          receiptFor: receipt.payload.receiptFor,
          reportingNodeId: receipt.originId,
        });
        return;
      }
      const recorded = await store.recordFinalAck(receipt.payload.receiptFor, {
        destinationNodeId: receipt.originId,
        messageFingerprint: receipt.payload.receiptForFingerprint,
        // Receipt signature proves the event; local receive time avoids making
        // store retention depend on another offline phone's wall clock.
        acknowledgedAt: Date.now(),
        receiptMessageId: receipt.messageId,
        verified: true,
      });
      if (recorded) {
        if (original.envelope.originId === nodeIdRef.current) {
          const display = wireToDisplayRef.current.get(receipt.payload.receiptFor);
          if (display?.aggregate) {
            const visible = Object.values(messagesRef.current)
              .flat()
              .find((message) => message.id === display.displayId);
            const wireMessageIds = visible?.wireMessageIds;
            if (wireMessageIds?.length) {
              const latestById = await store.findEntries(wireMessageIds);
              if (
                wireMessageIds.every(
                  (wireMessageId) => !!latestById.get(wireMessageId)?.finalAck,
                )
              ) {
                updateDisplayedMessage(display.displayId, {
                  state: 'delivered',
                  delivered: true,
                });
              }
            }
          } else {
            updateDisplayedMessage(display?.displayId ?? receipt.payload.receiptFor, {
              state: 'delivered',
              delivered: true,
            });
          }
        }
        await refreshStoreStats();
      }
    },
    [diagnosticsBuffer, refreshStoreStats, updateDisplayedMessage],
  );

  const handleCapability = useCallback(
    (envelope: CapabilityEnvelope, fromAddress: string, direct: boolean) => {
      if (!capabilityHasValidIdentity(envelope)) return false;
      const registered = registerAuthenticatedPeer(
        envelope.payload.identity,
        {
          nickname: envelope.payload.displayName,
          color: envelope.payload.color,
          capabilities: envelope.payload.capabilities,
        },
        { address: fromAddress, direct },
      );
      if (!registered) return false;
      const authenticatedPeer = knownPeersRef.current[envelope.originId];
      setTopology((previous) => {
        const existing = previous[envelope.originId];
        // Equal sequence is an exact/stale replay: it may re-bind a current
        // direct transport endpoint, but must not refresh old topology data.
        if (existing && existing.sequence >= envelope.payload.topologySequence) return previous;
        const next = {
          ...previous,
          [envelope.originId]: {
            nickname: authenticatedPeer?.nickname ?? envelope.payload.displayName,
            color:
              authenticatedPeer?.color ?? defaultColorForNodeId(envelope.originId),
            neighbors: envelope.payload.neighbors,
            hopsAway: uiHopCount(envelope.relay.hopCount),
            sequence: envelope.payload.topologySequence,
            lastAnnounceTs: Date.now(),
          },
        };
        topologyRef.current = next;
        return next;
      });
      return true;
    },
    [registerAuthenticatedPeer],
  );

  const handleIncomingWire = useCallback(
    async (
      fromAddress: string,
      base64Data: string,
      transport: PeerTransport = 'ble',
    ) => {
      // Hydration installs several mutually dependent snapshots (identity,
      // peers, groups, messages and DTN state). Network mutations wait for
      // that single boundary so a late hydration assignment cannot erase a
      // freshly authenticated peer or delivered message.
      await hydrationInFlightRef.current?.catch(() => undefined);
      const localId = nodeIdRef.current;
      const store = storeRef.current;
      if (!localId || !store) return;
      let wireText: string;
      try {
        wireText = base64ToUtf8(base64Data);
      } catch (error) {
        diagnosticsBuffer.warn('protocol', 'wire-base64-decode-threw', { error });
        return;
      }
      try {
        const control: unknown = JSON.parse(wireText);
        if (isBleHandshakeFrame(control)) {
          await handleHandshakeFrame(fromAddress, control);
          return;
        }
      } catch {
        // Core decoder below reports malformed application envelopes.
      }
      if (clearingMessagesRef.current) return;
      const decoded = decodeEnvelope(wireText);
      if (!decoded.ok) {
        diagnosticsBuffer.warn('protocol', 'wire-rejected', { errors: decoded.errors });
        return;
      }

      const envelope = decoded.value;
      if (envelope.kind === 'capability') {
        const previousIdentity = knownPeersRef.current[envelope.originId]?.identity;
        if (
          previousIdentity &&
          !samePublicIdentity(previousIdentity, envelope.payload.identity)
        ) {
          diagnosticsBuffer.error('security', 'capability-key-continuity-rejected', {
            originId: envelope.originId,
          });
          return;
        }
      }
      const relayChainVerified = verifyRelayChain(
        envelope,
        (candidateNodeId) => knownPeersRef.current[candidateNodeId]?.identity,
      );
      if (!relayChainVerified) {
        diagnosticsBuffer.warn('security', 'relay-chain-rejected', {
          messageId: envelope.messageId,
          originId: envelope.originId,
        });
        return;
      }

      const embeddedOrigin = originIdentityFromRelayChain(envelope);
      const knownOrigin = knownPeersRef.current[envelope.originId];
      if (!embeddedOrigin) {
        // Compact receipt relay attestations carry the signing certificate
        // needed by verifyRelayChain, but intentionally omit the box key.
        // Receipts never need that key; content and capability records do.
        if (envelope.kind !== 'receipt') return;
      } else {
        if (embeddedOrigin.nodeId !== envelope.originId) return;
        if (
          knownOrigin?.identity &&
          !samePublicIdentity(knownOrigin.identity, embeddedOrigin)
        ) {
          diagnosticsBuffer.error('security', 'message-origin-key-continuity-rejected', {
            originId: envelope.originId,
            messageId: envelope.messageId,
          });
          return;
        }
        if (envelope.originId !== localId && !knownOrigin?.identity) {
          registerAuthenticatedPeer(
            embeddedOrigin,
            {
              nickname:
                envelope.kind === 'capability'
                  ? envelope.payload.displayName
                  : `Usuario ${envelope.originId.slice(-5)}`,
              color:
                envelope.kind === 'capability'
                  ? envelope.payload.color
                  : defaultColorForNodeId(envelope.originId),
              capabilities:
                envelope.kind === 'capability' ? envelope.payload.capabilities : undefined,
            },
            { direct: false },
          );
        }
      }

      const arrivedPath = envelope.relay.path;
      if (arrivedPath[arrivedPath.length - 1] !== localId || arrivedPath.length < 2) {
        diagnosticsBuffer.warn('protocol', 'inbound-path-not-local', {
          messageId: envelope.messageId,
          path: arrivedPath,
        });
        return;
      }
      const previousHop = arrivedPath[arrivedPath.length - 2];
      const mappedNode = addressToNodeIdRef.current.get(fromAddress);
      if (mappedNode !== previousHop) {
        diagnosticsBuffer.warn('security', 'transport-node-binding-mismatch', {
          fromAddress,
          mappedNode,
          previousHop,
        });
        return;
      }

      const groupIds = new Set(
        Object.values(conversationsRef.current)
          .filter((conversation) => conversation.kind === 'group' && conversation.groupId)
          .map((conversation) => conversation.groupId as string),
      );
      const finalRecipient = isFinalDestination(envelope, localId, groupIds);
      const result = await store.storeEnvelope(envelope, {
        receivedFrom: previousHop,
        transportId: transport,
        isFinalRecipient: finalRecipient,
        relayChainVerified,
      });
      diagnosticsBuffer.info('store', 'inbound-persist-result', {
        messageId: envelope.messageId,
        kind: envelope.kind,
        status: result.status,
      });
      if (
        envelope.kind === 'receipt' &&
        (result.status === 'quota-evicted' ||
          (result.status === 'duplicate' && result.entry === undefined))
      ) {
        // Quota policy may discard the control envelope after its signature,
        // route and schema were accepted. Apply its referenced state now so a
        // valid final ACK cannot be lost merely because the receipt itself is
        // the cheapest record to evict. A clear tombstone has no original and
        // therefore remains a no-op inside applyVerifiedReceipt.
        await applyVerifiedReceipt(envelope);
        await refreshStoreStats();
        return;
      }
      if (result.status === 'rejected') {
        // The store's reason was never read, so a rejection was indistinguishable
        // from silence. The clock delta is included because the most damaging
        // rejection is the >5-minute future-skew one: it fails in a single
        // direction, which looks exactly like "one phone is slower", and with
        // no time source between two phones in a blackout nothing else would
        // ever reveal it.
        diagnosticsBuffer.warn('store', 'envelope-rejected', {
          kind: envelope.kind,
          messageId: envelope.messageId,
          reason: result.reason,
          clockDeltaMs: envelope.createdAt - Date.now(),
        });
        return;
      }
      if (result.status !== 'stored' && result.status !== 'duplicate') return;
      // A tombstone-only duplicate proves this id was intentionally removed;
      // it has no retained envelope entry and must never resurrect UI/history
      // or trigger another application-level receipt.
      if (result.status === 'duplicate' && result.entry === undefined) return;

      if (envelope.kind === 'capability') {
        const direct = envelope.relay.hopCount === 1;
        handleCapability(envelope, fromAddress, direct);
        if (direct) {
          void flushForPeer(envelope.originId);
          void broadcastCapabilityRef.current();
        }
      }

      const owesCustodyReceipt =
        envelope.kind === 'content' &&
        (result.status === 'stored' ||
          (result.status === 'duplicate' && result.entry !== undefined));
      // Set only when a final delivery receipt has actually gone out *and* it
      // is addressed to the same node that handed us this envelope. That
      // receipt then proves custody to the previous hop too, so a second
      // signed frame would only double the receipt traffic on the air.
      // Broadcasts make every node a "final recipient" but issue no delivery
      // receipt, so they must keep sending custody — otherwise the sender
      // never learns the message landed and re-offers it until it expires.
      let finalReceiptCoversPreviousHop = false;

      let consumed = false;
      if (envelope.kind === 'content' && finalRecipient) {
        // Re-parse/decrypt even on duplicate delivery. A decryptable but
        // malformed private payload never earns a final ACK; appendMessage
        // itself is idempotent and will not duplicate the visible bubble.
        consumed = await processContentAtDestination(envelope);
        pushDemoEvent({
          kind: 'message-seen',
          messageId: envelope.messageId,
          hops: uiHopCount(envelope.relay.hopCount),
          path: envelope.relay.path,
          wasForMe: consumed,
          ts: Date.now(),
        });
        if (consumed && envelope.destination.kind === 'direct') {
          await issueFinalReceipt(envelope);
          finalReceiptCoversPreviousHop = previousHop === envelope.originId;
        }
      } else if (envelope.kind === 'content' && result.status === 'stored') {
        pushDemoEvent({
          kind: 'message-seen',
          messageId: envelope.messageId,
          hops: uiHopCount(envelope.relay.hopCount),
          path: envelope.relay.path,
          wasForMe: false,
          ts: Date.now(),
        });
      }

      if (envelope.kind === 'content' && owesCustodyReceipt && !finalReceiptCoversPreviousHop) {
        await issueCustodyReceipt(envelope, previousHop);
      }

      if (
        envelope.kind === 'receipt' &&
        (result.status === 'stored' ||
          (result.status === 'duplicate' && result.entry !== undefined))
      ) {
        await applyVerifiedReceipt(envelope);
      }
      await refreshStoreStats();
      if (result.status === 'stored') await flushAllConnected();
    },
    [
      applyVerifiedReceipt,
      diagnosticsBuffer,
      flushAllConnected,
      flushForPeer,
      handleCapability,
      handleHandshakeFrame,
      issueFinalReceipt,
      issueCustodyReceipt,
      processContentAtDestination,
      pushDemoEvent,
      registerAuthenticatedPeer,
      refreshStoreStats,
    ],
  );

  const currentDirectNodeIds = useCallback((): string[] => {
    const ids = new Set<string>();
    for (const peer of Object.values(peersRef.current)) {
      if (peer.connected && peer.nodeId) ids.add(peer.nodeId);
    }
    return Array.from(ids);
  }, []);

  const createCapabilityEnvelope = useCallback((): CapabilityEnvelope | null => {
    const identity = identityRef.current;
    const localNickname = nicknameRef.current;
    if (!identity || !localNickname) return null;
    const base = createBaseEnvelope(
      { kind: 'broadcast' },
      'normal',
      CAPABILITY_LIFETIME_MS,
    );
    const unsigned = {
      ...base,
      kind: 'capability' as const,
      payload: {
        nodeId: identity.nodeId,
        identity: toPublicIdentity(identity),
        displayName: localNickname,
        color: colorRef.current,
        capabilities: capabilitiesRef.current,
        topologySequence: ++topologySequenceRef.current,
        neighbors: currentDirectNodeIds().map((neighborId) => ({
          nodeId: neighborId,
          transports: Array.from(
            new Set(
              Object.values(peersRef.current)
                .filter((peer) => peer.connected && peer.nodeId === neighborId)
                .map((peer) => peer.transport ?? 'ble'),
            ),
          ),
        })),
      },
    };
    return signEnvelope<CapabilityEnvelope>(unsigned, identity);
  }, [createBaseEnvelope, currentDirectNodeIds]);

  const broadcastCapability = useCallback(async () => {
    const identity = identityRef.current;
    if (!identity || !nicknameRef.current || !meshEnabledRef.current) return;

    // The profile is 1.5-3 KB signed, and at the 23-byte fallback MTU that is
    // over two hundred GATT operations per peer. Re-flooding an identical copy
    // every 20 s was the single largest source of radio traffic in the app, so
    // an unchanged profile is only refreshed occasionally. Handshakes and the
    // store flush still run on every tick — those are what actually move
    // messages, and slowing them would slow delivery.
    const now = Date.now();
    const signature = [
      nicknameRef.current,
      colorRef.current,
      capabilityShapeKey(capabilitiesRef.current),
      currentDirectNodeIds().sort().join(','),
    ].join('|');
    const changed = signature !== lastCapabilitySignatureRef.current;
    const stale = now - lastCapabilityAnnounceRef.current >= CAPABILITY_REFRESH_MS;

    if (changed || stale) {
      const envelope = createCapabilityEnvelope();
      if (envelope && (await persistOriginated(envelope))) {
        lastCapabilitySignatureRef.current = signature;
        lastCapabilityAnnounceRef.current = now;
      }
    }

    const unknownAddresses = Object.values(peersRef.current)
      .filter((peer) => peer.connected && !peer.nodeId)
      .map((peer) => peer.address);
    await Promise.all(unknownAddresses.map((address) => startHandshake(address)));
    await flushAllConnected();
  }, [
    createCapabilityEnvelope,
    currentDirectNodeIds,
    flushAllConnected,
    persistOriginated,
    startHandshake,
  ]);
  broadcastCapabilityRef.current = broadcastCapability;

  useEffect(() => {
    const subscriptions = [
      BleMesh.addListener('onPeerDiscovered', ({ address, rssi }) => {
        const next: PeerInfo = {
          ...(peersRef.current[address] ?? {
            address,
            connected: false,
            nodeId: addressToNodeIdRef.current.get(address),
          }),
          address,
          rssi: typeof rssi === 'number' ? rssi : UNKNOWN_RSSI,
          rssiKnown: typeof rssi === 'number',
          lastSeen: Date.now(),
        };
        const all = { ...peersRef.current, [address]: next };
        peersRef.current = all;
        setPeers(all);
        if (typeof rssi === 'number') {
          setRssiHistory((previous) => ({
            ...previous,
            [address]: [...(previous[address] ?? []), { ts: Date.now(), rssi }].slice(
              -RSSI_HISTORY_LIMIT,
            ),
          }));
        }
      }),
      BleMesh.addListener('onPeerConnected', ({ address }) => {
        const previous = peersRef.current[address];
        const next: PeerInfo = {
          ...(previous ?? {
            address,
            rssi: UNKNOWN_RSSI,
            rssiKnown: false,
            lastSeen: Date.now(),
          }),
          connected: true,
          lastSeen: Date.now(),
        };
        const all = { ...peersRef.current, [address]: next };
        peersRef.current = all;
        setPeers(all);
        pushDemoEvent({ kind: 'peer-connected', address, ts: Date.now() });
        diagnosticsBuffer.info('link', 'peer-connected', { address });
        refreshNativeInspection();
        void startHandshake(address);
        void broadcastCapability();
      }),
      BleMesh.addListener('onPeerDisconnected', ({ address }) => {
        const previous = peersRef.current[address];
        const all = {
          ...peersRef.current,
          [address]: {
            ...(previous ?? {
              address,
              rssi: UNKNOWN_RSSI,
              rssiKnown: false,
              lastSeen: Date.now(),
            }),
            connected: false,
            nodeId: undefined,
            nickname: undefined,
          },
        };
        peersRef.current = all;
        setPeers(all);
        addressToNodeIdRef.current.delete(address);
        pendingHandshakeRef.current.delete(address);
        handshakeResponseAtRef.current.delete(address);
        pushDemoEvent({ kind: 'peer-disconnected', address, ts: Date.now() });
        diagnosticsBuffer.info('link', 'peer-disconnected', { address });
        refreshNativeInspection();
        void broadcastCapability();
      }),
      BleMesh.addListener('onMessageReceived', ({ address, data }) => {
        const run = handleIncomingWire(address, data, 'ble');
        activeInboundWritesRef.current.add(run);
        void run
          .catch((error) =>
            diagnosticsBuffer.warn('protocol', 'inbound-handler-failed', {
              address,
              error,
            }),
          )
          .finally(() => activeInboundWritesRef.current.delete(run));
      }),
      BleMesh.addListener(
        'onWifiAwarePeerDiscovered',
        ({ endpointId, nodeIdHint, role }) => {
          const previous = peersRef.current[endpointId];
          const next: PeerInfo = {
            ...(previous ?? {
              address: endpointId,
              connected: false,
              rssi: UNKNOWN_RSSI,
              rssiKnown: false,
              lastSeen: Date.now(),
            }),
            address: endpointId,
            transport: 'wifi-aware',
            lastSeen: Date.now(),
          };
          const all = { ...peersRef.current, [endpointId]: next };
          peersRef.current = all;
          setPeers(all);
          diagnosticsBuffer.info('link', 'wifi-aware-peer-discovered', {
            endpointId,
            nodeIdHint,
            role,
          });
        },
      ),
      BleMesh.addListener(
        'onWifiAwarePeerConnected',
        ({ endpointId, nodeIdHint, role }) => {
          const previous = peersRef.current[endpointId];
          const next: PeerInfo = {
            ...(previous ?? {
              address: endpointId,
              rssi: UNKNOWN_RSSI,
              rssiKnown: false,
              lastSeen: Date.now(),
            }),
            address: endpointId,
            connected: true,
            transport: 'wifi-aware',
            lastSeen: Date.now(),
            establishedAt: previous?.establishedAt ?? Date.now(),
          };
          const all = { ...peersRef.current, [endpointId]: next };
          peersRef.current = all;
          setPeers(all);
          diagnosticsBuffer.info('link', 'wifi-aware-peer-connected', {
            endpointId,
            nodeIdHint,
            role,
          });
          void startHandshake(endpointId);
          void broadcastCapability();
        },
      ),
      BleMesh.addListener('onWifiAwarePeerDisconnected', ({ endpointId, stage }) => {
        const previous = peersRef.current[endpointId];
        const all = {
          ...peersRef.current,
          [endpointId]: {
            ...(previous ?? {
              address: endpointId,
              rssi: UNKNOWN_RSSI,
              rssiKnown: false,
              lastSeen: Date.now(),
              transport: 'wifi-aware' as const,
            }),
            connected: false,
            nodeId: undefined,
            nickname: undefined,
          },
        };
        peersRef.current = all;
        setPeers(all);
        addressToNodeIdRef.current.delete(endpointId);
        pendingHandshakeRef.current.delete(endpointId);
        handshakeResponseAtRef.current.delete(endpointId);
        diagnosticsBuffer.info('link', 'wifi-aware-peer-disconnected', {
          endpointId,
          stage,
        });
        void broadcastCapability();
      }),
      BleMesh.addListener(
        'onWifiAwareMessageReceived',
        ({ endpointId, data }) => {
          const run = handleIncomingWire(endpointId, data, 'wifi-aware');
          activeInboundWritesRef.current.add(run);
          void run
            .catch((error) =>
              diagnosticsBuffer.warn('protocol', 'inbound-handler-failed', {
                endpointId,
                transport: 'wifi-aware',
                error,
              }),
            )
            .finally(() => activeInboundWritesRef.current.delete(run));
        },
      ),
      BleMesh.addListener('onWifiAwareStateChanged', (next) => {
        if (next.generation < wifiAwareStateRef.current.generation) return;
        wifiAwareStateRef.current = next;
        setWifiAwareState(next);
        updateCapabilities(radioStateRef.current);
        const bleHealthy =
          radioStateRef.current.running &&
          radioStateRef.current.scanning &&
          radioStateRef.current.advertising;
        if (next.running || bleHealthy) setStatus('running');
        else if (next.error && radioStateRef.current.error !== undefined) {
          setStatus('radio-error');
        }
      }),
      BleMesh.addListener('onAdapterStateChanged', (next) => {
        const normalized = normalizeRadioState(next);
        if (normalized.generation < radioGenerationRef.current) return;
        radioGenerationRef.current = normalized.generation;
        setRadioState(normalized);
        updateCapabilities(normalized);
        if (wifiAwareStateRef.current.running) setStatus('running');
        else if (!normalized.bluetoothEnabled) setStatus('bluetooth-off');
        else if (!normalized.hasPermissions) setStatus('missing-permissions');
        else if (normalized.error !== undefined || normalized.startError) setStatus('radio-error');
        else if (normalized.running && normalized.scanning && normalized.advertising) {
          setStatus('running');
        }
        refreshNativeInspection(normalized);
      }),
    ];
    try {
      subscriptions.push(
        BleMesh.addListener('onDiagnostic', (event) => {
          diagnosticsBuffer.info('transport', `ble-${event.type}`, event);
          refreshNativeInspection();
        }),
      );
      subscriptions.push(
        BleMesh.addListener('onWifiAwareDiagnostic', (event) => {
          diagnosticsBuffer.info('transport', `wifi-aware-${event.type}`, event);
        }),
      );
    } catch {
      // Older native modules do not expose structured diagnostics.
    }

    try {
      const awareConnected = BleMesh.getConnectedWifiAwarePeers();
      if (awareConnected.length > 0) {
        const all = { ...peersRef.current };
        for (const peer of awareConnected) {
          all[peer.endpointId] = {
            ...(all[peer.endpointId] ?? {
              address: peer.endpointId,
              lastSeen: Date.now(),
              rssi: UNKNOWN_RSSI,
              rssiKnown: false,
            }),
            address: peer.endpointId,
            connected: true,
            transport: 'wifi-aware',
            lastSeen: Date.now(),
            establishedAt: peer.connectedAt || Date.now(),
          };
        }
        peersRef.current = all;
        setPeers(all);
        for (const peer of awareConnected) void startHandshake(peer.endpointId);
      }
      const awareState = BleMesh.getWifiAwareState();
      wifiAwareStateRef.current = awareState;
      setWifiAwareState(awareState);
      updateCapabilities(radioStateRef.current);
    } catch {
      // Older APKs do not expose the Wi-Fi transport yet.
    }

    try {
      const connected: BleMeshPeer[] = BleMesh.getConnectedPeers();
      if (connected.length > 0) {
        const all = { ...peersRef.current };
        for (const peer of connected) {
          all[peer.address] = {
            ...(all[peer.address] ?? { address: peer.address, lastSeen: Date.now() }),
            address: peer.address,
            rssi: typeof peer.rssi === 'number' ? peer.rssi : UNKNOWN_RSSI,
            rssiKnown: typeof peer.rssi === 'number',
            connected: true,
            lastSeen: Date.now(),
          };
        }
        peersRef.current = all;
        setPeers(all);
        for (const peer of connected) void startHandshake(peer.address);
      }
    } catch {
      // The bridge can be briefly unavailable during a development reload.
    }
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, [
    broadcastCapability,
    diagnosticsBuffer,
    handleIncomingWire,
    pushDemoEvent,
    refreshNativeInspection,
    startHandshake,
    updateCapabilities,
  ]);

  useEffect(() => {
    if (!hydrated || !nickname || status !== 'running') return;
    void broadcastCapability();
    const timer = setInterval(() => void broadcastCapability(), ANNOUNCE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [broadcastCapability, hydrated, nickname, status]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const livePeers: Record<string, PeerInfo> = {};
      for (const [address, peer] of Object.entries(peersRef.current)) {
        if (peer.connected || now - peer.lastSeen < PEER_STALE_MS) {
          livePeers[address] = peer;
        } else {
          addressToNodeIdRef.current.delete(address);
          pendingHandshakeRef.current.delete(address);
          handshakeResponseAtRef.current.delete(address);
        }
      }
      if (Object.keys(livePeers).length !== Object.keys(peersRef.current).length) {
        peersRef.current = livePeers;
        setPeers(livePeers);
      }
      setTopology((previous) => {
        const live: Record<string, TopologyInfo> = {};
        for (const [id, info] of Object.entries(previous)) {
          if (now - info.lastAnnounceTs < TOPOLOGY_EXPIRY_MS) live[id] = info;
        }
        if (Object.keys(live).length === Object.keys(previous).length) return previous;
        topologyRef.current = live;
        return live;
      });
      void storeRef.current
        ?.prune(now)
        .then(() => refreshStoreStats())
        .catch((error) => diagnosticsBuffer.warn('store', 'prune-failed', { error }));
      for (const [address, challenge] of pendingHandshakeRef.current) {
        if (challenge.expiresAt <= now) pendingHandshakeRef.current.delete(address);
      }
      for (const [key, retryAfter] of receiptCooldownRef.current) {
        if (retryAfter <= now) receiptCooldownRef.current.delete(key);
      }
      for (const [address, respondedAt] of handshakeResponseAtRef.current) {
        if (now - respondedAt > BLE_HANDSHAKE_LIFETIME_MS) {
          handshakeResponseAtRef.current.delete(address);
        }
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [diagnosticsBuffer, refreshStoreStats]);

  const requestStart = useCallback((): Promise<void> => {
    stopRequestedRef.current = false;
    meshLifecycleIntentRef.current = 'start';
    if (startInFlightRef.current) return startInFlightRef.current;
    const run = (async () => {
      await hydrationInFlightRef.current?.catch(() => undefined);
      if (meshLifecycleIntentRef.current !== 'start') return;
      await setStoredMeshEnabled(true);
      if (meshLifecycleIntentRef.current !== 'start') return;
      meshEnabledRef.current = true;
      setMeshEnabled(true);
      if (Platform.OS !== 'android') {
        setStatus('unsupported');
        return;
      }
      setStatus('starting');
      try {
        const native = nativeCapabilitiesOrNull();
        const awareCanCarryData =
          native?.wifiAware.automaticTransport === true &&
          typeof BleMesh.startWifiAware === 'function';
        // Permission denial disables only that transport. In particular,
        // location denial on Android 12 must not block BLE, and Bluetooth
        // denial must not block an otherwise usable Wi-Fi Aware link.
        const [bleGranted, awareGranted] = await Promise.all([
          requestBlePermissions().catch(() => false),
          awareCanCarryData
            ? requestWifiAwarePermission().catch(() => false)
            : Promise.resolve(false),
        ]);
        await requestNotificationPermission();

        let bleAccepted = false;
        const bluetoothEnabled = BleMesh.isBluetoothEnabled();
        if (bleGranted && bluetoothEnabled) {
          bleAccepted = BleMesh.start();
        } else if (bleGranted && !bluetoothEnabled) {
          BleMesh.requestEnableBluetooth();
        }

        let awareAccepted = false;
        const localId = nodeIdRef.current;
        if (awareGranted && localId) {
          awareAccepted = BleMesh.startWifiAware(localId);
        }

        const deadline = Date.now() + RADIO_CONFIRM_TIMEOUT_MS;
        while (mountedRef.current && Date.now() < deadline) {
          const next = normalizeRadioState(BleMesh.getRadioState());
          const nextAware = awareCanCarryData
            ? BleMesh.getWifiAwareState()
            : EMPTY_WIFI_AWARE_STATE;
          radioGenerationRef.current = Math.max(
            radioGenerationRef.current,
            next.generation,
          );
          setRadioState(next);
          wifiAwareStateRef.current = nextAware;
          setWifiAwareState(nextAware);
          updateCapabilities(next);
          if (
            (next.running && next.scanning && next.advertising) ||
            nextAware.running
          ) {
            setStatus('running');
            return;
          }
          await wait(100);
        }
        if (!mountedRef.current) return;
        if (!bleGranted && !awareGranted) setStatus('missing-permissions');
        else if (!bluetoothEnabled && !awareAccepted) setStatus('bluetooth-off');
        else if (!bleAccepted && !awareAccepted) setStatus('radio-error');
        else setStatus('radio-error');
      } catch (error) {
        diagnosticsBuffer.error('transport', 'mesh-start-failed', { error });
        setStatus('radio-error');
      }
    })();
    startInFlightRef.current = run;
    void run
      .finally(() => {
        if (startInFlightRef.current === run) startInFlightRef.current = null;
      })
      .catch(() => undefined);
    return run;
  }, [diagnosticsBuffer, updateCapabilities]);

  const restartMesh = useCallback((): Promise<void> => {
    if (restartInFlightRef.current) return restartInFlightRef.current;
    stopRequestedRef.current = false;
    meshLifecycleIntentRef.current = 'start';
    const run = (async () => {
      await hydrationInFlightRef.current?.catch(() => undefined);
      if (meshLifecycleIntentRef.current !== 'start') return;
      const pending = startInFlightRef.current;
      if (pending) {
        await pending;
        if (startInFlightRef.current === pending) startInFlightRef.current = null;
      }
      try {
        BleMesh.stop();
      } catch {
        // best effort before a clean start
      }
      try {
        BleMesh.stopWifiAware();
      } catch {
        // The Wi-Fi runtime is independent and may not exist on an older APK.
      }
      addressToNodeIdRef.current.clear();
      pendingHandshakeRef.current.clear();
      const unboundPeers: Record<string, PeerInfo> = {};
      for (const [address, peer] of Object.entries(peersRef.current)) {
        unboundPeers[address] = {
          ...peer,
          connected: false,
          nodeId: undefined,
          nickname: undefined,
        };
      }
      peersRef.current = unboundPeers;
      setPeers(unboundPeers);
      setStatus('starting');
      await wait(RADIO_SETTLE_MS);
      if (
        stopRequestedRef.current ||
        meshLifecycleIntentRef.current !== 'start'
      ) {
        return;
      }
      await requestStart();
    })();
    restartInFlightRef.current = run;
    void run
      .finally(() => {
        if (restartInFlightRef.current === run) restartInFlightRef.current = null;
      })
      .catch(() => undefined);
    return run;
  }, [requestStart]);

  const stopMesh = useCallback(async () => {
    stopRequestedRef.current = true;
    meshLifecycleIntentRef.current = 'stop';
    meshEnabledRef.current = false;
    setMeshEnabled(false);
    const applyStoppedState = () => {
      addressToNodeIdRef.current.clear();
      pendingHandshakeRef.current.clear();
      handshakeResponseAtRef.current.clear();
      const stoppedPeers: Record<string, PeerInfo> = {};
      for (const [address, peer] of Object.entries(peersRef.current)) {
        stoppedPeers[address] = {
          ...peer,
          connected: false,
          nodeId: undefined,
          nickname: undefined,
        };
      }
      peersRef.current = stoppedPeers;
      setPeers(stoppedPeers);
      setRadioState(EMPTY_RADIO_STATE);
      wifiAwareStateRef.current = EMPTY_WIFI_AWARE_STATE;
      setWifiAwareState(EMPTY_WIFI_AWARE_STATE);
      updateCapabilities(EMPTY_RADIO_STATE);
      setStatus('idle');
    };
    try {
      BleMesh.stop();
    } catch (error) {
      diagnosticsBuffer.warn('transport', 'ble-stop-failed', { error });
    }
    try {
      BleMesh.stopWifiAware();
    } catch (error) {
      diagnosticsBuffer.warn('transport', 'wifi-aware-stop-failed', { error });
    }
    applyStoppedState();

    const persistedPause = setStoredMeshEnabled(false).catch((error) => {
      diagnosticsBuffer.error('store', 'mesh-pause-persist-failed', { error });
    });
    const pending = startInFlightRef.current;
    if (pending) await pending.catch(() => undefined);
    if (meshLifecycleIntentRef.current !== 'stop') return;
    const pendingRestart = restartInFlightRef.current;
    if (pendingRestart) await pendingRestart.catch(() => undefined);
    if (meshLifecycleIntentRef.current !== 'stop') return;
    try {
      BleMesh.stop();
    } catch (error) {
      diagnosticsBuffer.warn('transport', 'ble-stop-failed', { error });
    }
    try {
      BleMesh.stopWifiAware();
    } catch (error) {
      diagnosticsBuffer.warn('transport', 'wifi-aware-stop-failed', { error });
    }
    applyStoppedState();
    await persistedPause;
  }, [diagnosticsBuffer, updateCapabilities]);

  useEffect(() => {
    if (hydrated && meshEnabled && nickname && nodeId && status === 'idle') void requestStart();
  }, [hydrated, meshEnabled, nickname, nodeId, requestStart, status]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || Platform.OS !== 'android') return;
      try {
        const next = normalizeRadioState(BleMesh.getRadioState());
        const nextAware = BleMesh.getWifiAwareState();
        setRadioState(next);
        wifiAwareStateRef.current = nextAware;
        setWifiAwareState(nextAware);
        updateCapabilities(next);
        if (
          (next.running && next.scanning && next.advertising) ||
          nextAware.running
        ) setStatus('running');
        else if (nicknameRef.current && meshEnabledRef.current) void restartMesh();
        setBatteryOptimizationIgnored(BleMesh.isIgnoringBatteryOptimizations());
      } catch (error) {
        diagnosticsBuffer.warn('transport', 'resume-inspection-failed', { error });
      }
    });
    return () => subscription.remove();
  }, [diagnosticsBuffer, restartMesh, updateCapabilities]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    try {
      setBatteryOptimizationIgnored(BleMesh.isIgnoringBatteryOptimizations());
      const nextAware = BleMesh.getWifiAwareState();
      wifiAwareStateRef.current = nextAware;
      setWifiAwareState(nextAware);
    } catch {
      // No battery-optimization API on unsupported native builds.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Native mesh runtime is process-owned. Listener cleanup above detaches
      // this JS instance without stopping the foreground relay service.
    };
  }, []);

  const awaitHydrationReady = useCallback(async (): Promise<void> => {
    const inFlight = hydrationInFlightRef.current;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        throw new Error('No se pudo preparar la identidad y el almacenamiento de Anyway.');
      }
    }
    if (!hydratedRef.current) {
      throw new Error('Anyway todavía no terminó de preparar identidad y almacenamiento.');
    }
  }, []);

  const setNickname = useCallback(
    async (name: string) => {
      await awaitHydrationReady();
      const normalized = name.trim().slice(0, 64);
      if (!normalized) return;
      await persistNicknameToDisk(normalized);
      nicknameRef.current = normalized;
      setNicknameState(normalized);
      await broadcastCapability();
    },
    [awaitHydrationReady, broadcastCapability],
  );

  const setTtl = useCallback(
    async (value: number) => {
      await awaitHydrationReady();
      const normalized = Math.max(1, Math.min(10, Math.floor(value)));
      await persistTtlToDisk(normalized);
      ttlRef.current = normalized;
      setTtlState(normalized);
    },
    [awaitHydrationReady],
  );

  const setColor = useCallback(
    async (value: string) => {
      await awaitHydrationReady();
      await persistColorToDisk(value);
      colorRef.current = value;
      setColorState(value);
      await broadcastCapability();
    },
    [awaitHydrationReady, broadcastCapability],
  );

  const sendBroadcastContent = useCallback(
    async (
      target: { kind: 'broadcast' },
      text: string | undefined,
      location: GeoLocation | undefined,
      priority: MessagePriority,
      displayId: string,
    ) => {
      const payload: ContentEnvelope['payload'] =
        priority === 'sos'
          ? { type: 'sos', text: text || undefined, location }
          : location
            ? { type: 'location', location, note: text || undefined }
            : { type: 'text', text: text ?? '' };
      const envelope = createContentEnvelope(target, priority, payload, displayId);
      wireToDisplayRef.current.set(envelope.messageId, {
        displayId,
        aggregate: false,
      });
      appendMessage(
        BROADCAST_CONVERSATION_ID,
        createChatMessage({
          envelope,
          target,
          text,
          location,
          incoming: false,
          encrypted: false,
        }),
        { incoming: false },
      );
      // Durable local intent precedes the relay record. A crash can leave a
      // visible `created` draft, never an invisible ciphertext that relays.
      try {
        await persistenceQueueRef.current;
      } catch {
        updateDisplayedMessage(displayId, { state: 'failed' });
        await persistenceQueueRef.current.catch(() => undefined);
        throw new Error('No se pudo guardar el historial local cifrado.');
      }
      if (!(await persistOriginated(envelope))) {
        updateDisplayedMessage(displayId, { state: 'failed' });
        await persistenceQueueRef.current;
        throw new Error('No se pudo guardar el mensaje público antes de enviarlo.');
      }
      updateDisplayedMessage(displayId, { state: 'stored' });
      await persistenceQueueRef.current;
      await flushAllConnected();
    },
    [
      appendMessage,
      createChatMessage,
      createContentEnvelope,
      flushAllConnected,
      persistOriginated,
      updateDisplayedMessage,
    ],
  );

  const prepareDirectCopy = useCallback(
    (options: {
      recipientId: string;
      payload: PrivateApplicationPayload;
      priority: MessagePriority;
      displayId: string;
      aggregate: boolean;
    }): ContentEnvelope => {
      const identity = identityRef.current;
      const recipient = knownPeersRef.current[options.recipientId]?.identity;
      if (!identity || !recipient || !verifyPublicIdentity(recipient)) {
        diagnosticsBuffer.warn('security', 'recipient-key-unavailable', {
          recipientId: options.recipientId,
        });
        throw new Error(`No hay una identidad cifrable válida para ${options.recipientId}.`);
      }
      const plaintextType: SealedPayload['plaintextType'] =
        options.payload.kind === 'direct-text' ? 'text' : 'application-data';
      const sealed = sealPayloadForPeer(
        plaintextType,
        JSON.stringify(options.payload),
        recipient,
        identity,
      );
      const envelope = createContentEnvelope(
        { kind: 'direct', nodeId: options.recipientId },
        options.priority,
        sealed,
        options.aggregate ? undefined : options.displayId,
      );
      wireToDisplayRef.current.set(envelope.messageId, {
        displayId: options.displayId,
        aggregate: options.aggregate,
      });
      const firstHopProbe = advanceEnvelopeForRelay(
        envelope,
        identity.nodeId,
        options.recipientId,
        identity,
      );
      const wireBytes = firstHopProbe
        ? encodedByteLength(encodeEnvelope(firstHopProbe))
        : Number.POSITIVE_INFINITY;
      if (!firstHopProbe || wireBytes > BLE_BASELINE_ENVELOPE_BYTES) {
        throw new Error(
          `El mensaje cifrado supera el límite BLE de ${BLE_BASELINE_ENVELOPE_BYTES} bytes.`,
        );
      }
      return envelope;
    },
    [createContentEnvelope, diagnosticsBuffer],
  );

  const performApplicationMessage = useCallback(
    async (input: {
      target: MeshTarget;
      text?: string;
      location?: GeoLocation;
      priority: MessagePriority;
    }) => {
      await awaitHydrationReady();
      if (clearingMessagesRef.current) {
        throw new Error('El historial se está borrando; intentá enviar nuevamente.');
      }
      const identity = identityRef.current;
      if (!identity || !nicknameRef.current || !storeRef.current) {
        throw new Error('Anyway todavía no terminó de preparar identidad y almacenamiento.');
      }
      if (input.location && !isGeoLocation(input.location)) {
        throw new Error('La ubicación no contiene una coordenada y marca de tiempo válidas.');
      }
      let text = input.text?.trim();
      if (!text && !input.location && input.priority === 'sos') text = 'SOS';
      if (!text && !input.location) throw new Error('El mensaje está vacío.');
      const characterCount = text ? Array.from(text).length : 0;
      if (characterCount > MAX_TEXT_CHARACTERS) {
        diagnosticsBuffer.warn('protocol', 'text-too-long-for-ble-baseline', {
          characters: characterCount,
          limit: MAX_TEXT_CHARACTERS,
        });
        throw new Error(`El texto supera el máximo de ${MAX_TEXT_CHARACTERS} caracteres.`);
      }
      const displayId = generateMessageId();

      if (input.target.kind === 'broadcast') {
        await sendBroadcastContent(input.target, text, input.location, input.priority, displayId);
        return;
      }

      if (input.target.kind === 'direct') {
        const payload: PrivateApplicationPayload =
          input.priority === 'normal'
            ? { kind: 'direct-text', text: text ?? '', displayId }
            : {
                kind: 'emergency',
                text: text || undefined,
                location: input.location,
                priority: input.priority,
                displayId,
              };
        const envelope = prepareDirectCopy({
          recipientId: input.target.nodeId,
          payload,
          priority: input.priority,
          displayId,
          aggregate: false,
        });
        ensureDirectConversation(input.target.nodeId);
        await persistenceQueueRef.current;
        appendMessage(
          directConversationId(input.target.nodeId),
          createChatMessage({
            envelope,
            displayId,
            target: input.target,
            text,
            location: input.location,
            incoming: false,
            encrypted: true,
          }),
          { incoming: false },
        );
        try {
          await persistenceQueueRef.current;
        } catch {
          updateDisplayedMessage(displayId, { state: 'failed' });
          await persistenceQueueRef.current.catch(() => undefined);
          throw new Error('No se pudo guardar el historial privado local cifrado.');
        }
        if (!(await persistOriginated(envelope))) {
          updateDisplayedMessage(displayId, { state: 'failed' });
          await persistenceQueueRef.current;
          throw new Error('No se pudo guardar el mensaje privado antes de enviarlo.');
        }
        updateDisplayedMessage(displayId, { state: 'stored' });
        await persistenceQueueRef.current;
        await flushAllConnected();
        return;
      }

      const groupId = input.target.groupId;
      const conversation = conversationsRef.current[groupConversationId(groupId)];
      if (
        !conversation ||
        conversation.kind !== 'group' ||
        !conversation.ownerNodeId ||
        !conversation.revision ||
        !conversation.memberIds?.includes(identity.nodeId)
      ) {
        throw new Error('El grupo no tiene una membresía autenticada vigente.');
      }
      const recipients = (conversation?.memberIds ?? []).filter((id) => id !== identity.nodeId);
      if ((conversation.memberIds?.length ?? 0) > MAX_GROUP_MEMBERS) {
        throw new Error(
          `Esta versión admite hasta ${MAX_GROUP_MEMBERS} miembros por grupo.`,
        );
      }
      if (recipients.length === 0) throw new Error('El grupo no tiene otros destinatarios.');
      const payloadFor = (): PrivateApplicationPayload =>
        input.priority === 'normal'
          ? {
              kind: 'group-text',
              groupId,
              text: text ?? '',
              displayId,
            }
          : {
              kind: 'group-emergency',
              groupId,
              text: text || undefined,
              location: input.location,
              priority: input.priority,
              displayId,
            };
      const copies = recipients.map((recipientId) =>
          prepareDirectCopy({
            recipientId,
            payload: payloadFor(),
            priority: input.priority,
            displayId,
            aggregate: true,
          }),
      );
      const representative = copies[0];
      appendMessage(
        groupConversationId(input.target.groupId),
        createChatMessage({
          envelope: representative,
          displayId,
          target: input.target,
          text,
          location: input.location,
          incoming: false,
          encrypted: true,
          wireMessageIds: copies.map((copy) => copy.messageId),
        }),
        { incoming: false },
      );
      try {
        await persistenceQueueRef.current;
      } catch {
        updateDisplayedMessage(displayId, { state: 'failed' });
        await persistenceQueueRef.current.catch(() => undefined);
        throw new Error('No se pudo guardar el historial del grupo cifrado.');
      }
      if (!(await persistOriginatedBatch(copies))) {
        updateDisplayedMessage(displayId, { state: 'failed' });
        await persistenceQueueRef.current;
        throw new Error('No se pudieron guardar todas las copias cifradas del grupo.');
      }
      updateDisplayedMessage(displayId, { state: 'stored' });
      await persistenceQueueRef.current;
      await flushAllConnected();
    },
    [
      appendMessage,
      awaitHydrationReady,
      createChatMessage,
      ensureDirectConversation,
      flushAllConnected,
      persistOriginated,
      persistOriginatedBatch,
      prepareDirectCopy,
      sendBroadcastContent,
      updateDisplayedMessage,
    ],
  );

  const sendApplicationMessage = useCallback(
    (input: {
      target: MeshTarget;
      text?: string;
      location?: GeoLocation;
      priority: MessagePriority;
    }): Promise<void> => {
      if (clearingMessagesRef.current) {
        return Promise.reject(
          new Error('El historial se está borrando; intentá enviar nuevamente.'),
        );
      }
      const run = performApplicationMessage(input);
      activeApplicationWritesRef.current.add(run);
      void run.finally(() => {
        activeApplicationWritesRef.current.delete(run);
      }).catch(() => undefined);
      return run;
    },
    [performApplicationMessage],
  );

  const sendText = useCallback(
    (target: MeshTarget, text: string) =>
      sendApplicationMessage({ target, text, priority: 'normal' }),
    [sendApplicationMessage],
  );

  const sendEmergency = useCallback(
    (input: EmergencyInput) =>
      sendApplicationMessage({
        target: input.target,
        text: input.text,
        location: input.location,
        priority: input.priority,
      }),
    [sendApplicationMessage],
  );

  const performCreateGroup = useCallback(
    async (name: string, memberNodeIds: string[]) => {
      await awaitHydrationReady();
      if (clearingMessagesRef.current) {
        throw new Error('El historial se está borrando; intentá crear el grupo nuevamente.');
      }
      const identity = identityRef.current;
      if (!identity || !nicknameRef.current || !storeRef.current) {
        throw new Error('Anyway todavía no terminó de preparar identidad y almacenamiento.');
      }
      const normalizedName = name.trim().slice(0, 64);
      if (!normalizedName) throw new Error('El grupo necesita un nombre.');
      const groupId = generateMessageId();
      const memberIds = Array.from(
        new Set([identity.nodeId, ...memberNodeIds.filter((id) => id !== identity.nodeId)]),
      );
      if (memberIds.length < 2) throw new Error('El grupo necesita otro miembro.');
      if (memberIds.length > MAX_GROUP_MEMBERS) {
        throw new Error(
          `El grupo supera el máximo de ${MAX_GROUP_MEMBERS} miembros de esta versión.`,
        );
      }
      const recipients = memberIds.filter((id) => id !== identity.nodeId);
      const members: Extract<PrivateApplicationPayload, { kind: 'group-invite' }>['members'] = [
        {
          nodeId: identity.nodeId,
          nickname: nicknameRef.current,
          color: colorRef.current,
          identity: toPublicIdentity(identity),
        },
      ];
      for (const memberId of recipients) {
        const peer = knownPeersRef.current[memberId];
        if (!peer?.identity || !verifyPublicIdentity(peer.identity)) {
          throw new Error(`Falta una identidad válida para el miembro ${memberId}.`);
        }
        members.push({
          nodeId: peer.nodeId,
          nickname: peer.nickname,
          color: peer.color,
          identity: peer.identity,
        });
      }
      const inviteCopies = recipients.map((recipientId) =>
          prepareDirectCopy({
            recipientId,
            priority: 'important',
            displayId: groupId,
            aggregate: true,
            payload: {
              kind: 'group-invite',
              groupId,
              groupName: normalizedName,
              ownerNodeId: identity.nodeId,
              revision: 1,
              memberIds,
              members,
            },
          }),
      );
      upsertGroupConversation(groupId, normalizedName, memberIds, identity.nodeId, 1);
      await persistenceQueueRef.current;
      if (!(await persistOriginatedBatch(inviteCopies))) {
        throw new Error('El grupo quedó local, pero no se pudieron guardar todas las invitaciones.');
      }
      await flushAllConnected();
      return groupId;
    },
    [
      awaitHydrationReady,
      flushAllConnected,
      persistOriginatedBatch,
      prepareDirectCopy,
      upsertGroupConversation,
    ],
  );

  const createGroup = useCallback(
    (name: string, memberNodeIds: string[]): Promise<string> => {
      if (clearingMessagesRef.current) {
        return Promise.reject(
          new Error('El historial se está borrando; intentá crear el grupo nuevamente.'),
        );
      }
      const run = performCreateGroup(name, memberNodeIds);
      activeApplicationWritesRef.current.add(run);
      void run.finally(() => {
        activeApplicationWritesRef.current.delete(run);
      }).catch(() => undefined);
      return run;
    },
    [performCreateGroup],
  );

  const setActiveConversation = useCallback(
    (conversationId: string | null) => {
      activeConversationIdRef.current = conversationId;
      if (!conversationId) return;
      const conversation = conversationsRef.current[conversationId];
      if (!conversation || conversation.unreadCount === 0) return;
      replaceConversations({
        ...conversationsRef.current,
        [conversationId]: { ...conversation, unreadCount: 0 },
      });
    },
    [replaceConversations],
  );

  const clearAllMessages = useCallback((): Promise<void> => {
    if (clearMessagesInFlightRef.current) return clearMessagesInFlightRef.current;
    const run = (async () => {
      clearingMessagesRef.current = true;
      await hydrationInFlightRef.current?.catch(() => undefined);
      const activeWrites = [
        ...activeApplicationWritesRef.current,
        ...activeInboundWritesRef.current,
      ];
      await Promise.all(activeWrites.map((operation) => operation.catch(() => undefined)));
      await Promise.all(
        Array.from(flushLocksRef.current.values(), (operation) =>
          operation.catch(() => undefined),
        ),
      );
      // Drain every prior encrypted-history write first. Inbound/outbound
      // application records are held off until both durable stores are clear.
      await persistenceQueueRef.current.catch(() => undefined);
      await storeRef.current?.clear({ keepDedupTombstones: true });
      await enqueuePersistence(clearStoredMessages);
      messagesRef.current = {};
      setMessagesByConversation({});
      wireToDisplayRef.current.clear();
      await refreshStoreStats();
      await broadcastCapability();
    })();
    clearMessagesInFlightRef.current = run;
    void run.finally(() => {
      clearingMessagesRef.current = false;
      if (clearMessagesInFlightRef.current === run) {
        clearMessagesInFlightRef.current = null;
      }
    }).catch(() => undefined);
    return run;
  }, [broadcastCapability, enqueuePersistence, refreshStoreStats]);

  const requestIgnoreBatteryOptimizations = useCallback(() => {
    try {
      BleMesh.requestIgnoreBatteryOptimizations();
    } catch (error) {
      diagnosticsBuffer.warn('app', 'battery-settings-unavailable', { error });
    }
  }, [diagnosticsBuffer]);

  const nearbyDevices = useMemo<NearbyDevice[]>(() => {
    const identified = new Map<string, NearbyDevice>();
    const anonymous: NearbyDevice[] = [];
    for (const peer of Object.values(peers)) {
      if (!peer.nodeId) {
        anonymous.push({ key: peer.address, ...peer });
        continue;
      }
      const known = knownPeers[peer.nodeId];
      const previous = identified.get(peer.nodeId);
      const useCurrent =
        !previous ||
        (peer.connected && !previous.connected) ||
        (peer.connected === previous.connected && peer.lastSeen > previous.lastSeen);
      identified.set(peer.nodeId, {
        key: peer.nodeId,
        nodeId: peer.nodeId,
        nickname: known?.nickname ?? peer.nickname,
        color: known?.color,
        address: useCurrent ? peer.address : previous!.address,
        rssi: useCurrent ? peer.rssi : previous!.rssi,
        rssiKnown: useCurrent ? peer.rssiKnown : previous!.rssiKnown,
        connected: (previous?.connected ?? false) || peer.connected,
        lastSeen: Math.max(previous?.lastSeen ?? 0, peer.lastSeen),
      });
    }
    return [...identified.values(), ...anonymous];
  }, [knownPeers, peers]);

  const meshGraph = useMemo<MeshNode[]>(() => {
    const direct = new Map(
      nearbyDevices
        .filter((device) => device.connected && device.nodeId)
        .map((device) => [device.nodeId as string, device]),
    );
    const nodes: MeshNode[] = Object.entries(topology).map(([id, info]) => {
      const directDevice = direct.get(id);
      return {
        nodeId: id,
        nickname: info.nickname,
        color: info.color,
        neighbors: info.neighbors.map((neighbor) => neighbor.nodeId),
        hopsAway: directDevice ? 0 : info.hopsAway,
        lastAnnounceTs: info.lastAnnounceTs,
        isDirect: !!directDevice,
        rssi:
          directDevice?.rssiKnown && directDevice.rssi !== null
            ? directDevice.rssi
            : undefined,
      };
    });
    if (nodeId) {
      nodes.push({
        nodeId,
        nickname: nickname ?? undefined,
        color,
        neighbors: currentDirectNodeIds(),
        hopsAway: 0,
        lastAnnounceTs: Date.now(),
        isDirect: true,
      });
    }
    return nodes;
  }, [color, currentDirectNodeIds, nearbyDevices, nickname, nodeId, topology]);

  const meshEdges = useMemo(() => computeMeshEdges(meshGraph), [meshGraph]);
  const articulationPoints = useMemo(
    () => findArticulationPoints(meshGraph.map((node) => node.nodeId), meshEdges),
    [meshEdges, meshGraph],
  );

  const links = useMemo<Link[]>(
    () => buildRoutingLinks(),
    [buildRoutingLinks, nativeLinkSnapshots, nearbyDevices, nodeId, topology],
  );

  // Collapses endpoints back into the peers a person actually has: the address
  // is a radio detail, the identity is the contact.
  const peerSessions = useMemo<PeerSession[]>(() => {
    const grouped = new Map<string, PeerInfo[]>();
    for (const peer of Object.values(peers)) {
      if (!peer.connected || !peer.nodeId) continue;
      const list = grouped.get(peer.nodeId) ?? [];
      list.push(peer);
      grouped.set(peer.nodeId, list);
    }
    return Array.from(grouped, ([sessionNodeId, endpoints]) => {
      const activeAddress = activeEndpointRef.current.get(sessionNodeId);
      const active = endpoints.find((peer) => peer.address === activeAddress) ?? endpoints[0];
      return {
        nodeId: sessionNodeId,
        nickname: endpoints.find((peer) => peer.nickname)?.nickname,
        endpoints,
        activeTransport: active ? active.transport ?? 'ble' : null,
        transports: Array.from(
          new Set(endpoints.map((peer) => peer.transport ?? 'ble')),
        ) as PeerTransport[],
      };
    });
  }, [peers]);

  const conversationSummaries = useMemo<ConversationSummary[]>(
    () =>
      Object.values(conversations)
        .map((conversation) => {
          const list = messagesByConversation[conversation.id] ?? [];
          return { conversation, lastMessage: list[list.length - 1] };
        })
        // Same clock that chose `lastMessage` off the end of the list. Picking
        // the element by one ordering and sorting the rows by another let a
        // conversation sink below idle ones right after it received traffic.
        .sort(
          (left, right) =>
            (right.lastMessage ? displayTimeOf(right.lastMessage) : 0) -
            (left.lastMessage ? displayTimeOf(left.lastMessage) : 0),
        ),
    [conversations, messagesByConversation],
  );

  const getMessages = useCallback(
    (conversationId: string) => messagesByConversation[conversationId] ?? [],
    [messagesByConversation],
  );
  const getRssiHistory = useCallback(
    (address: string) => rssiHistory[address] ?? [],
    [rssiHistory],
  );
  const exportDiagnostics = useCallback(
    () => diagnosticsBuffer.export({ pretty: true, includeSensitiveData: false }),
    [diagnosticsBuffer],
  );
  const diagnostics = useMemo(
    () => diagnosticsBuffer.snapshot(),
    [diagnosticRevision, diagnosticsBuffer],
  );

  const value: MeshContextValue = {
    hydrated,
    hydrationFailure,
    hydrationWarnings,
    status,
    meshEnabled,
    nodeId,
    nickname,
    ttl,
    color,
    peers: Object.values(peers),
    peerSessions,
    nearbyDevices,
    meshGraph,
    meshEdges,
    articulationPoints,
    knownPeers: Object.values(knownPeers),
    conversationSummaries,
    demoEvents,
    capabilities,
    links,
    coreLinks: links,
    storeStats,
    diagnostics,
    diagnosticEvents: diagnostics,
    exportDiagnostics,
    getRssiHistory,
    getMessages,
    setNickname,
    setTtl,
    setColor,
    sendText,
    sendEmergency,
    createGroup,
    setActiveConversation,
    clearAllMessages,
    requestStart,
    restartMesh,
    stopMesh,
    batteryOptimizationIgnored,
    radioState,
    wifiAwareState,
    powerSaveMode: wifiAwareState.powerSaveMode,
    requestIgnoreBatteryOptimizations,
  };

  return <MeshContext.Provider value={value}>{children}</MeshContext.Provider>;
}

export function useMesh(): MeshContextValue {
  const context = useContext(MeshContext);
  if (!context) throw new Error('useMesh must be used within a MeshProvider');
  return context;
}
