import { decodeEnvelope, PROTOCOL_VERSION } from './protocol';
import { OutboxEntry } from './types';

export const OUTBOX_MAX_ENTRIES = 200;
export const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;

/** Drops entries older than OUTBOX_TTL_MS, then caps to the most recent
 *  OUTBOX_MAX_ENTRIES — whichever limit is hit first wins, per spec. */
export function pruneOutbox(entries: OutboxEntry[]): OutboxEntry[] {
  const cutoff = Date.now() - OUTBOX_TTL_MS;
  const alive = entries.filter((e) => e.addedAt >= cutoff);
  if (alive.length <= OUTBOX_MAX_ENTRIES) return alive;
  return alive.slice(alive.length - OUTBOX_MAX_ENTRIES);
}

/** AsyncStorage survives an APK upgrade. Beta 5 stored protocol-v3
 * envelopes under the same key beta 6 later reused for protocol v4. If
 * those stale entries are replayed blindly, the first connection can queue
 * thousands of useless GATT fragments before either side gets to its fresh
 * hello/announce traffic. Validate the persisted boundary and discard wire
 * messages that this build cannot decode before Bluetooth starts. */
export function sanitizeOutbox(value: unknown): OutboxEntry[] {
  if (!Array.isArray(value)) return [];

  const compatible = value.filter((candidate): candidate is OutboxEntry => {
    if (!candidate || typeof candidate !== 'object') return false;
    const entry = candidate as Partial<OutboxEntry>;
    if (typeof entry.addedAt !== 'number' || !Number.isFinite(entry.addedAt)) return false;
    if (!entry.envelope || entry.envelope.v !== PROTOCOL_VERSION) return false;
    try {
      return decodeEnvelope(JSON.stringify(entry.envelope))?.type === 'text';
    } catch {
      return false;
    }
  });

  return pruneOutbox(compatible);
}
