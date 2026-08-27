import { MeshTarget } from './protocol';
import { Conversation, KnownPeer } from './types';

export function conversationTitle(
  conversation: Conversation,
  knownPeers: Record<string, KnownPeer>
): string {
  if (conversation.kind === 'broadcast') return 'Canal público';
  if (conversation.kind === 'group') return conversation.groupName ?? 'Grupo';
  if (conversation.kind === 'direct' && conversation.peerNodeId) {
    return knownPeers[conversation.peerNodeId]?.nickname ?? `Usuario ${conversation.peerNodeId.slice(-5)}`;
  }
  return 'Chat';
}

export function conversationTarget(conversation: Conversation): MeshTarget {
  if (conversation.kind === 'direct' && conversation.peerNodeId) {
    return { kind: 'direct', nodeId: conversation.peerNodeId };
  }
  if (conversation.kind === 'group' && conversation.groupId) {
    return { kind: 'group', groupId: conversation.groupId };
  }
  return { kind: 'broadcast' };
}

export function hopLabel(hops: number): string {
  // Core v1 counts traveled radio links: a direct origin -> recipient
  // delivery has one hop and no intermediary.
  if (hops <= 1) return 'directo';
  return `${hops} saltos · ${hops - 1} relevo${hops - 1 === 1 ? '' : 's'}`;
}

// RSSI-at-1m and path-loss exponent for a rough log-distance estimate. BLE
// RSSI is noisy and varies a lot with antenna orientation/obstacles, so this
// is only meant to give a "getting warmer/colder" sense during a range
// test, never a precise distance — always labeled "(estimado)" in the UI.
const MEASURED_POWER_AT_1M = -59;
const PATH_LOSS_EXPONENT = 2.5;

export function estimateDistanceMeters(rssi: number): number {
  return Math.pow(10, (MEASURED_POWER_AT_1M - rssi) / (10 * PATH_LOSS_EXPONENT));
}

export function formatDistance(rssi: number): string {
  const meters = estimateDistanceMeters(rssi);
  if (meters < 1) return `~${Math.round(meters * 100)} cm`;
  if (meters < 10) return `~${meters.toFixed(1)} m`;
  return `~${Math.round(meters)} m`;
}

export function signalBars(rssi: number): number {
  if (rssi >= -55) return 4;
  if (rssi >= -70) return 3;
  if (rssi >= -85) return 2;
  return 1;
}
