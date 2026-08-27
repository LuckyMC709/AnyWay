import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  AnywayNodeId,
  MESSAGE_PRIORITY_RANK,
  MessageDeliveryState,
  MessagePriority,
  TransportId,
  UnixMillis,
} from './model';
import {
  canRelayEnvelope,
  encodedByteLength,
  isExpired,
  ReceiptEnvelope,
  RelayableEnvelope,
  validateEnvelope,
} from './protocol';
import { immutableEnvelopeFingerprint } from './crypto';

const STORE_SCHEMA_VERSION = 2 as const;
const LEGACY_STORE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MESSAGE_STORE_KEY = 'anyway:core:message-store:v1';

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface ForwardReceipt {
  nextHopId: AnywayNodeId;
  messageFingerprint: string;
  acceptedAt: UnixMillis;
  transportId?: TransportId;
  transportReceiptId?: string;
}

export interface FinalDeliveryAck {
  destinationNodeId: AnywayNodeId;
  messageFingerprint: string;
  acknowledgedAt: UnixMillis;
  receiptMessageId?: string;
  verified: boolean;
}

export interface ForwardAttempt {
  nextHopId: AnywayNodeId;
  transportId?: TransportId;
  attemptedAt: UnixMillis;
  /** Accepted by the local transport queue; not necessarily by the peer. */
  accepted: boolean;
  errorCode?: string;
}

/** Durable short lease written before a transport is allowed to send. */
export interface ForwardLease {
  claimId: string;
  nextHopId: AnywayNodeId;
  claimedAt: UnixMillis;
  leaseUntil: UnixMillis;
}

export interface StoredRelayMessage {
  envelope: RelayableEnvelope;
  /** Digest of immutable fields plus the origin's Ed25519 signature. */
  immutableFingerprint: string;
  state: MessageDeliveryState;
  custody: 'originated' | 'relayed' | 'received';
  storedAt: UnixMillis;
  updatedAt: UnixMillis;
  effectiveExpiresAt: UnixMillis;
  byteLength: number;
  duplicateCount: number;
  attempts: ForwardAttempt[];
  forwardLeases: ForwardLease[];
  forwardReceipts: ForwardReceipt[];
  finalAck?: FinalDeliveryAck;
  lastError?: string;
}

export interface SeenTombstone {
  messageId: string;
  originId: AnywayNodeId;
  immutableFingerprint: string;
  kind: RelayableEnvelope['kind'];
  firstSeenAt: UnixMillis;
  lastSeenAt: UnixMillis;
  forgetAt: UnixMillis;
}

interface PersistedMessageStoreState {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  entries: StoredRelayMessage[];
  seen: SeenTombstone[];
  updatedAt: UnixMillis;
}

export interface MessageStoreConfig {
  storageKey: string;
  maxEntries: number;
  maxBytes: number;
  maxEntriesPerOrigin: number;
  maxSeenIds: number;
  dedupRetentionMs: number;
  controlDedupRetentionMs: number;
  retryAfterAcceptedMs: number;
  retryAfterLocalQueueMs: number;
  outboundLeaseMs: number;
  /** Bounded diagnostic history only; reaching it never blocks forwarding. */
  maxAttemptsPerMessage: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
  retryAttemptWindowMs: number;
  maxAttemptsPerPeerWindow: number;
  capabilityRetentionMs: number;
  receiptRetentionMs: number;
  appliedReceiptRetentionMs: number;
  maxFutureClockSkewMs: number;
  retentionByPriorityMs: Readonly<Record<MessagePriority, number>>;
}

export const DEFAULT_MESSAGE_STORE_CONFIG: Readonly<MessageStoreConfig> = {
  storageKey: DEFAULT_MESSAGE_STORE_KEY,
  maxEntries: 512,
  maxBytes: 5 * 1024 * 1024,
  maxEntriesPerOrigin: 96,
  maxSeenIds: 4_096,
  dedupRetentionMs: 7 * 24 * 60 * 60 * 1000,
  controlDedupRetentionMs: 2 * 60 * 60 * 1000,
  retryAfterAcceptedMs: 15 * 60 * 1000,
  retryAfterLocalQueueMs: 45 * 1000,
  // Must comfortably exceed the time a whole flush batch takes to drain, and
  // must never equal the housekeeping prune period (30 s), which it did: a
  // lease taken at the start of a batch expired exactly as the pruner ran, so
  // recordForwardAttempt could not find its claim and returned false for a
  // send that had physically succeeded. Nothing was appended to attempts, no
  // backoff was computed, the retry breaker never counted it, and the same
  // envelope was re-selected and re-transmitted in full on the next sweep.
  // At the 23-byte MTU floor a batch drain of well over 30 s is routine.
  outboundLeaseMs: 5 * 60 * 1000,
  maxAttemptsPerMessage: 128,
  retryBackoffBaseMs: 10 * 1000,
  retryBackoffMaxMs: 15 * 60 * 1000,
  retryAttemptWindowMs: 30 * 60 * 1000,
  maxAttemptsPerPeerWindow: 12,
  capabilityRetentionMs: 10 * 60 * 1000,
  receiptRetentionMs: 2 * 60 * 60 * 1000,
  appliedReceiptRetentionMs: 2 * 60 * 1000,
  maxFutureClockSkewMs: 5 * 60 * 1000,
  retentionByPriorityMs: {
    normal: 24 * 60 * 60 * 1000,
    important: 3 * 24 * 60 * 60 * 1000,
    sos: 7 * 24 * 60 * 60 * 1000,
  },
};

export interface StoreEnvelopeContext {
  now?: UnixMillis;
  receivedFrom?: AnywayNodeId;
  transportId?: TransportId;
  originatedLocally?: boolean;
  isFinalRecipient?: boolean;
  /**
   * Required for network input. It means the provider called
   * `verifyRelayChain`, which also verifies the immutable origin signature.
   */
  relayChainVerified?: boolean;
}

export type StoreEnvelopeResult =
  | { status: 'stored'; entry: StoredRelayMessage }
  | { status: 'duplicate'; entry?: StoredRelayMessage }
  | { status: 'expired' }
  | { status: 'rejected'; reason: string }
  | { status: 'quota-evicted'; reason: string };

export type StoreEnvelopeBatchResult =
  | { status: 'committed'; results: StoreEnvelopeResult[] }
  | { status: 'rejected'; failedIndex: number; results: StoreEnvelopeResult[] };

export interface ForwardCandidate {
  /** Must be supplied back when recording the send outcome. */
  claimId: string;
  entry: StoredRelayMessage;
  /** Durable pre-hop copy. Sign/advance it before every wire transmission. */
  envelope: RelayableEnvelope;
  isDirectToPeer: boolean;
}

export interface ForwardCandidateQuery {
  peerId: AnywayNodeId;
  now?: UnixMillis;
  limit?: number;
  /** Extra control slots; they never consume the requested content limit. */
  controlSlots?: number;
}

export interface StoreEnvelopeBatchItem {
  envelope: RelayableEnvelope;
  context?: StoreEnvelopeContext;
}

export interface ForwardAttemptBatchItem {
  messageId: string;
  attempt: ForwardAttempt;
  transportReceiptId?: string;
  claimId?: string;
  peerConfirmed?: boolean;
}

export type ForwardAttemptBatchResult =
  | { status: 'committed'; results: boolean[] }
  | { status: 'rejected'; failedIndex: number; results: boolean[] };

export interface MessageStoreStats {
  entries: number;
  bytes: number;
  byPriority: Record<MessagePriority, number>;
  pending: number;
  forwarded: number;
  delivered: number;
  seenIds: number;
}

function emptyState(now: number): PersistedMessageStoreState {
  return { schemaVersion: STORE_SCHEMA_VERSION, entries: [], seen: [], updatedAt: now };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function encodedLength(value: unknown): number {
  return encodedByteLength(JSON.stringify(value));
}

function stateIsTerminal(state: MessageDeliveryState): boolean {
  return state === 'delivered' || state === 'expired' || state === 'failed';
}

function evictionValue(entry: StoredRelayMessage): number {
  // Smaller values leave first. Final delivery and control-plane records are
  // cheap to evict; priority dominates age when the store is under pressure.
  const terminalPenalty = stateIsTerminal(entry.state) ? -2_000 : 0;
  const controlPenalty = entry.envelope.kind === 'content' ? 0 : -1_000_000;
  const priorityValue = MESSAGE_PRIORITY_RANK[entry.envelope.priority] * 10_000;
  return priorityValue + terminalPenalty + controlPenalty + entry.storedAt / 1_000_000_000;
}

function effectiveRetentionLimit(
  envelope: RelayableEnvelope,
  config: MessageStoreConfig,
): number {
  if (envelope.kind === 'capability') {
    return envelope.createdAt + config.capabilityRetentionMs;
  }
  if (envelope.kind === 'receipt') {
    return envelope.createdAt + config.receiptRetentionMs;
  }
  return envelope.createdAt + config.retentionByPriorityMs[envelope.priority];
}

function deterministicRetryJitter(seed: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  // Stable factor in [0.8, 1.2], preventing synchronized retry waves without
  // persisting or inventing random state.
  return 0.8 + ((hash >>> 0) % 401) / 1_000;
}

function peerRetryNotBefore(
  entry: StoredRelayMessage,
  peerId: AnywayNodeId,
  now: number,
  config: MessageStoreConfig,
): number {
  const peerAttempts = entry.attempts
    .filter((attempt) => attempt.nextHopId === peerId)
    .sort((left, right) => left.attemptedAt - right.attemptedAt);
  if (peerAttempts.length === 0) return 0;
  const last = peerAttempts[peerAttempts.length - 1];
  let notBefore = 0;
  if (last.accepted) {
    // Content is re-offered briskly because a receipt is what ends the loop.
    // A *receipt* has no such acknowledgement — nothing can ever make it
    // terminal — so on the 45 s content cadence every receipt was re-signed
    // and re-aired roughly every 45 s for its whole two-hour retention. On a
    // two-phone chat that control traffic dwarfs the messages it confirms.
    // Receipts are best-effort: one delivery attempt is the expected case, and
    // this slower cadence still retries if the first one was lost on the air.
    notBefore =
      last.attemptedAt +
      (entry.envelope.kind === 'receipt'
        ? config.retryAfterAcceptedMs
        : config.retryAfterLocalQueueMs);
  } else {
    let consecutiveFailures = 0;
    for (let index = peerAttempts.length - 1; index >= 0; index -= 1) {
      if (peerAttempts[index].accepted) break;
      consecutiveFailures += 1;
    }
    const exponent = Math.min(Math.max(0, consecutiveFailures - 1), 16);
    const baseDelay = Math.min(
      config.retryBackoffMaxMs,
      config.retryBackoffBaseMs * 2 ** exponent,
    );
    const jitter = deterministicRetryJitter(
      `${entry.envelope.messageId}:${peerId}:${consecutiveFailures}`,
    );
    notBefore = last.attemptedAt + Math.round(baseDelay * jitter);
  }

  const inWindow = peerAttempts.filter(
    (attempt) => now - attempt.attemptedAt < config.retryAttemptWindowMs,
  );
  if (inWindow.length >= config.maxAttemptsPerPeerWindow) {
    const windowRelease = inWindow[0].attemptedAt + config.retryAttemptWindowMs;
    notBefore = Math.max(notBefore, windowRelease);
  }
  return notBefore;
}

function sanitizeAttempt(value: unknown): ForwardAttempt | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.nextHopId !== 'string' ||
    !isFiniteNumber(value.attemptedAt) ||
    typeof value.accepted !== 'boolean'
  ) {
    return null;
  }
  return {
    nextHopId: value.nextHopId,
    attemptedAt: value.attemptedAt,
    accepted: value.accepted,
    transportId: typeof value.transportId === 'string' ? value.transportId : undefined,
    errorCode: typeof value.errorCode === 'string' ? value.errorCode : undefined,
  };
}

function sanitizeForwardReceipt(value: unknown): ForwardReceipt | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.nextHopId !== 'string' ||
    typeof value.messageFingerprint !== 'string' ||
    !isFiniteNumber(value.acceptedAt)
  ) return null;
  return {
    nextHopId: value.nextHopId,
    messageFingerprint: value.messageFingerprint,
    acceptedAt: value.acceptedAt,
    transportId: typeof value.transportId === 'string' ? value.transportId : undefined,
    transportReceiptId:
      typeof value.transportReceiptId === 'string' ? value.transportReceiptId : undefined,
  };
}

function sanitizeForwardLease(value: unknown, now: number): ForwardLease | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.claimId !== 'string' ||
    typeof value.nextHopId !== 'string' ||
    !isFiniteNumber(value.claimedAt) ||
    !isFiniteNumber(value.leaseUntil) ||
    value.leaseUntil <= now
  ) {
    return null;
  }
  return {
    claimId: value.claimId,
    nextHopId: value.nextHopId,
    claimedAt: value.claimedAt,
    leaseUntil: value.leaseUntil,
  };
}

function sanitizeFinalAck(value: unknown): FinalDeliveryAck | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.destinationNodeId !== 'string' ||
    typeof value.messageFingerprint !== 'string' ||
    !isFiniteNumber(value.acknowledgedAt) ||
    typeof value.verified !== 'boolean'
  ) {
    return undefined;
  }
  return {
    destinationNodeId: value.destinationNodeId,
    messageFingerprint: value.messageFingerprint,
    acknowledgedAt: value.acknowledgedAt,
    verified: value.verified,
    receiptMessageId:
      typeof value.receiptMessageId === 'string' ? value.receiptMessageId : undefined,
  };
}

/**
 * Persistent bounded DTN repository. It stores every valid relayable envelope,
 * including opaque private payloads, until expiry/ack/quota policy says otherwise.
 */
export class PersistentMessageStore {
  private readonly config: MessageStoreConfig;
  private readonly storage: KeyValueStorage;
  private state: PersistedMessageStoreState = emptyState(Date.now());
  private durableState: PersistedMessageStoreState = clone(this.state);
  private loaded = false;
  private operationQueue: Promise<void> = Promise.resolve();
  private nextClaimSequence = 1;

  constructor(
    private readonly localNodeId: AnywayNodeId,
    options: {
      storage?: KeyValueStorage;
      config?: Partial<MessageStoreConfig>;
    } = {},
  ) {
    this.storage = options.storage ?? AsyncStorage;
    this.config = {
      ...DEFAULT_MESSAGE_STORE_CONFIG,
      ...options.config,
      retentionByPriorityMs: {
        ...DEFAULT_MESSAGE_STORE_CONFIG.retentionByPriorityMs,
        ...options.config?.retentionByPriorityMs,
      },
    };
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      await this.loadUnsafe();
    });
  }

  async storeEnvelope(
    envelope: RelayableEnvelope,
    context: StoreEnvelopeContext = {},
  ): Promise<StoreEnvelopeResult> {
    return this.enqueue(async () => {
      await this.loadUnsafe();
      const now = context.now ?? Date.now();
      const result = this.storeEnvelopeUnsafe(envelope, context, now);
      if (result.status !== 'rejected') await this.persistUnsafe(now);
      return result;
    });
  }

  /**
   * Store a logical batch with one durable commit. Rejection/expiry/quota of
   * any member rolls the complete in-memory mutation back; duplicates count as
   * already satisfied, which makes retrying an interrupted group idempotent.
   */
  async storeEnvelopesAtomically(
    items: readonly StoreEnvelopeBatchItem[],
  ): Promise<StoreEnvelopeBatchResult> {
    return this.enqueue(async () => {
      await this.loadUnsafe();
      if (items.length === 0) return { status: 'committed', results: [] };
      const before = clone(this.state);
      const results: StoreEnvelopeResult[] = [];
      let latestNow = 0;
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const now = item.context?.now ?? Date.now();
        latestNow = Math.max(latestNow, now);
        const result = this.storeEnvelopeUnsafe(item.envelope, item.context ?? {}, now);
        results.push(result);
        if (result.status !== 'stored' && result.status !== 'duplicate') {
          this.state = before;
          return { status: 'rejected', failedIndex: index, results };
        }
      }
      for (let index = 0; index < items.length; index += 1) {
        if (results[index].status !== 'stored') continue;
        const fingerprint = immutableEnvelopeFingerprint(items[index].envelope);
        const remainsDurable = this.state.entries.some(
          (entry) =>
            entry.envelope.messageId === items[index].envelope.messageId &&
            entry.immutableFingerprint === fingerprint,
        );
        if (!remainsDurable) {
          this.state = before;
          return {
            status: 'rejected',
            failedIndex: index,
            results: [
              ...results.slice(0, index),
              { status: 'quota-evicted', reason: 'Atomic batch exceeded local quotas.' },
            ],
          };
        }
      }
      await this.persistUnsafe(latestNow || Date.now());
      return { status: 'committed', results };
    });
  }

  async getForwardCandidates(query: ForwardCandidateQuery): Promise<ForwardCandidate[]> {
    return this.enqueue(async () => {
      await this.loadUnsafe();
      const now = query.now ?? Date.now();
      const changed = this.pruneUnsafe(now);
      if (changed) await this.persistUnsafe(now);
      const limit = Math.max(1, Math.min(query.limit ?? 64, 256));
      // Receipts ride in these slots, and a receipt is what stops the sender
      // from re-offering the same content on the next sweep. Two slots per
      // flush made a burst of messages settle over several sweeps, each delay
      // paying for another redundant transmission.
      const controlSlots = Math.max(0, Math.min(query.controlSlots ?? 4, 8));

      const candidates: Array<Omit<ForwardCandidate, 'claimId'>> = [];
      for (const entry of this.state.entries) {
        if (entry.finalAck || stateIsTerminal(entry.state)) continue;
        const relayDecision = canRelayEnvelope(
          entry.envelope,
          this.localNodeId,
          query.peerId,
          now,
        );
        if (!relayDecision.allowed) continue;
        // A *verified* custody receipt is a durable fact: that peer took the
        // message and owns forwarding it. Expiring the suppression after 15
        // minutes re-aired the same content to the same peer roughly a hundred
        // times over a 24 h TTL — and each airing drew a fresh signed receipt
        // back. It only looked bounded on a direct pair, where the final ack
        // makes the entry terminal; broadcasts, groups and SOS have no final
        // ack and paid it for their whole lifetime.
        //
        // Dropping the time bound is safe against forged custody:
        // applyReceiptUnsafe refuses to record a receipt with no matching
        // accepted attempt or live lease of ours, and the entry is still
        // offered to every *other* peer, which is what keeps the mesh able to
        // route around a relay that took custody and then vanished.
        const custodyAccepted = entry.forwardReceipts.some(
          (receipt) =>
            receipt.nextHopId === query.peerId &&
            receipt.messageFingerprint === entry.immutableFingerprint,
        );
        if (custodyAccepted) continue;
        if (now < peerRetryNotBefore(entry, query.peerId, now, this.config)) continue;
        const activeLease = entry.forwardLeases.some(
          (lease) => lease.nextHopId === query.peerId && lease.leaseUntil > now,
        );
        if (activeLease) continue;

        candidates.push({
          // Held by reference through sorting and slicing. Deep-copying every
          // eligible entry here cloned the whole backlog on each flush and then
          // threw away all but `limit` of the copies, so the cost grew with
          // stored history rather than with what was actually sent. The
          // survivors are cloned below, once the selection is known.
          entry,
          // This remains the durable custody form ending at localNodeId. The
          // provider signs/appends a fresh hop attestation immediately before
          // each actual transport send.
          envelope: entry.envelope,
          isDirectToPeer:
            entry.envelope.destination.kind === 'direct' &&
            entry.envelope.destination.nodeId === query.peerId,
        });
      }

      const sortCandidates = (
        left: Omit<ForwardCandidate, 'claimId'>,
        right: Omit<ForwardCandidate, 'claimId'>,
      ): number => {
          if (left.isDirectToPeer !== right.isDirectToPeer) {
            return left.isDirectToPeer ? -1 : 1;
          }
          const priorityDelta =
            MESSAGE_PRIORITY_RANK[right.envelope.priority] -
            MESSAGE_PRIORITY_RANK[left.envelope.priority];
          if (priorityDelta !== 0) return priorityDelta;
          if (left.entry.attempts.length !== right.entry.attempts.length) {
            return left.entry.attempts.length - right.entry.attempts.length;
          }
          return left.envelope.expiresAt - right.envelope.expiresAt;
      };
      const content = candidates
        .filter((candidate) => candidate.envelope.kind === 'content')
        .sort(sortCandidates)
        .slice(0, limit);
      const control = candidates
        .filter((candidate) => candidate.envelope.kind !== 'content')
        .sort((left, right) => {
          // Delivery/custody receipts must not be starved by the periodic
          // capability stream. BLE peers authenticate through the separate
          // nonce handshake and every relayed envelope is self-verifiable.
          if (left.envelope.kind !== right.envelope.kind) {
            return left.envelope.kind === 'receipt' ? -1 : 1;
          }
          return sortCandidates(left, right);
        })
        .slice(0, controlSlots);
      // Content is emitted first. Self-contained relay certificates remove the
      // old need to send capability records ahead of authenticated user data.
      const selected = [...content, ...control];

      if (selected.length === 0) return [];
      const claimed = selected.map((candidate): ForwardCandidate => {
        const claimId = `${this.localNodeId}:${now}:${this.nextClaimSequence++}:${candidate.envelope.messageId}`;
        const liveEntry = this.state.entries.find(
          (entry) => entry.envelope.messageId === candidate.envelope.messageId,
        );
        if (!liveEntry) {
          throw new Error('Forward candidate disappeared while acquiring durable lease.');
        }
        liveEntry.forwardLeases.push({
          claimId,
          nextHopId: query.peerId,
          claimedAt: now,
          leaseUntil: now + this.config.outboundLeaseMs,
        });
        liveEntry.state = liveEntry.state === 'stored' ? 'pending' : liveEntry.state;
        liveEntry.updatedAt = now;
        return {
          ...candidate,
          claimId,
          envelope: clone(liveEntry.envelope),
          entry: clone(liveEntry),
        };
      });
      // This await is the persist-before-send boundary. Callers receive no
      // candidate until the envelope and its outbound claim are durable.
      await this.persistUnsafe(now);
      return claimed;
    });
  }

  async recordForwardAttempt(
    messageId: string,
    attempt: ForwardAttempt,
    transportReceiptId?: string,
    claimId?: string,
    /** True only when the transport itself authenticated remote acceptance. */
    peerConfirmed = false,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      await this.loadUnsafe();
      const changed = this.recordForwardAttemptUnsafe(
        messageId,
        attempt,
        transportReceiptId,
        claimId,
        peerConfirmed,
      );
      if (!changed) return false;
      await this.persistUnsafe(attempt.attemptedAt);
      return true;
    });
  }

  /** Apply many transport outcomes with one durable snapshot/fsync. */
  async recordForwardAttemptsAtomically(
    items: readonly ForwardAttemptBatchItem[],
  ): Promise<ForwardAttemptBatchResult> {
    return this.enqueue(async () => {
      await this.loadUnsafe();
      if (items.length === 0) return { status: 'committed', results: [] };
      const before = clone(this.state);
      const results: boolean[] = [];
      let latestAttemptAt = 0;
      for (const item of items) {
        latestAttemptAt = Math.max(latestAttemptAt, item.attempt.attemptedAt);
        results.push(
          this.recordForwardAttemptUnsafe(
            item.messageId,
            item.attempt,
            item.transportReceiptId,
            item.claimId,
            item.peerConfirmed ?? false,
          ),
        );
      }
      if (results.some((result) => !result)) {
        this.state = before;
        return {
          status: 'rejected',
          failedIndex: results.findIndex((result) => !result),
          results,
        };
      }
      await this.persistUnsafe(latestAttemptAt || Date.now());
      return { status: 'committed', results };
    });
  }

  async releaseForwardClaim(claimId: string, now = Date.now()): Promise<boolean> {
    return this.enqueue(async () => {
      await this.loadUnsafe();
      for (const entry of this.state.entries) {
        const previousLength = entry.forwardLeases.length;
        entry.forwardLeases = entry.forwardLeases.filter(
          (lease) => lease.claimId !== claimId,
        );
        if (entry.forwardLeases.length !== previousLength) {
          entry.updatedAt = now;
          await this.persistUnsafe(now);
          return true;
        }
      }
      return false;
    });
  }

  async recordFinalAck(messageId: string, ack: FinalDeliveryAck): Promise<boolean> {
    return this.enqueue(async () => {
      await this.loadUnsafe();
      if (!ack.verified) return false;
      const entry = this.state.entries.find(
        (candidate) => candidate.envelope.messageId === messageId,
      );
      if (!entry) return false;
      if (ack.messageFingerprint !== entry.immutableFingerprint) return false;
      if (!Number.isFinite(ack.acknowledgedAt)) return false;
      if (
        entry.envelope.destination.kind === 'direct' &&
        entry.envelope.destination.nodeId !== ack.destinationNodeId
      ) {
        return false;
      }
      const recordedAt = Date.now();
      entry.finalAck = ack;
      entry.state = 'delivered';
      // acknowledgedAt is the destination's signed wall clock and is retained
      // for audit only. Local ordering/commit time must not depend on phone
      // clocks agreeing during a disaster.
      entry.updatedAt = recordedAt;
      await this.persistUnsafe(recordedAt);
      return true;
    });
  }

  async prune(now = Date.now()): Promise<number> {
    return this.enqueue(async () => {
      await this.loadUnsafe();
      const before = this.state.entries.length;
      const changed = this.pruneUnsafe(now);
      if (changed) await this.persistUnsafe(now);
      return before - this.state.entries.length;
    });
  }

  async snapshot(): Promise<StoredRelayMessage[]> {
    return this.enqueue(async () => {
      await this.loadUnsafe();
      return clone(this.state.entries);
    });
  }

  /**
   * Targeted lookups, so a caller that wants one or two entries does not deep
   * copy the whole backlog to get them. The receipt path used to call
   * snapshot() up to three times per arriving receipt, on the same JS thread
   * that services BLE fragment callbacks, and receipts are the most frequent
   * envelope on a busy pair.
   */
  async findEntry(messageId: string): Promise<StoredRelayMessage | undefined> {
    return this.enqueue(async () => {
      await this.loadUnsafe();
      const found = this.state.entries.find(
        (entry) => entry.envelope.messageId === messageId,
      );
      return found ? clone(found) : undefined;
    });
  }

  async findEntries(
    messageIds: readonly string[],
  ): Promise<Map<string, StoredRelayMessage>> {
    return this.enqueue(async () => {
      await this.loadUnsafe();
      const wanted = new Set(messageIds);
      const found = new Map<string, StoredRelayMessage>();
      for (const entry of this.state.entries) {
        const id = entry.envelope.messageId;
        if (wanted.has(id)) found.set(id, clone(entry));
      }
      return found;
    });
  }

  async stats(): Promise<MessageStoreStats> {
    return this.enqueue(async () => {
      await this.loadUnsafe();
      const byPriority: Record<MessagePriority, number> = {
        normal: 0,
        important: 0,
        sos: 0,
      };
      let bytes = 0;
      let pending = 0;
      let forwarded = 0;
      let delivered = 0;
      for (const entry of this.state.entries) {
        byPriority[entry.envelope.priority] += 1;
        bytes += entry.byteLength;
        if (entry.state === 'pending' || entry.state === 'stored') pending += 1;
        if (entry.state === 'forwarded') forwarded += 1;
        if (entry.state === 'delivered') delivered += 1;
      }
      return {
        entries: this.state.entries.length,
        bytes,
        byPriority,
        pending,
        forwarded,
        delivered,
        seenIds: this.state.seen.length,
      };
    });
  }

  async clear(options: { keepDedupTombstones?: boolean } = {}): Promise<void> {
    await this.enqueue(async () => {
      await this.loadUnsafe();
      const seen = options.keepDedupTombstones ? this.state.seen : [];
      this.state = {
        schemaVersion: STORE_SCHEMA_VERSION,
        entries: [],
        seen,
        updatedAt: Date.now(),
      };
      await this.persistUnsafe(this.state.updatedAt);
    });
  }

  private storeEnvelopeUnsafe(
    envelope: RelayableEnvelope,
    context: StoreEnvelopeContext,
    now: number,
  ): StoreEnvelopeResult {
    const validated = validateEnvelope(envelope);
    if (!validated.ok) {
      return { status: 'rejected', reason: validated.errors[0]?.message ?? 'Invalid envelope.' };
    }
    const fingerprint = immutableEnvelopeFingerprint(validated.value);
    const identityEntry = this.state.entries.find(
      (entry) => entry.envelope.messageId === validated.value.messageId,
    );
    if (
      identityEntry &&
      (identityEntry.envelope.originId !== validated.value.originId ||
        identityEntry.immutableFingerprint !== fingerprint)
    ) {
      return {
        status: 'rejected',
        reason: 'Message id collides with a different origin, content or signature.',
      };
    }
    const identityTombstone = this.state.seen.find(
      (seen) => seen.messageId === validated.value.messageId,
    );
    if (
      identityTombstone &&
      (identityTombstone.originId !== validated.value.originId ||
        identityTombstone.immutableFingerprint !== fingerprint)
    ) {
      return {
        status: 'rejected',
        reason: 'Seen message id collides with a different origin, content or signature.',
      };
    }
    if (validated.value.createdAt > now + this.config.maxFutureClockSkewMs) {
      return { status: 'rejected', reason: 'Envelope creation time is too far in the future.' };
    }
    if (!context.originatedLocally && !context.receivedFrom) {
      return {
        status: 'rejected',
        reason: 'Explicit originatedLocally or authenticated receivedFrom custody is required.',
      };
    }
    if (context.originatedLocally && context.receivedFrom) {
      return { status: 'rejected', reason: 'Envelope custody context is contradictory.' };
    }
    if (context.originatedLocally) {
      if (
        validated.value.originId !== this.localNodeId ||
        validated.value.relay.hopCount !== 0 ||
        validated.value.relay.path.length !== 1 ||
        validated.value.relay.path[0] !== this.localNodeId
      ) {
        return {
          status: 'rejected',
          reason: 'A local message must begin at the local node with an empty relay chain.',
        };
      }
    }
    if (context.receivedFrom) {
      if (context.relayChainVerified !== true) {
        return {
          status: 'rejected',
          reason: 'Network envelope authenticity/relay chain was not verified.',
        };
      }
      const path = validated.value.relay.path;
      const arrivedAtLocalNode = path[path.length - 1] === this.localNodeId;
      const previousHopMatches = path.length > 1 && path[path.length - 2] === context.receivedFrom;
      if (!arrivedAtLocalNode || !previousHopMatches) {
        return {
          status: 'rejected',
          reason: 'Inbound relay path does not match the transport peers.',
        };
      }
    }
    if (validated.value.kind === 'receipt') {
      const isLocalDestination =
        validated.value.destination.kind === 'direct' &&
        validated.value.destination.nodeId === this.localNodeId;
      if (Boolean(context.isFinalRecipient) !== isLocalDestination) {
        return {
          status: 'rejected',
          reason: 'Receipt final-recipient context does not match its direct destination.',
        };
      }
    }
    if (isExpired(validated.value, now)) {
      // Only an authenticated/path-bound network envelope may create a
      // tombstone; otherwise expired garbage could poison a future valid id.
      this.touchSeenUnsafe(validated.value, now, fingerprint);
      return { status: 'expired' };
    }

    const existing = this.state.entries.find(
      (entry) => entry.envelope.messageId === validated.value.messageId,
    );
    if (existing) {
      if (existing.envelope.originId !== validated.value.originId) {
        return { status: 'rejected', reason: 'Message id collision from another origin.' };
      }
      if (existing.immutableFingerprint !== fingerprint) {
        return {
          status: 'rejected',
          reason: 'Message id collision with different immutable content/signature.',
        };
      }
      existing.duplicateCount += 1;
      existing.updatedAt = now;
      this.touchSeenUnsafe(validated.value, now, fingerprint);
      if (validated.value.kind === 'receipt' && context.isFinalRecipient) {
        this.applyReceiptUnsafe(validated.value, now);
      }
      return { status: 'duplicate', entry: clone(existing) };
    }
    const tombstone = this.state.seen.find(
      (seen) => seen.messageId === validated.value.messageId,
    );
    if (tombstone && tombstone.originId !== validated.value.originId) {
      return { status: 'rejected', reason: 'Message id collision from another origin.' };
    }
    if (tombstone && tombstone.immutableFingerprint !== fingerprint) {
      return {
        status: 'rejected',
        reason: 'Seen message id was reused with different immutable content/signature.',
      };
    }
    if (tombstone) {
      this.touchSeenUnsafe(validated.value, now, fingerprint);
      if (validated.value.kind === 'receipt' && context.isFinalRecipient) {
        this.applyReceiptUnsafe(validated.value, now);
      }
      return { status: 'duplicate' };
    }

    const entry: StoredRelayMessage = {
      envelope: validated.value,
      immutableFingerprint: fingerprint,
      state: context.isFinalRecipient ? 'received' : 'stored',
      custody: context.originatedLocally
        ? 'originated'
        : context.isFinalRecipient
          ? 'received'
          : 'relayed',
      storedAt: now,
      updatedAt: now,
      effectiveExpiresAt: Math.min(
        validated.value.expiresAt,
        effectiveRetentionLimit(validated.value, this.config),
      ),
      byteLength: encodedLength(validated.value),
      duplicateCount: 0,
      attempts: [],
      forwardLeases: [],
      forwardReceipts: [],
    };
    this.state.entries.push(entry);
    this.touchSeenUnsafe(validated.value, now, fingerprint);

    if (validated.value.kind === 'receipt') {
      if (context.isFinalRecipient) {
        // A custody receipt is authoritative only for its direct destination
        // (the previous hop). An intermediate relay may coincidentally retain
        // the referred message, but must not apply a receipt addressed onward.
        this.applyReceiptUnsafe(validated.value, now);
        entry.state = 'delivered';
        entry.effectiveExpiresAt = Math.min(
          entry.effectiveExpiresAt,
          now + this.config.appliedReceiptRetentionMs,
        );
      }
    }
    this.enforceQuotasUnsafe(now);
    const kept = this.state.entries.find(
      (candidate) =>
        candidate.envelope.messageId === validated.value.messageId &&
        candidate.immutableFingerprint === fingerprint,
    );
    return kept
      ? { status: 'stored', entry: clone(kept) }
      : { status: 'quota-evicted', reason: 'Local quotas preferred user content.' };
  }

  private recordForwardAttemptUnsafe(
    messageId: string,
    attempt: ForwardAttempt,
    transportReceiptId?: string,
    claimId?: string,
    peerConfirmed = false,
  ): boolean {
    const entry = this.state.entries.find(
      (candidate) => candidate.envelope.messageId === messageId,
    );
    if (!entry) return false;
    // An outcome without its durable persist-before-send lease could fabricate
    // forwarding/custody state or consume another peer's claim.
    if (!claimId) return false;
    const lease = entry.forwardLeases.find((candidate) => candidate.claimId === claimId);
    if (!lease || lease.nextHopId !== attempt.nextHopId) return false;
    entry.forwardLeases = entry.forwardLeases.filter(
      (candidate) => candidate.claimId !== claimId,
    );
    entry.attempts.push(attempt);
    if (entry.attempts.length > this.config.maxAttemptsPerMessage) {
      entry.attempts = entry.attempts.slice(-this.config.maxAttemptsPerMessage);
    }
    entry.updatedAt = attempt.attemptedAt;
    if (attempt.accepted) {
      // Local queue admission is not durable remote custody. The bounded
      // history may roll over indefinitely while TTL/window/backoff permit.
      if (peerConfirmed) {
        this.upsertForwardReceiptUnsafe(entry, {
          nextHopId: attempt.nextHopId,
          messageFingerprint: entry.immutableFingerprint,
          acceptedAt: attempt.attemptedAt,
          transportId: attempt.transportId,
          transportReceiptId,
        });
      }
      const alreadyConfirmed = entry.forwardReceipts.some(
        (receipt) =>
          receipt.messageFingerprint === entry.immutableFingerprint,
      );
      entry.state = peerConfirmed || alreadyConfirmed ? 'forwarded' : 'pending';
      entry.lastError = undefined;
    } else {
      // A signed receipt can race ahead of the native queue callback. It is
      // stronger evidence than a later local transport failure and must not be
      // overwritten by callback ordering.
      const alreadyConfirmed = entry.forwardReceipts.some(
        (receipt) =>
          receipt.messageFingerprint === entry.immutableFingerprint,
      );
      entry.state = alreadyConfirmed ? 'forwarded' : 'pending';
      entry.lastError = alreadyConfirmed ? undefined : attempt.errorCode;
    }
    return true;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadUnsafe(): Promise<void> {
    if (this.loaded) return;
    const now = Date.now();
    const raw = await this.storage.getItem(this.config.storageKey);
    if (!raw) {
      this.state = emptyState(now);
      this.durableState = clone(this.state);
      this.loaded = true;
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      this.state = this.sanitizeState(parsed, now);
    } catch {
      this.state = emptyState(now);
    }
    this.loaded = true;
    this.enforceQuotasUnsafe(now);
    this.durableState = clone(this.state);
  }

  private sanitizeState(value: unknown, now: number): PersistedMessageStoreState {
    if (
      !isRecord(value) ||
      (value.schemaVersion !== STORE_SCHEMA_VERSION &&
        value.schemaVersion !== LEGACY_STORE_SCHEMA_VERSION)
    ) {
      return emptyState(now);
    }
    const isLegacy = value.schemaVersion === LEGACY_STORE_SCHEMA_VERSION;
    const state = emptyState(now);
    if (Array.isArray(value.entries)) {
      for (const candidate of value.entries) {
        if (!isRecord(candidate)) continue;
        let persistedEnvelope = candidate.envelope;
        // V1 had no relay attestations. Only an untraveled origin copy can be
        // migrated safely; already-relayed legacy paths are unverifiable.
        if (isLegacy && isRecord(persistedEnvelope) && isRecord(persistedEnvelope.relay)) {
          const relay = persistedEnvelope.relay;
          if (relay.hopCount === 0 && !Array.isArray(relay.attestations)) {
            persistedEnvelope = {
              ...persistedEnvelope,
              relay: { ...relay, attestations: [] },
            };
          }
        }
        const validated = validateEnvelope(persistedEnvelope);
        if (!validated.ok) continue;
        const fingerprint = immutableEnvelopeFingerprint(validated.value);
        if (
          !isLegacy &&
          (typeof candidate.immutableFingerprint !== 'string' ||
            candidate.immutableFingerprint !== fingerprint)
        ) continue;
        if (
          !isFiniteNumber(candidate.storedAt) ||
          !isFiniteNumber(candidate.updatedAt) ||
          !isFiniteNumber(candidate.effectiveExpiresAt) ||
          !isFiniteNumber(candidate.byteLength) ||
          !isFiniteNumber(candidate.duplicateCount) ||
          typeof candidate.state !== 'string' ||
          (candidate.custody !== 'originated' &&
            candidate.custody !== 'relayed' &&
            candidate.custody !== 'received')
        ) {
          continue;
        }
        const allowedStates: readonly MessageDeliveryState[] = [
          'created',
          'stored',
          'pending',
          'forwarded',
          'received',
          'delivered',
          'expired',
          'failed',
        ];
        if (!allowedStates.includes(candidate.state as MessageDeliveryState)) continue;
        state.entries.push({
          envelope: validated.value,
          immutableFingerprint: fingerprint,
          state: candidate.state as MessageDeliveryState,
          custody: candidate.custody,
          storedAt: candidate.storedAt,
          updatedAt: candidate.updatedAt,
          effectiveExpiresAt: Math.min(candidate.effectiveExpiresAt, validated.value.expiresAt),
          byteLength: encodedLength(validated.value),
          duplicateCount: Math.max(0, Math.floor(candidate.duplicateCount)),
          attempts: Array.isArray(candidate.attempts)
            ? candidate.attempts
                .map(sanitizeAttempt)
                .filter((item): item is ForwardAttempt => !!item)
                .slice(-this.config.maxAttemptsPerMessage)
            : [],
          forwardLeases: Array.isArray(candidate.forwardLeases)
            ? candidate.forwardLeases
                .map((item) => sanitizeForwardLease(item, now))
                .filter((item): item is ForwardLease => !!item)
            : [],
          forwardReceipts: Array.isArray(candidate.forwardReceipts)
            ? candidate.forwardReceipts
                .map(sanitizeForwardReceipt)
                .filter((item): item is ForwardReceipt => !!item)
            : [],
          finalAck: sanitizeFinalAck(candidate.finalAck),
          lastError: typeof candidate.lastError === 'string' ? candidate.lastError : undefined,
        });
      }
    }
    if (Array.isArray(value.seen)) {
      for (const candidate of value.seen) {
        if (
          isLegacy ||
          !isRecord(candidate) ||
          typeof candidate.messageId !== 'string' ||
          typeof candidate.originId !== 'string' ||
          typeof candidate.immutableFingerprint !== 'string' ||
          (candidate.kind !== 'content' &&
            candidate.kind !== 'capability' &&
            candidate.kind !== 'receipt') ||
          !isFiniteNumber(candidate.firstSeenAt) ||
          !isFiniteNumber(candidate.lastSeenAt) ||
          !isFiniteNumber(candidate.forgetAt) ||
          candidate.forgetAt <= now
        ) {
          continue;
        }
        state.seen.push({
          messageId: candidate.messageId,
          originId: candidate.originId,
          immutableFingerprint: candidate.immutableFingerprint,
          kind: candidate.kind,
          firstSeenAt: candidate.firstSeenAt,
          lastSeenAt: candidate.lastSeenAt,
          forgetAt: candidate.forgetAt,
        });
      }
    }
    return state;
  }

  private touchSeenUnsafe(
    envelope: RelayableEnvelope,
    now: number,
    fingerprint = immutableEnvelopeFingerprint(envelope),
  ): void {
    const seen = this.state.seen.find(
      (candidate) =>
        candidate.messageId === envelope.messageId && candidate.originId === envelope.originId,
    );
    if (seen) {
      seen.lastSeenAt = now;
      // A replay may update diagnostics but can never extend tombstone life.
    } else {
      this.state.seen.push({
        messageId: envelope.messageId,
        originId: envelope.originId,
        immutableFingerprint: fingerprint,
        kind: envelope.kind,
        firstSeenAt: now,
        lastSeenAt: now,
        forgetAt:
          Math.max(envelope.expiresAt, now) +
          (envelope.kind === 'content'
            ? this.config.dedupRetentionMs
            : this.config.controlDedupRetentionMs),
      });
    }
    this.state.seen.sort((left, right) => {
      const leftContent = left.kind === 'content' ? 1 : 0;
      const rightContent = right.kind === 'content' ? 1 : 0;
      if (leftContent !== rightContent) return leftContent - rightContent;
      return left.lastSeenAt - right.lastSeenAt;
    });
    if (this.state.seen.length > this.config.maxSeenIds) {
      this.state.seen.splice(0, this.state.seen.length - this.config.maxSeenIds);
    }
  }

  private applyReceiptUnsafe(receipt: ReceiptEnvelope, now: number): void {
    const target = this.state.entries.find(
      (entry) =>
        entry.envelope.messageId === receipt.payload.receiptFor &&
        entry.immutableFingerprint === receipt.payload.receiptForFingerprint,
    );
    if (!target) return;
    if (receipt.payload.status === 'accepted-by-relay') {
      const attemptedForReporter = target.attempts.some(
        (attempt) =>
          attempt.nextHopId === receipt.payload.reportingNodeId && attempt.accepted,
      );
      const leasedForReporter = target.forwardLeases.some(
        (lease) => lease.nextHopId === receipt.payload.reportingNodeId,
      );
      if (!attemptedForReporter && !leasedForReporter) return;
      this.upsertForwardReceiptUnsafe(target, {
        nextHopId: receipt.payload.reportingNodeId,
        messageFingerprint: receipt.payload.receiptForFingerprint,
        // Retry suppression is based on our receipt time, not the remote
        // clock. Disaster-mode phones can have substantially different clocks.
        acceptedAt: now,
        transportReceiptId: receipt.payload.transportReceiptId,
      });
      target.state = 'forwarded';
      target.updatedAt = now;
      return;
    }

    // Final delivery is applied only through recordFinalAck after the caller
    // has verified the destination's Ed25519 signature. Merely receiving a
    // syntactically valid receipt must never create a false delivered state.
  }

  private upsertForwardReceiptUnsafe(
    entry: StoredRelayMessage,
    receipt: ForwardReceipt,
  ): void {
    const previousIndex = entry.forwardReceipts.findIndex(
      (candidate) => candidate.nextHopId === receipt.nextHopId,
    );
    if (previousIndex >= 0) {
      if (entry.forwardReceipts[previousIndex].acceptedAt <= receipt.acceptedAt) {
        entry.forwardReceipts[previousIndex] = receipt;
      }
    } else {
      entry.forwardReceipts.push(receipt);
    }
  }

  private pruneUnsafe(now: number): boolean {
    const originalEntries = this.state.entries.length;
    const originalSeen = this.state.seen.length;
    let removedLease = false;
    const retained: StoredRelayMessage[] = [];
    for (const entry of this.state.entries) {
      const leaseCount = entry.forwardLeases.length;
      entry.forwardLeases = entry.forwardLeases.filter((lease) => lease.leaseUntil > now);
      removedLease = removedLease || entry.forwardLeases.length !== leaseCount;
      if (now >= entry.effectiveExpiresAt || isExpired(entry.envelope, now)) {
        this.touchSeenUnsafe(entry.envelope, now);
      } else {
        retained.push(entry);
      }
    }
    this.state.entries = retained;
    this.state.seen = this.state.seen.filter((seen) => seen.forgetAt > now);
    return (
      removedLease ||
      originalEntries !== this.state.entries.length ||
      originalSeen !== this.state.seen.length
    );
  }

  private enforceQuotasUnsafe(now: number): void {
    this.pruneUnsafe(now);

    const byOrigin = new Map<AnywayNodeId, StoredRelayMessage[]>();
    for (const entry of this.state.entries) {
      const entries = byOrigin.get(entry.envelope.originId) ?? [];
      entries.push(entry);
      byOrigin.set(entry.envelope.originId, entries);
    }
    const evictIds = new Set<string>();
    for (const entries of byOrigin.values()) {
      if (entries.length <= this.config.maxEntriesPerOrigin) continue;
      entries.sort((left, right) => evictionValue(left) - evictionValue(right));
      for (const entry of entries.slice(0, entries.length - this.config.maxEntriesPerOrigin)) {
        evictIds.add(entry.envelope.messageId);
      }
    }
    if (evictIds.size > 0) this.evictUnsafe(evictIds, now);

    const ordered = [...this.state.entries].sort(
      (left, right) => evictionValue(left) - evictionValue(right),
    );
    let bytes = this.state.entries.reduce((sum, entry) => sum + entry.byteLength, 0);
    let count = this.state.entries.length;
    const globalEvictions = new Set<string>();
    for (const entry of ordered) {
      if (count <= this.config.maxEntries && bytes <= this.config.maxBytes) break;
      globalEvictions.add(entry.envelope.messageId);
      count -= 1;
      bytes -= entry.byteLength;
    }
    if (globalEvictions.size > 0) this.evictUnsafe(globalEvictions, now);
  }

  private evictUnsafe(messageIds: ReadonlySet<string>, now: number): void {
    const retained: StoredRelayMessage[] = [];
    for (const entry of this.state.entries) {
      if (messageIds.has(entry.envelope.messageId)) {
        this.touchSeenUnsafe(entry.envelope, now);
      } else {
        retained.push(entry);
      }
    }
    this.state.entries = retained;
  }

  private async persistUnsafe(now: number): Promise<void> {
    this.state.updatedAt = now;
    // Serialize once. `clone()` is stringify+parse, so the previous
    // `clone(this.state)` walked the entire backlog a second time on every
    // persist purely to build the rollback snapshot — and a flush persists
    // once per candidate. Parsing the string we already produced is the same
    // deep copy for half the work.
    const serialized = JSON.stringify(this.state);
    try {
      await this.storage.setItem(this.config.storageKey, serialized);
      this.durableState = JSON.parse(serialized) as PersistedMessageStoreState;
    } catch (error) {
      // Never expose an in-memory state that the caller could mistake for a
      // durable commit. This is especially important before outbound sends.
      this.state = clone(this.durableState);
      throw error;
    }
  }
}
