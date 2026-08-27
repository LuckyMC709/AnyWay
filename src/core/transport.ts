import {
  AnywayNodeId,
  Link,
  LinkId,
  MessagePriority,
  TransportCapability,
  TransportEndpoint,
  TransportId,
  TransportKind,
  UnixMillis,
} from './model';

export interface TransportDescriptor {
  id: TransportId;
  kind: TransportKind;
  displayName: string;
}

export interface TransportContext {
  localNodeId: AnywayNodeId;
  protocolVersions: readonly number[];
  identityHint?: string;
}

export interface DiscoveredTransportPeer {
  /** Present only after the transport handshake binds an endpoint to an identity. */
  nodeId?: AnywayNodeId;
  endpoint: TransportEndpoint;
  capabilities?: TransportCapability;
  signal?: number;
}

export interface TransportConnectOptions {
  timeoutMs?: number;
  preferredMtuBytes?: number;
  reason: 'dense-mesh' | 'route-needed' | 'reconnect' | 'user-request';
}

export interface TransportSendOptions {
  priority: MessagePriority;
  expiresAt: UnixMillis;
  /** A transport may skip an already queued duplicate with the same key. */
  idempotencyKey: string;
}

/**
 * This receipt only proves acceptance by the next hop/transport. It must never
 * be surfaced as final delivery to the message destination.
 */
export interface TransportSendReceipt {
  messageId: string;
  linkId: LinkId;
  nextHopId: AnywayNodeId;
  acceptedAt: UnixMillis;
  byteLength: number;
  transportReceiptId?: string;
}

export interface TransportFailure {
  code: string;
  message: string;
  recoverable: boolean;
  linkId?: LinkId;
  endpointId?: string;
  cause?: unknown;
}

export type TransportEvent =
  | { type: 'peer-discovered'; peer: DiscoveredTransportPeer; at: UnixMillis }
  | { type: 'peer-lost'; endpointId: string; nodeId?: AnywayNodeId; at: UnixMillis }
  | { type: 'link-changed'; link: Link; at: UnixMillis }
  | { type: 'frame-received'; linkId: LinkId; bytes: Uint8Array; at: UnixMillis }
  | { type: 'capability-changed'; capability: TransportCapability; at: UnixMillis }
  | { type: 'error'; error: TransportFailure; at: UnixMillis };

export type TransportEventListener = (event: TransportEvent) => void;
export type Unsubscribe = () => void;

/**
 * Adapter boundary between mesh logic and BLE/Wi-Fi/etc. Implementations own
 * platform permissions, discovery cadence, connection queues and framing.
 * Calls should be idempotent where the platform permits it.
 */
export interface AnywayTransport {
  readonly descriptor: TransportDescriptor;

  probeCapability(): Promise<TransportCapability>;
  start(context: TransportContext): Promise<void>;
  stop(): Promise<void>;

  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;

  connect(
    peer: DiscoveredTransportPeer,
    options: TransportConnectOptions,
  ): Promise<Link>;
  disconnect(linkId: LinkId, reason?: string): Promise<void>;

  send(
    linkId: LinkId,
    messageId: string,
    bytes: Uint8Array,
    options: TransportSendOptions,
  ): Promise<TransportSendReceipt>;

  currentLinks(): readonly Link[];
  subscribe(listener: TransportEventListener): Unsubscribe;
}

