import type {
  GeoLocation,
  MessageDeliveryState,
  MessagePriority,
  NodeCapabilities,
} from '../core';
import type { PublicIdentity } from '../security';
import type { MeshTarget, TextEnvelope } from './protocol';

export type ConversationKind = 'broadcast' | 'direct' | 'group';

export const BROADCAST_CONVERSATION_ID = 'broadcast';

export function directConversationId(nodeId: string): string {
  return `dm:${nodeId}`;
}

export function groupConversationId(groupId: string): string {
  return `group:${groupId}`;
}

export type Conversation = {
  id: string;
  kind: ConversationKind;
  /** direct only */
  peerNodeId?: string;
  /** group only */
  groupId?: string;
  groupName?: string;
  memberIds?: string[];
  /** Group membership authority. Only this signed identity may advance revision. */
  ownerNodeId?: string;
  revision?: number;
  unreadCount: number;
};

/**
 * Presentation record. The signed/relayable envelope is kept separately in
 * PersistentMessageStore; plaintext is only copied here on an endpoint that
 * is allowed to display it.
 */
export type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  senderColor: string;
  ts: number;
  createdAt: number;
  storedAt: number;
  sentAt?: number;
  receivedAt?: number;
  to: MeshTarget;
  text: string;
  /** UI-compatible relay count: 0 means one direct physical hop. */
  hops: number;
  /** Exact protocol hop count, including the first physical link. */
  networkHops: number;
  path: string[];
  priority: MessagePriority;
  state: MessageDeliveryState;
  location?: GeoLocation;
  encrypted: boolean;
  delivered?: boolean;
  /**
   * Sender-only correlation for per-member encrypted group copies. It lives
   * inside the encrypted local presentation store and is never put in a relay
   * header or diagnostic export.
   */
  wireMessageIds?: string[];
};

export type KnownPeer = {
  nodeId: string;
  nickname: string;
  color: string;
  lastSeenTs: number;
  /** Self-attested public identity; local private material is never stored here. */
  identity?: PublicIdentity;
  capabilities?: NodeCapabilities;
  trust?: 'key-observed' | 'verified';
};

/** Deprecated beta outbox shape, retained only so old persisted data can be discarded. */
export type OutboxEntry = {
  envelope: TextEnvelope;
  addedAt: number;
};

export type DemoEvent =
  | { kind: 'peer-connected'; address: string; ts: number }
  | { kind: 'peer-disconnected'; address: string; ts: number }
  | {
      kind: 'message-seen';
      messageId: string;
      hops: number;
      path: string[];
      wasForMe: boolean;
      ts: number;
    };
