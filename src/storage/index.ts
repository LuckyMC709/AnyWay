import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';

import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from '../mesh/base64';
import { Conversation, ChatMessage, KnownPeer, OutboxEntry } from '../mesh/types';

const KEYS = {
  nodeId: 'anyway:legacyNodeId',
  nickname: 'anyway:nickname',
  ttl: 'anyway:hopLimit',
  color: 'anyway:color',
  meshEnabled: 'anyway:meshEnabled:v1',
  // v1 key, superseded by messagesByConversation below. Never read; only
  // ever removed, so old data can't crash a v2 load.
  legacyMessages: 'anyway:legacyMessages',
  conversations: 'anyway:conversations:v1',
  messagesByConversation: 'anyway:messagesByConversation:v1',
  knownPeers: 'anyway:knownPeers:v1',
  outbox: 'anyway:legacyOutbox:v1',
} as const;

const MAX_STORED_MESSAGES_PER_CONVERSATION = 300;
const MAX_KNOWN_PEERS = 200;
// SecureStore keys must match /^[\w.-]+$/; a ':' throws on read and write alike.
// AsyncStorage keys above have no such restriction, which is why only this one
// needed the dot-separated form.
const LOCAL_MESSAGE_KEY = 'anyway.local-message-key.v1';
const ENCRYPTED_PREFIX = 'secretbox-v1:';

async function getLocalMessageKey(): Promise<Uint8Array> {
  const stored = await SecureStore.getItemAsync(LOCAL_MESSAGE_KEY);
  if (stored) {
    const decoded = base64ToBytes(stored);
    if (decoded.length === nacl.secretbox.keyLength) return decoded;
  }
  const created = Crypto.getRandomBytes(nacl.secretbox.keyLength);
  await SecureStore.setItemAsync(LOCAL_MESSAGE_KEY, bytesToBase64(created), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return created;
}

async function encryptLocalJson(value: unknown): Promise<string> {
  const key = await getLocalMessageKey();
  const nonce = Crypto.getRandomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(
    Uint8Array.from(utf8Encode(JSON.stringify(value))),
    nonce,
    key,
  );
  return `${ENCRYPTED_PREFIX}${bytesToBase64(nonce)}:${bytesToBase64(ciphertext)}`;
}

async function decryptLocalJson<T>(raw: string): Promise<T | null> {
  if (!raw.startsWith(ENCRYPTED_PREFIX)) return null;
  try {
    const [nonceBase64, ciphertextBase64] = raw.slice(ENCRYPTED_PREFIX.length).split(':');
    if (!nonceBase64 || !ciphertextBase64) return null;
    const key = await getLocalMessageKey();
    const opened = nacl.secretbox.open(
      base64ToBytes(ciphertextBase64),
      base64ToBytes(nonceBase64),
      key,
    );
    if (!opened) return null;
    return JSON.parse(utf8Decode(opened)) as T;
  } catch {
    return null;
  }
}

async function readEncryptedOrMigrate<T>(
  key: string,
  fallback: T,
  sanitize: (value: unknown) => T,
): Promise<T> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return fallback;
  const decrypted = await decryptLocalJson<unknown>(raw);
  if (decrypted !== null) return sanitize(decrypted);

  // One-way migration from pre-encryption development data. A malformed
  // encrypted record never falls through to plaintext JSON parsing.
  if (raw.startsWith(ENCRYPTED_PREFIX)) return fallback;
  try {
    const migrated = sanitize(JSON.parse(raw) as unknown);
    await AsyncStorage.setItem(key, await encryptLocalJson(migrated));
    return migrated;
  } catch {
    return fallback;
  }
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isMeshTarget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'broadcast') return true;
  if (value.kind === 'direct') return typeof value.nodeId === 'string' && value.nodeId.length <= 128;
  return value.kind === 'group' && typeof value.groupId === 'string' && value.groupId.length <= 128;
}

function isStoredLocation(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.latitude === 'number' &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    typeof value.longitude === 'number' &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    isFiniteTimestamp(value.acquiredAt) &&
    (value.accuracyMeters === undefined ||
      (typeof value.accuracyMeters === 'number' &&
        Number.isFinite(value.accuracyMeters) &&
        value.accuracyMeters >= 0))
  );
}

function sanitizeConversations(value: unknown): Record<string, Conversation> {
  if (!isRecord(value)) return {};
  const result: Record<string, Conversation> = {};
  for (const [key, candidate] of Object.entries(value).slice(0, 250)) {
    if (
      !isRecord(candidate) ||
      candidate.id !== key ||
      (candidate.kind !== 'broadcast' && candidate.kind !== 'direct' && candidate.kind !== 'group') ||
      !Number.isSafeInteger(candidate.unreadCount) ||
      (candidate.unreadCount as number) < 0
    ) {
      continue;
    }
    if (candidate.kind === 'direct' && typeof candidate.peerNodeId !== 'string') continue;
    if (
      candidate.kind === 'group' &&
      (typeof candidate.groupId !== 'string' ||
        typeof candidate.groupName !== 'string' ||
        !Array.isArray(candidate.memberIds) ||
        candidate.memberIds.length > 200 ||
        !candidate.memberIds.every((item) => typeof item === 'string'))
    ) {
      continue;
    }
    result[key] = candidate as Conversation;
  }
  return result;
}

function sanitizeChatMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value)) return null;
  const states = new Set([
    'created',
    'stored',
    'pending',
    'forwarded',
    'received',
    'delivered',
    'expired',
    'failed',
  ]);
  if (
    typeof value.id !== 'string' ||
    typeof value.senderId !== 'string' ||
    typeof value.senderName !== 'string' ||
    typeof value.senderColor !== 'string' ||
    typeof value.text !== 'string' ||
    value.text.length > 32_768 ||
    !isFiniteTimestamp(value.ts) ||
    !isFiniteTimestamp(value.createdAt) ||
    !isFiniteTimestamp(value.storedAt) ||
    (value.sentAt !== undefined && !isFiniteTimestamp(value.sentAt)) ||
    (value.receivedAt !== undefined && !isFiniteTimestamp(value.receivedAt)) ||
    !isMeshTarget(value.to) ||
    !Number.isSafeInteger(value.hops) ||
    (value.hops as number) < 0 ||
    !Number.isSafeInteger(value.networkHops) ||
    (value.networkHops as number) < 0 ||
    !Array.isArray(value.path) ||
    value.path.length > 33 ||
    !value.path.every((item) => typeof item === 'string') ||
    (value.priority !== 'normal' && value.priority !== 'important' && value.priority !== 'sos') ||
    typeof value.state !== 'string' ||
    !states.has(value.state) ||
    typeof value.encrypted !== 'boolean' ||
    (value.delivered !== undefined && typeof value.delivered !== 'boolean') ||
    (value.wireMessageIds !== undefined &&
      (!Array.isArray(value.wireMessageIds) ||
        value.wireMessageIds.length > 64 ||
        !value.wireMessageIds.every((item) => typeof item === 'string'))) ||
    (value.location !== undefined && !isStoredLocation(value.location))
  ) {
    return null;
  }
  return value as ChatMessage;
}

function sanitizeMessages(value: unknown): Record<string, ChatMessage[]> {
  if (!isRecord(value)) return {};
  const result: Record<string, ChatMessage[]> = {};
  for (const [conversationId, list] of Object.entries(value).slice(0, 250)) {
    if (!Array.isArray(list)) continue;
    result[conversationId] = list
      .slice(-MAX_STORED_MESSAGES_PER_CONVERSATION)
      .map(sanitizeChatMessage)
      .filter((item): item is ChatMessage => item !== null);
  }
  return result;
}

function sanitizeKnownPeers(value: unknown): Record<string, KnownPeer> {
  if (!isRecord(value)) return {};
  const result: Record<string, KnownPeer> = {};
  for (const [nodeId, candidate] of Object.entries(value).slice(0, MAX_KNOWN_PEERS)) {
    if (
      !isRecord(candidate) ||
      candidate.nodeId !== nodeId ||
      typeof candidate.nickname !== 'string' ||
      candidate.nickname.length > 64 ||
      typeof candidate.color !== 'string' ||
      !isFiniteTimestamp(candidate.lastSeenTs)
    ) {
      continue;
    }
    result[nodeId] = {
      nodeId,
      nickname: candidate.nickname,
      color: candidate.color,
      lastSeenTs: candidate.lastSeenTs,
      identity: isRecord(candidate.identity)
        ? (candidate.identity as KnownPeer['identity'])
        : undefined,
      trust:
        candidate.trust === 'key-observed' || candidate.trust === 'verified'
          ? candidate.trust
          : undefined,
      // Capabilities are runtime observations and are intentionally dropped
      // on hydration unless received again from an authenticated peer. This
      // avoids trusting a corrupt/unversioned AsyncStorage object as live
      // hardware evidence.
      capabilities: undefined,
    };
  }
  return result;
}

export async function discardLegacyV1Data(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEYS.legacyMessages);
  } catch {
    // best-effort cleanup, never fatal
  }
}

export async function getStoredNodeId(): Promise<string | null> {
  return AsyncStorage.getItem(KEYS.nodeId);
}

export async function setStoredNodeId(nodeId: string): Promise<void> {
  await AsyncStorage.setItem(KEYS.nodeId, nodeId);
}

export async function getStoredNickname(): Promise<string | null> {
  return AsyncStorage.getItem(KEYS.nickname);
}

export async function setStoredNickname(nickname: string): Promise<void> {
  await AsyncStorage.setItem(KEYS.nickname, nickname);
}

export async function getStoredTtl(): Promise<number | null> {
  const raw = await AsyncStorage.getItem(KEYS.ttl);
  if (!raw) return null;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

export async function setStoredTtl(ttl: number): Promise<void> {
  await AsyncStorage.setItem(KEYS.ttl, String(ttl));
}

export async function getStoredColor(): Promise<string | null> {
  return AsyncStorage.getItem(KEYS.color);
}

export async function setStoredColor(color: string): Promise<void> {
  await AsyncStorage.setItem(KEYS.color, color);
}

/** Defaults to enabled so opening/installing Anyway remains open-and-use. */
export async function getStoredMeshEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(KEYS.meshEnabled)) !== 'false';
}

export async function setStoredMeshEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(KEYS.meshEnabled, enabled ? 'true' : 'false');
}

export async function getStoredConversations(): Promise<Record<string, Conversation>> {
  return readEncryptedOrMigrate(KEYS.conversations, {}, sanitizeConversations);
}

export async function setStoredConversations(
  conversations: Record<string, Conversation>
): Promise<void> {
  await AsyncStorage.setItem(KEYS.conversations, await encryptLocalJson(conversations));
}

export async function getStoredMessagesByConversation(): Promise<
  Record<string, ChatMessage[]>
> {
  return readEncryptedOrMigrate(KEYS.messagesByConversation, {}, sanitizeMessages);
}

export async function setStoredMessagesByConversation(
  messages: Record<string, ChatMessage[]>
): Promise<void> {
  const trimmed: Record<string, ChatMessage[]> = {};
  for (const [id, list] of Object.entries(messages)) {
    trimmed[id] = list.slice(-MAX_STORED_MESSAGES_PER_CONVERSATION);
  }
  await AsyncStorage.setItem(KEYS.messagesByConversation, await encryptLocalJson(trimmed));
}

export async function getStoredKnownPeers(): Promise<Record<string, KnownPeer>> {
  return readEncryptedOrMigrate(KEYS.knownPeers, {}, sanitizeKnownPeers);
}

export async function setStoredKnownPeers(peers: Record<string, KnownPeer>): Promise<void> {
  const entries = Object.values(peers)
    .sort((a, b) => b.lastSeenTs - a.lastSeenTs)
    .slice(0, MAX_KNOWN_PEERS);
  const trimmed: Record<string, KnownPeer> = {};
  entries.forEach((p) => {
    trimmed[p.nodeId] = p;
  });
  await AsyncStorage.setItem(KEYS.knownPeers, await encryptLocalJson(trimmed));
}

export async function getStoredOutbox(): Promise<OutboxEntry[]> {
  return readJson(KEYS.outbox, []);
}

export async function setStoredOutbox(entries: OutboxEntry[]): Promise<void> {
  await AsyncStorage.setItem(KEYS.outbox, JSON.stringify(entries));
}

/** Wipes message history only — conversation/group memberships and known
 *  contacts are kept, matching "clear history" rather than "start over". */
export async function clearStoredMessages(): Promise<void> {
  await AsyncStorage.removeItem(KEYS.messagesByConversation);
}
