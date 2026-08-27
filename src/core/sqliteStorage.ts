import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type { KeyValueStorage } from './messageStore';

type StoredValueRow = { value: string };
type SnapshotMetaRow = {
  metadataJson: string;
  schemaVersion: number;
  updatedAt: number;
};
type SnapshotValueRow = {
  rowId: string;
  position: number;
  valueJson: string;
};

interface NormalizedValue {
  rowId: string;
  position: number;
  valueJson: string;
}

interface NormalizedSnapshot {
  metadata: Record<string, unknown>;
  metadataJson: string;
  schemaVersion: number;
  updatedAt: number;
  entries: NormalizedValue[];
  seen: NormalizedValue[];
}

interface CachedSnapshot {
  metadataJson: string;
  schemaVersion: number;
  updatedAt: number;
  entries: Map<string, NormalizedValue>;
  seen: Map<string, NormalizedValue>;
}

interface LoadedSnapshot {
  raw: string;
  snapshot: NormalizedSnapshot;
}

let databasePromise: Promise<SQLiteDatabase> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableRowId(originId: string, messageId: string): string {
  // JSON tuple encoding is unambiguous even when ids contain separators.
  return JSON.stringify([originId, messageId]);
}

function normalizeRows(values: unknown[], kind: 'entry' | 'seen'): NormalizedValue[] | null {
  const rows: NormalizedValue[] = [];
  const rowIds = new Set<string>();

  for (let position = 0; position < values.length; position += 1) {
    const value = values[position];
    if (!isRecord(value)) return null;
    const identity = kind === 'entry' ? value.envelope : value;
    if (
      !isRecord(identity) ||
      typeof identity.originId !== 'string' ||
      identity.originId.length === 0 ||
      typeof identity.messageId !== 'string' ||
      identity.messageId.length === 0
    ) {
      return null;
    }

    const rowId = stableRowId(identity.originId, identity.messageId);
    if (rowIds.has(rowId)) return null;
    rowIds.add(rowId);
    rows.push({ rowId, position, valueJson: JSON.stringify(value) });
  }

  return rows;
}

/**
 * Recognize only the MessageStore snapshot shape. Other KeyValueStorage values
 * remain supported by the legacy table and are never partially normalized.
 */
function normalizeSnapshot(raw: string): NormalizedSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.schemaVersion !== 'number' ||
    !Number.isInteger(value.schemaVersion) ||
    value.schemaVersion < 1 ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.seen)
  ) {
    return null;
  }

  const entries = normalizeRows(value.entries, 'entry');
  const seen = normalizeRows(value.seen, 'seen');
  if (!entries || !seen) return null;

  const metadata: Record<string, unknown> = {};
  for (const [name, metadataValue] of Object.entries(value)) {
    if (name !== 'entries' && name !== 'seen') metadata[name] = metadataValue;
  }

  return {
    metadata,
    metadataJson: JSON.stringify(metadata),
    schemaVersion: value.schemaVersion,
    updatedAt: value.updatedAt,
    entries,
    seen,
  };
}

function cacheSnapshot(snapshot: NormalizedSnapshot): CachedSnapshot {
  return {
    metadataJson: snapshot.metadataJson,
    schemaVersion: snapshot.schemaVersion,
    updatedAt: snapshot.updatedAt,
    entries: new Map(snapshot.entries.map((row) => [row.rowId, row])),
    seen: new Map(snapshot.seen.map((row) => [row.rowId, row])),
  };
}

async function openAnywayDatabase(): Promise<SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const database = await openDatabaseAsync('anyway.db');
      await database.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA secure_delete = ON;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS durable_values (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (namespace, key)
        );
        CREATE TABLE IF NOT EXISTS message_store_snapshots (
          namespace TEXT NOT NULL,
          storage_key TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (namespace, storage_key)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS message_store_entries (
          namespace TEXT NOT NULL,
          storage_key TEXT NOT NULL,
          row_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          value_json TEXT NOT NULL,
          row_updated_at INTEGER NOT NULL,
          PRIMARY KEY (namespace, storage_key, row_id),
          FOREIGN KEY (namespace, storage_key)
            REFERENCES message_store_snapshots(namespace, storage_key)
            ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS message_store_seen (
          namespace TEXT NOT NULL,
          storage_key TEXT NOT NULL,
          row_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          value_json TEXT NOT NULL,
          row_updated_at INTEGER NOT NULL,
          PRIMARY KEY (namespace, storage_key, row_id),
          FOREIGN KEY (namespace, storage_key)
            REFERENCES message_store_snapshots(namespace, storage_key)
            ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS message_store_entries_order
          ON message_store_entries(namespace, storage_key, position);
        CREATE INDEX IF NOT EXISTS message_store_seen_order
          ON message_store_seen(namespace, storage_key, position);
      `);
      return database;
    })();
  }
  return databasePromise;
}

/**
 * SQLite backing for the core repository. MessageStore snapshots retain the
 * KeyValueStorage API, but are represented as metadata plus independently
 * replaceable entry/tombstone rows. A forwarding attempt therefore rewrites
 * one affected message row instead of committing a multi-megabyte DB value.
 */
export class SQLiteKeyValueStorage implements KeyValueStorage {
  private readonly normalizedCache = new Map<string, CachedSnapshot>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly namespace = 'core') {}

  async getItem(key: string): Promise<string | null> {
    return this.enqueue(async () => this.getItemUnsafe(key));
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.enqueue(async () => {
      const snapshot = normalizeSnapshot(value);
      if (snapshot) {
        await this.writeNormalizedSnapshot(key, snapshot);
        return;
      }

      // Preserve the generic KeyValueStorage contract for non-MessageStore
      // callers. Switching representations is one all-or-nothing commit.
      const database = await openAnywayDatabase();
      await database.withExclusiveTransactionAsync(async (transaction) => {
        await transaction.runAsync(
          'DELETE FROM message_store_entries WHERE namespace = ? AND storage_key = ?',
          this.namespace,
          key,
        );
        await transaction.runAsync(
          'DELETE FROM message_store_seen WHERE namespace = ? AND storage_key = ?',
          this.namespace,
          key,
        );
        await transaction.runAsync(
          'DELETE FROM message_store_snapshots WHERE namespace = ? AND storage_key = ?',
          this.namespace,
          key,
        );
        await transaction.runAsync(
          `INSERT INTO durable_values(namespace, key, value, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
          this.namespace,
          key,
          value,
          Date.now(),
        );
      });
      this.normalizedCache.delete(key);
    });
  }

  async removeItem(key: string): Promise<void> {
    await this.enqueue(async () => {
      const database = await openAnywayDatabase();
      await database.withExclusiveTransactionAsync(async (transaction) => {
        await transaction.runAsync(
          'DELETE FROM message_store_entries WHERE namespace = ? AND storage_key = ?',
          this.namespace,
          key,
        );
        await transaction.runAsync(
          'DELETE FROM message_store_seen WHERE namespace = ? AND storage_key = ?',
          this.namespace,
          key,
        );
        await transaction.runAsync(
          'DELETE FROM message_store_snapshots WHERE namespace = ? AND storage_key = ?',
          this.namespace,
          key,
        );
        await transaction.runAsync(
          'DELETE FROM durable_values WHERE namespace = ? AND key = ?',
          this.namespace,
          key,
        );
      });
      this.normalizedCache.delete(key);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async getItemUnsafe(key: string): Promise<string | null> {
    const normalized = await this.readNormalizedSnapshot(key);
    if (normalized) {
      this.normalizedCache.set(key, cacheSnapshot(normalized.snapshot));
      return normalized.raw;
    }

    const database = await openAnywayDatabase();
    const legacy = await database.getFirstAsync<StoredValueRow>(
      'SELECT value FROM durable_values WHERE namespace = ? AND key = ? LIMIT 1',
      this.namespace,
      key,
    );
    if (!legacy) return null;

    // Import a recognizable old blob transactionally. The legacy row is
    // removed only after every normalized row and its metadata are committed;
    // on any error it remains the authoritative recovery copy.
    const migratable = normalizeSnapshot(legacy.value);
    if (migratable) {
      try {
        await this.writeNormalizedSnapshot(key, migratable);
      } catch {
        this.normalizedCache.delete(key);
      }
    }
    return legacy.value;
  }

  private async readNormalizedSnapshot(key: string): Promise<LoadedSnapshot | null> {
    const database = await openAnywayDatabase();
    let loaded: LoadedSnapshot | null = null;

    await database.withExclusiveTransactionAsync(async (transaction) => {
      const meta = await transaction.getFirstAsync<SnapshotMetaRow>(
        `SELECT metadata_json AS metadataJson,
                schema_version AS schemaVersion,
                updated_at AS updatedAt
           FROM message_store_snapshots
          WHERE namespace = ? AND storage_key = ?
          LIMIT 1`,
        this.namespace,
        key,
      );
      if (!meta) return;

      const entryRows = await transaction.getAllAsync<SnapshotValueRow>(
        `SELECT row_id AS rowId, position, value_json AS valueJson
           FROM message_store_entries
          WHERE namespace = ? AND storage_key = ?
          ORDER BY position ASC, row_id ASC`,
        this.namespace,
        key,
      );
      const seenRows = await transaction.getAllAsync<SnapshotValueRow>(
        `SELECT row_id AS rowId, position, value_json AS valueJson
           FROM message_store_seen
          WHERE namespace = ? AND storage_key = ?
          ORDER BY position ASC, row_id ASC`,
        this.namespace,
        key,
      );

      const metadata = JSON.parse(meta.metadataJson) as unknown;
      if (!isRecord(metadata)) throw new Error('Invalid normalized MessageStore metadata.');
      const entries = entryRows.map((row) => JSON.parse(row.valueJson) as unknown);
      const seen = seenRows.map((row) => JSON.parse(row.valueJson) as unknown);
      const raw = JSON.stringify({ ...metadata, entries, seen });
      const snapshot = normalizeSnapshot(raw);
      if (!snapshot) throw new Error('Invalid normalized MessageStore rows.');
      if (
        snapshot.schemaVersion !== meta.schemaVersion ||
        snapshot.updatedAt !== meta.updatedAt
      ) {
        throw new Error('Normalized MessageStore metadata columns disagree with its payload.');
      }
      loaded = { raw, snapshot };
    });

    return loaded;
  }

  private async writeNormalizedSnapshot(
    key: string,
    snapshot: NormalizedSnapshot,
  ): Promise<void> {
    let previous = this.normalizedCache.get(key);
    if (!previous) {
      const loaded = await this.readNormalizedSnapshot(key);
      if (loaded) previous = cacheSnapshot(loaded.snapshot);
    }

    const next = cacheSnapshot(snapshot);
    const database = await openAnywayDatabase();
    const rowUpdatedAt = Date.now();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        `INSERT INTO message_store_snapshots(
           namespace, storage_key, metadata_json, schema_version, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(namespace, storage_key) DO UPDATE SET
           metadata_json = excluded.metadata_json,
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`,
        this.namespace,
        key,
        snapshot.metadataJson,
        snapshot.schemaVersion,
        snapshot.updatedAt,
      );

      await this.writeChangedRows(
        transaction,
        'message_store_entries',
        key,
        snapshot.entries,
        previous?.entries,
        rowUpdatedAt,
      );
      await this.writeChangedRows(
        transaction,
        'message_store_seen',
        key,
        snapshot.seen,
        previous?.seen,
        rowUpdatedAt,
      );

      // Deleting the source in the same commit makes legacy migration
      // recoverable: either the blob survives, or the complete row set does.
      await transaction.runAsync(
        'DELETE FROM durable_values WHERE namespace = ? AND key = ?',
        this.namespace,
        key,
      );
    });
    this.normalizedCache.set(key, next);
  }

  private async writeChangedRows(
    database: SQLiteDatabase,
    table: 'message_store_entries' | 'message_store_seen',
    key: string,
    rows: NormalizedValue[],
    previous: Map<string, NormalizedValue> | undefined,
    rowUpdatedAt: number,
  ): Promise<void> {
    const nextIds = new Set(rows.map((row) => row.rowId));
    if (!previous || (rows.length === 0 && previous.size > 0)) {
      await database.runAsync(
        `DELETE FROM ${table} WHERE namespace = ? AND storage_key = ?`,
        this.namespace,
        key,
      );
    } else if (previous) {
      for (const rowId of previous.keys()) {
        if (nextIds.has(rowId)) continue;
        await database.runAsync(
          `DELETE FROM ${table}
            WHERE namespace = ? AND storage_key = ? AND row_id = ?`,
          this.namespace,
          key,
          rowId,
        );
      }
    }

    for (const row of rows) {
      const oldRow = previous?.get(row.rowId);
      if (oldRow?.valueJson === row.valueJson) {
        if (oldRow.position !== row.position) {
          await database.runAsync(
            `UPDATE ${table}
                SET position = ?, row_updated_at = ?
              WHERE namespace = ? AND storage_key = ? AND row_id = ?`,
            row.position,
            rowUpdatedAt,
            this.namespace,
            key,
            row.rowId,
          );
        }
        continue;
      }

      await database.runAsync(
        `INSERT INTO ${table}(
           namespace, storage_key, row_id, position, value_json, row_updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, storage_key, row_id) DO UPDATE SET
           position = excluded.position,
           value_json = excluded.value_json,
           row_updated_at = excluded.row_updated_at`,
        this.namespace,
        key,
        row.rowId,
        row.position,
        row.valueJson,
        rowUpdatedAt,
      );
    }
  }
}

export const anywayCoreStorage = new SQLiteKeyValueStorage('mesh-core-v1');
