import { UnixMillis } from './model';

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';
export type DiagnosticArea =
  | 'discovery'
  | 'capability'
  | 'link'
  | 'routing'
  | 'store'
  | 'protocol'
  | 'transport'
  | 'security'
  | 'app';

export interface DiagnosticEvent {
  sequence: number;
  at: UnixMillis;
  level: DiagnosticLevel;
  area: DiagnosticArea;
  name: string;
  data?: unknown;
}

export interface DiagnosticSink {
  record(
    event: Omit<DiagnosticEvent, 'sequence' | 'at'> & { at?: UnixMillis },
  ): DiagnosticEvent;
}

export interface DiagnosticExportOptions {
  pretty?: boolean;
  /** Unsafe opt-in intended only for local developer inspection. */
  includeSensitiveData?: boolean;
  minimumLevel?: DiagnosticLevel;
}

const LEVEL_RANK: Record<DiagnosticLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const CONTENT_KEYS =
  /^(text|note|plaintext|ciphertext|ciphertextBase64|body|displayName|senderName|nickname)$/i;
const SECRET_KEYS = /(private.?key|secret|token|password|nonce|signature|authorization)/i;
const LOCATION_KEYS = /^(latitude|longitude|coordinates|location)$/i;
const ENDPOINT_KEYS = /(mac|ip|address|endpointId|peerHandle)/i;
const IDENTITY_KEYS =
  /^(nodeId|originId|reportingNodeId|nextHopId|senderId|recipientId|peerId|destination|mappedNode|previousHop|nextHops|path|visited|memberIds)$/i;
const MESSAGE_ID_KEYS = /^(id|messageId|receiptFor)$/i;

function describeRedacted(value: unknown): string {
  if (typeof value === 'string') return `[redacted:${value.length} chars]`;
  if (Array.isArray(value)) return `[redacted:${value.length} items]`;
  if (value && typeof value === 'object') return '[redacted:object]';
  return '[redacted]';
}

class ExportRedactor {
  private readonly aliases = new Map<string, string>();
  private readonly seen = new WeakSet<object>();

  redact(value: unknown, key = ''): unknown {
    if (value === null || value === undefined) return value;
    if (CONTENT_KEYS.test(key) || SECRET_KEYS.test(key) || LOCATION_KEYS.test(key)) {
      return describeRedacted(value);
    }
    if (typeof value === 'string') {
      if (IDENTITY_KEYS.test(key) || ENDPOINT_KEYS.test(key)) return this.alias(value, key);
      if (MESSAGE_ID_KEYS.test(key)) return '[redacted:id]';
      return value.length > 2_048 ? `${value.slice(0, 2_048)}…[truncated]` : value;
    }
    if (typeof value !== 'object') return value;
    if (this.seen.has(value)) return '[circular]';
    this.seen.add(value);

    if (value instanceof Error) {
      return { name: value.name, message: this.redact(value.message, 'errorMessage') };
    }
    if (Array.isArray(value)) {
      return value.slice(0, 128).map((item) => this.redact(item, key));
    }

    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (childKey === 'stack') continue;
      result[childKey] = this.redact(childValue, childKey);
    }
    return result;
  }

  private alias(value: string, key: string): string {
    const category = ENDPOINT_KEYS.test(key) ? 'endpoint' : 'node';
    const mapKey = `${category}:${value}`;
    const previous = this.aliases.get(mapKey);
    if (previous) return previous;
    const alias = `${category}#${this.aliases.size + 1}`;
    this.aliases.set(mapKey, alias);
    return alias;
  }
}

/** Fixed-size, in-memory event log suitable for a responsive Demo screen. */
export class DiagnosticRingBuffer implements DiagnosticSink {
  private readonly events: DiagnosticEvent[] = [];
  private readonly listeners = new Set<(event: DiagnosticEvent) => void>();
  private nextSequence = 1;

  constructor(private readonly capacity = 750) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('Diagnostic capacity must be a positive integer.');
    }
  }

  record(
    event: Omit<DiagnosticEvent, 'sequence' | 'at'> & { at?: UnixMillis },
  ): DiagnosticEvent {
    const recorded: DiagnosticEvent = {
      sequence: this.nextSequence++,
      at: event.at ?? Date.now(),
      level: event.level,
      area: event.area,
      name: event.name,
      data: event.data,
    };
    this.events.push(recorded);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    for (const listener of this.listeners) {
      try {
        listener(recorded);
      } catch {
        // Diagnostics must never disrupt mesh operation.
      }
    }
    return recorded;
  }

  debug(area: DiagnosticArea, name: string, data?: unknown): DiagnosticEvent {
    return this.record({ level: 'debug', area, name, data });
  }

  info(area: DiagnosticArea, name: string, data?: unknown): DiagnosticEvent {
    return this.record({ level: 'info', area, name, data });
  }

  warn(area: DiagnosticArea, name: string, data?: unknown): DiagnosticEvent {
    return this.record({ level: 'warn', area, name, data });
  }

  error(area: DiagnosticArea, name: string, data?: unknown): DiagnosticEvent {
    return this.record({ level: 'error', area, name, data });
  }

  snapshot(minimumLevel: DiagnosticLevel = 'debug'): DiagnosticEvent[] {
    const minimumRank = LEVEL_RANK[minimumLevel];
    return this.events
      .filter((event) => LEVEL_RANK[event.level] >= minimumRank)
      .map((event) => ({ ...event }));
  }

  subscribe(listener: (event: DiagnosticEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.events.length = 0;
  }

  export(options: DiagnosticExportOptions = {}): string {
    const events = this.snapshot(options.minimumLevel);
    const exportedEvents = options.includeSensitiveData
      ? events
      : new ExportRedactor().redact(events);
    return JSON.stringify(
      {
        format: 'anyway-diagnostics',
        version: 1,
        generatedAt: Date.now(),
        redacted: !options.includeSensitiveData,
        eventCount: events.length,
        events: exportedEvents,
      },
      null,
      options.pretty === false ? undefined : 2,
    );
  }
}
