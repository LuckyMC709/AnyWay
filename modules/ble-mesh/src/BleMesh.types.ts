export type BleMeshPeer = {
  address: string;
  /** Null when this peer connected inbound before it was observed by scan. */
  rssi: number | null;
};

export type BleMeshTransportCapability = {
  supported: boolean;
  automaticTransport: boolean;
  reportOnly?: boolean;
};

export type BleMeshCapabilities = {
  apiLevel: number;
  manufacturer: string;
  model: string;
  activeTransport: 'ble';
  serviceUuid: string;
  characteristicUuid: string;
  maxLogicalLinks: number;
  maxConcurrentConnectGatt: 1;
  /** Guaranteed by Anyway's 16-bit fragment header even at the default MTU 23. */
  baselineMaxMessageBytes: number;
  lifecycle: {
    owner: 'radio-process-runtime';
    radioReactBridgeIndependent: true;
    radioStickyServiceRestorationConfigured: true;
    /** Routing/store-and-forward still needs the JS runtime. */
    messagingHeadlessDurable: false;
    survivesForceStop: false;
    survivesReboot: false;
    requiresRestartAfterBluetoothOff: true;
  };
  ble: {
    supported: boolean;
    enabled: boolean;
    permissionsGranted: boolean;
    scanningSupported: boolean;
    scanningAvailable: boolean;
    advertisingSupported: boolean;
    advertisingAvailable: boolean;
    automaticTransport: true;
  };
  /** Reported for topology planning only; never selected automatically. */
  wifiAware: BleMeshTransportCapability & { available: boolean };
  /** Reported for topology planning only; never selected automatically. */
  wifiDirect: BleMeshTransportCapability;
};

export type BleMeshLinkState =
  | 'candidate'
  | 'backoff'
  | 'connecting'
  | 'negotiating'
  | 'incoming-negotiating'
  | 'ready';

export type BleMeshLinkDirection = 'none' | 'outgoing' | 'incoming' | 'bidirectional';

export type BleMeshLinkSnapshot = {
  address: string;
  transport: 'ble';
  state: BleMeshLinkState;
  direction: BleMeshLinkDirection;
  logical: boolean;
  slotReserved: boolean;
  outgoingReady: boolean;
  incomingReady: boolean;
  outgoingConnected: boolean;
  incomingConnected: boolean;
  connectGattInFlight: boolean;
  rssi: number | null;
  failureCount: number;
  nextRetryInMs: number;
  firstSeenAgeMs?: number;
  lastSeenAgeMs?: number;
  lastAttemptAgeMs?: number;
  lastFailureStage?: string;
  /** Conservative minimum when both GATT directions are ready. */
  mtu?: number;
  outgoingMtu?: number;
  incomingMtu?: number;
};

export type BleMeshDiagnosticType =
  | 'candidate-added'
  | 'candidate-expired'
  | 'connection-attempt-started'
  | 'connection-backoff'
  | 'outgoing-link-ready'
  | 'incoming-link-ready'
  | 'incoming-disconnected'
  | 'incoming-subscription-timeout'
  | 'incoming-rejected-budget'
  | 'link-budget-full'
  | 'reassembly-expired'
  // Trace points across the previously unobservable server-notify path
  // (peripheral -> central), where a delivery failure left no evidence at all.
  | 'server-notify-dispatched'
  | 'server-notify-rejected'
  | 'server-notify-confirmed'
  | 'notification-received'
  | 'notification-dropped'
  | 'message-assembled'
  | 'duplicate-link-dropped'
  | 'mtu-negotiated';

export type BleMeshDiagnosticEvent = {
  type: BleMeshDiagnosticType;
  timestampMs: number;
  generation: number;
  transport: 'ble';
  logicalLinks: number;
  occupiedLinkSlots: number;
  linkBudget: number;
  candidateCount: number;
  connectGattInFlight: boolean;
  deferredMessages: number;
  address?: string;
  rssi?: number;
  failureCount?: number;
  retryInMs?: number;
  stage?: string;
  count?: number;
};

export type BleMeshRadioState = {
  bluetoothEnabled: boolean;
  hasPermissions: boolean;
  starting: boolean;
  running: boolean;
  advertising: boolean;
  scanning: boolean;
  gattServerReady: boolean;
  generation: number;
  connectedPeers: number;
  outgoingConnections: number;
  incomingConnections: number;
  logicalLinks?: number;
  logicalLinkBudget?: number;
  occupiedLinkSlots?: number;
  candidateCount?: number;
  connectGattInFlight?: boolean;
  deferredMessages?: number;
  restoredByForegroundService?: boolean;
  foregroundServiceActive?: boolean;
  error?: number;
  scanError?: number;
  advertisingError?: number;
  gattError?: number;
  gattFailureStage?: string;
  startError?: string;
  failureStage?: string;
  phase?: 'advertising' | 'scanning' | 'startup';
};

export type BleMeshEvents = {
  onPeerDiscovered: (event: { address: string; rssi: number }) => void;
  onPeerConnected: (event: { address: string }) => void;
  onPeerDisconnected: (event: { address: string }) => void;
  onMessageReceived: (event: { address: string; data: string }) => void;
  onAdapterStateChanged: (event: BleMeshRadioState) => void;
  onDiagnostic: (event: BleMeshDiagnosticEvent) => void;
  onWifiAwarePeerDiscovered: (event: WifiAwarePeerEvent) => void;
  onWifiAwarePeerConnected: (event: WifiAwarePeerEvent) => void;
  onWifiAwarePeerDisconnected: (event: {
    endpointId: string;
    nodeIdHint: string;
    role?: WifiAwarePeerEvent['role'];
    stage?: string;
  }) => void;
  onWifiAwareMessageReceived: (event: {
    endpointId: string;
    nodeIdHint: string;
    data: string;
  }) => void;
  onWifiAwareStateChanged: (event: WifiAwareState) => void;
  onWifiAwareDiagnostic: (event: WifiAwareDiagnosticEvent) => void;
};

export type WifiAwarePeerEvent = {
  /** Opaque process-local endpoint; identity remains untrusted until handshake. */
  endpointId: string;
  nodeIdHint: string;
  role: 'client' | 'server' | 'server-passive';
};

export type WifiAwareState = {
  supported: boolean;
  available: boolean;
  hasPermission: boolean;
  starting: boolean;
  running: boolean;
  attached: boolean;
  publishing: boolean;
  subscribing: boolean;
  generation: number;
  discoveredPeers: number;
  connectedPeers: number;
  powerSaveMode: boolean;
  foregroundServiceActive: boolean;
  maxFrameBytes: number;
  error?: string;
  failureStage?: string;
};

export type WifiAwareConnectedPeer = WifiAwarePeerEvent & {
  connectedAt: number;
  bytesSent: number;
  bytesReceived: number;
};

export type WifiAwareDiagnosticEvent = {
  type: string;
  timestampMs: number;
  generation: number;
  transport: 'wifi-aware';
  endpointId?: string;
  nodeIdHint?: string;
  role?: string;
  detail?: string;
};

/**
 * Outcome of the Wi-Fi Aware reachability probe. The fields are ordered by how
 * far the attempt got, so the first `false` is the answer.
 */
export type WifiAwareProbeResult = {
  /** Hardware declares Wi-Fi Aware. */
  supported: boolean;
  /** The service is usable right now (Wi-Fi on, not blocked by Direct/SoftAP). */
  available: boolean;
  /** The runtime permission Aware needs is granted. */
  permissionGranted: boolean;
  /** A real Aware session was attached. */
  attached: boolean;
  published: boolean;
  subscribed: boolean;
  /** Other Anyway phones actually discovered during the probe window. */
  peersDiscovered: number;
  /** Present only on failure; already phrased for display. */
  error?: string;
};
