import {
  CORE_PROTOCOL_VERSION,
  decodeEnvelope as decodeCoreEnvelope,
  encodeEnvelope as encodeCoreEnvelope,
  MessageDestination,
  RelayableEnvelope,
} from '../core';

export const PROTOCOL_VERSION = CORE_PROTOCOL_VERSION;
export const DEFAULT_TTL = 5;
export const ANNOUNCE_INTERVAL_MS = 20 * 1000;

export type MeshTarget = MessageDestination;
export type MeshEnvelope = RelayableEnvelope;

export const encodeCoreMeshEnvelope = encodeCoreEnvelope;
export const decodeCoreMeshEnvelope = decodeCoreEnvelope;

/**
 * Compatibility-only view of the beta text envelope. The durable DTN layer
 * no longer writes these records; outbox.ts uses this shape solely to reject
 * and remove pre-Anyway beta data from AsyncStorage.
 */
export type TextEnvelope = {
  v: typeof PROTOCOL_VERSION;
  type: 'text';
  id: string;
  ttl: number;
  hops: number;
  senderId: string;
  senderName: string;
  senderColor: string;
  ts: number;
  to: MeshTarget;
  text: string;
  path: string[];
};

export function encodeEnvelope(envelope: TextEnvelope): string {
  return JSON.stringify(envelope);
}

export function decodeEnvelope(encoded: string): TextEnvelope | null {
  try {
    const value = JSON.parse(encoded) as Partial<TextEnvelope>;
    if (
      value.v !== PROTOCOL_VERSION ||
      value.type !== 'text' ||
      typeof value.id !== 'string' ||
      typeof value.text !== 'string' ||
      !Array.isArray(value.path)
    ) {
      return null;
    }
    return value as TextEnvelope;
  } catch {
    return null;
  }
}
