import { NativeModule, requireNativeModule } from 'expo';

import type {
  BleMeshCapabilities,
  BleMeshDiagnosticEvent,
  BleMeshDiagnosticType,
  BleMeshEvents,
  BleMeshLinkDirection,
  BleMeshLinkSnapshot,
  BleMeshLinkState,
  BleMeshPeer,
  BleMeshRadioState,
  BleMeshTransportCapability,
  WifiAwareConnectedPeer,
  WifiAwareDiagnosticEvent,
  WifiAwarePeerEvent,
  WifiAwareProbeResult,
  WifiAwareState,
} from './BleMesh.types';

declare class BleMeshModule extends NativeModule<BleMeshEvents> {
  hasRequiredPermissions(): boolean;
  isBluetoothEnabled(): boolean;
  requestEnableBluetooth(): void;
  start(): boolean;
  stop(): void;
  /** Independent automatic Wi-Fi Aware transport; false means BLE may still run. */
  startWifiAware(localNodeId: string): boolean;
  stopWifiAware(): void;
  getWifiAwareState(): WifiAwareState;
  getConnectedWifiAwarePeers(): WifiAwareConnectedPeer[];
  sendToWifiAwarePeer(endpointId: string, base64Data: string): Promise<boolean>;
  disconnectWifiAwarePeer(endpointId: string): void;
  isPowerSaveMode(): boolean;
  getRadioState(): BleMeshRadioState;
  getCapabilities(): BleMeshCapabilities;
  getLinkSnapshots(): BleMeshLinkSnapshot[];
  getConnectedPeers(): BleMeshPeer[];
  sendToPeer(address: string, base64Data: string): Promise<boolean>;
  /** Hangs up one endpoint; used to drop a duplicate link to an already-bound peer. */
  disconnectPeer(address: string): void;
  /**
   * Attaches a real Wi-Fi Aware session and tries to discover another Anyway
   * phone, without opening a data path. Reports how far it actually got, so the
   * hardware question is answered with evidence rather than a capability flag.
   */
  probeWifiAware(timeoutMs: number): Promise<WifiAwareProbeResult>;
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): void;
}

export default requireNativeModule<BleMeshModule>('BleMesh');
export type {
  BleMeshCapabilities,
  BleMeshDiagnosticEvent,
  BleMeshDiagnosticType,
  BleMeshEvents,
  BleMeshLinkDirection,
  BleMeshLinkSnapshot,
  BleMeshLinkState,
  BleMeshPeer,
  BleMeshRadioState,
  BleMeshTransportCapability,
  WifiAwareConnectedPeer,
  WifiAwareDiagnosticEvent,
  WifiAwarePeerEvent,
  WifiAwareProbeResult,
  WifiAwareState,
};
