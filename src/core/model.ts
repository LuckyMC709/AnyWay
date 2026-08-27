/**
 * Transport-independent domain model for Anyway.
 *
 * Radio addresses, IPs and platform peer handles intentionally live in
 * TransportEndpoint. They are observations, never the stable node identity.
 */

export type AnywayNodeId = string;
export type LinkId = string;
export type RouteId = string;
export type TransportId = string;
export type UnixMillis = number;

export type KnownTransportKind =
  | 'ble'
  | 'wifi-aware'
  | 'wifi-direct'
  | 'ethernet'
  | 'lora';

/** Allows future transports without changing the messaging or routing layers. */
export type TransportKind = KnownTransportKind | (string & {});

export type CapabilityAvailability =
  | 'supported'
  | 'unsupported'
  | 'temporarily-unavailable'
  | 'unknown';

export type CapabilityEvidenceSource =
  | 'runtime-probe'
  | 'remote-advertisement'
  | 'configured'
  | 'inferred';

export interface CapabilityEvidence {
  source: CapabilityEvidenceSource;
  observedAt: UnixMillis;
  detail?: string;
}

export interface TransportCapability {
  kind: TransportKind;
  availability: CapabilityAvailability;
  canDiscover: boolean;
  canAdvertise: boolean;
  canInitiateLinks: boolean;
  canAcceptLinks: boolean;
  supportsDuplex: boolean;
  supportsBackgroundOperation: boolean;
  supportsRanging: boolean;
  maxConcurrentLinks?: number;
  maxPayloadBytes?: number;
  evidence?: CapabilityEvidence;
}

export interface NodeCapabilities {
  protocolVersions: number[];
  transports: Record<string, TransportCapability>;
  supportsStoreAndForward: boolean;
  supportsMultipath: boolean;
  supportsEndToEndEncryption: boolean;
  supportsLocationPayloads: boolean;
  maxRelayHops: number;
  maxEnvelopeBytes: number;
  updatedAt: UnixMillis;
}

export type NodeReachabilityState =
  | 'discovered'
  | 'reachable'
  | 'connected'
  | 'stale'
  | 'unavailable';

export type NodeTrustState = 'unverified' | 'key-observed' | 'verified' | 'blocked';

/** A transport-scoped locator that may rotate at any time. */
export interface TransportEndpoint {
  transportId: TransportId;
  transportKind: TransportKind;
  endpointId: string;
  discoveredAt: UnixMillis;
  lastSeenAt: UnixMillis;
  metadata?: Record<string, string | number | boolean>;
}

export interface AnywayNode {
  id: AnywayNodeId;
  displayName?: string;
  identityPublicKey?: string;
  trust: NodeTrustState;
  state: NodeReachabilityState;
  capabilities?: NodeCapabilities;
  endpoints: TransportEndpoint[];
  firstSeenAt: UnixMillis;
  lastSeenAt: UnixMillis;
}

export type LinkState =
  | 'discovered'
  | 'connecting'
  | 'active'
  | 'degraded'
  | 'disconnecting'
  | 'disconnected'
  | 'failed';

export type LinkDirection = 'duplex' | 'from-to-only';
export type MetricProvenance = 'measured' | 'estimated' | 'unknown';

/**
 * A metric always carries provenance so UI and routing never present an RSSI
 * estimate (or any derived value) as an exact measurement.
 */
export interface MetricReading<T extends number = number> {
  value?: T;
  provenance: MetricProvenance;
  observedAt?: UnixMillis;
  sampleCount?: number;
}

export interface LinkCounters {
  /** Missing means the active transport does not expose this measurement. */
  bytesSent?: number;
  bytesReceived?: number;
  packetsSent?: number;
  packetsReceived?: number;
  errors?: number;
  reconnects?: number;
}

export interface LinkMetrics {
  rssiDbm?: MetricReading;
  latencyMs?: MetricReading;
  throughputBytesPerSecond?: MetricReading;
  packetLossRatio?: MetricReading;
  successRatio?: MetricReading;
  stabilityRatio?: MetricReading;
  congestionRatio?: MetricReading;
  /** Normalized 0 (cheap) to 1 (expensive). */
  energyCost?: MetricReading;
  setupLatencyMs?: MetricReading;
  counters: LinkCounters;
}

/**
 * A link is one usable edge over exactly one transport. Two devices may have
 * several simultaneous links (for example BLE plus Wi-Fi Aware).
 */
export interface Link {
  id: LinkId;
  from: AnywayNodeId;
  to: AnywayNodeId;
  transportId: TransportId;
  transportKind: TransportKind;
  direction: LinkDirection;
  state: LinkState;
  mtuBytes?: number;
  metrics: LinkMetrics;
  connectedAt?: UnixMillis;
  lastStateChangeAt: UnixMillis;
  lastActivityAt?: UnixMillis;
}

export interface RouteHop {
  from: AnywayNodeId;
  to: AnywayNodeId;
  linkId: LinkId;
  transportId: TransportId;
  transportKind: TransportKind;
  linkScore: number;
}

export interface RouteMetrics {
  reliability: number;
  estimatedLatencyMs?: number;
  bottleneckThroughputBytesPerSecond?: number;
  normalizedEnergyCost: number;
  hopCount: number;
}

/** A computed path; it is disposable and must be recomputed as links change. */
export interface Route {
  id: RouteId;
  source: AnywayNodeId;
  destination: AnywayNodeId;
  hops: RouteHop[];
  score: number;
  metrics: RouteMetrics;
  computedAt: UnixMillis;
}

export type MessageDestination =
  | { kind: 'broadcast' }
  | { kind: 'direct'; nodeId: AnywayNodeId }
  | { kind: 'group'; groupId: string };

export type MessagePriority = 'normal' | 'important' | 'sos';

export const MESSAGE_PRIORITY_RANK: Readonly<Record<MessagePriority, number>> = {
  normal: 0,
  important: 1,
  sos: 2,
};

export type MessageDeliveryState =
  | 'created'
  | 'stored'
  | 'pending'
  | 'forwarded'
  | 'received'
  | 'delivered'
  | 'expired'
  | 'failed';

/** GNSS coordinates remain useful without an online map. */
export interface GeoLocation {
  latitude: number;
  longitude: number;
  /** Absent when Android returned a fix without a trustworthy accuracy. */
  accuracyMeters?: number;
  acquiredAt: UnixMillis;
  altitudeMeters?: number;
  altitudeAccuracyMeters?: number;
  headingDegrees?: number;
  speedMetersPerSecond?: number;
  provider?: 'gnss' | 'network' | 'fused' | 'unknown';
}
