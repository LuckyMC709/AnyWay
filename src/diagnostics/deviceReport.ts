import * as Clipboard from 'expo-clipboard';
import { Share } from 'react-native';

export type DeviceReportFormat = 'json' | 'ndjson';

export type DiagnosticJsonValue =
  | null
  | boolean
  | number
  | string
  | DiagnosticJsonValue[]
  | { [key: string]: DiagnosticJsonValue };

/**
 * Datos observados que el integrador entrega al exportador. Ninguna sección
 * se completa automáticamente: si no se suministra, queda ausente.
 */
export interface DeviceReportSource {
  app?: unknown;
  device?: unknown;
  permissions?: unknown;
  capabilities?: readonly unknown[];
  links?: readonly unknown[];
  store?: unknown;
  events?: readonly unknown[];
  extra?: unknown;
}

export interface DeviceReportPrivacySummary {
  privateContentRedacted: true;
  identitiesPseudonymized: true;
  redactedFieldCount: number;
  pseudonymizedValueCount: number;
}

export interface DeviceReport {
  format: 'anyway-device-report';
  version: 1;
  generatedAt: number;
  privacy: DeviceReportPrivacySummary;
  app?: DiagnosticJsonValue;
  device?: DiagnosticJsonValue;
  permissions?: DiagnosticJsonValue;
  capabilities?: DiagnosticJsonValue[];
  links?: DiagnosticJsonValue[];
  store?: DiagnosticJsonValue;
  events?: DiagnosticJsonValue[];
  extra?: DiagnosticJsonValue;
}

export interface BuildDeviceReportOptions {
  /** Timestamp real de generación. Si se omite se usa `Date.now()`. */
  generatedAt?: number;
  /** Nombres de campo adicionales que deben ocultarse, sin distinguir mayúsculas. */
  additionalPrivateKeys?: readonly string[];
}

export interface SerializeDeviceReportOptions {
  format?: DeviceReportFormat;
  /** Sólo afecta JSON; NDJSON siempre emite una línea compacta por registro. */
  pretty?: boolean;
}

export interface CopiedDeviceReport {
  copied: boolean;
  format: DeviceReportFormat;
  characterCount: number;
}

export interface SharedDeviceReport {
  action: 'shared' | 'dismissed';
  activityType?: string | null;
  format: DeviceReportFormat;
}

const PRIVATE_CONTENT_KEYS = new Set([
  'body',
  'chat',
  'chatcontent',
  'ciphertext',
  'ciphertextbase64',
  'content',
  'contents',
  'location',
  'message',
  'messages',
  'messagetext',
  'note',
  'payload',
  'plaintext',
  'text',
]);

const LOCATION_KEYS = /^(latitude|longitude|coordinates|altitude|geolocation)$/i;
const SECRET_KEYS = /(authorization|credential|private.?key|secret|token|password|nonce|signature)/i;
const NODE_ID_KEYS = /^(nodeId|originId|reportingNodeId|nextHopId|senderId|recipientId|peerId)$/i;
const GENERIC_NODE_ID_KEYS = /^(destination|mappedNode|previousHop)$/i;
// Suffix-tolerant on purpose: `fromAddress` leaked raw MACs in exported reports
// because the previous exact-match list only covered the bare `address` key.
const ENDPOINT_KEYS =
  /^(address|mac|ip|endpoint|endpointId|peerHandle|[a-z]*address)$/i;

class DeviceReportSanitizer {
  private readonly seen = new WeakSet<object>();
  private readonly aliases = new Map<string, string>();
  private readonly additionalPrivateKeys: Set<string>;

  redactedFieldCount = 0;
  pseudonymizedValueCount = 0;

  constructor(additionalPrivateKeys: readonly string[]) {
    this.additionalPrivateKeys = new Set(
      additionalPrivateKeys.map((key) => normalizeKey(key)),
    );
  }

  sanitize(value: unknown, key = ''): DiagnosticJsonValue {
    const normalizedKey = normalizeKey(key);
    if (
      PRIVATE_CONTENT_KEYS.has(normalizedKey) ||
      this.additionalPrivateKeys.has(normalizedKey) ||
      LOCATION_KEYS.test(normalizedKey) ||
      SECRET_KEYS.test(key)
    ) {
      this.redactedFieldCount += 1;
      return describeRedacted(value);
    }

    if (typeof value === 'string') {
      if (NODE_ID_KEYS.test(normalizedKey) || GENERIC_NODE_ID_KEYS.test(normalizedKey)) {
        return this.pseudonym(value, 'node');
      }
      if (ENDPOINT_KEYS.test(normalizedKey)) return this.pseudonym(value, 'endpoint');
      return value;
    }
    if (value === null) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : '[número no finito]';
    }
    if (typeof value === 'bigint') return value.toString();
    if (value === undefined) return '[no informado]';
    if (typeof value === 'function' || typeof value === 'symbol') {
      return '[valor no serializable]';
    }

    if (this.seen.has(value)) return '[referencia circular]';
    this.seen.add(value);

    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
      };
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitize(item, key));
    }

    const result: Record<string, DiagnosticJsonValue> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (childKey.toLowerCase() === 'stack') continue;
      result[childKey] = this.sanitize(childValue, childKey);
    }
    return result;
  }

  private pseudonym(value: string, category: 'node' | 'endpoint'): string {
    const mapKey = `${category}:${value}`;
    const existing = this.aliases.get(mapKey);
    if (existing) return existing;
    const sequence = this.aliases.size + 1;
    const alias = `${category}#${sequence}`;
    this.aliases.set(mapKey, alias);
    this.pseudonymizedValueCount += 1;
    return alias;
  }
}

/**
 * Genera un snapshot serializable y seguro para compartir. La redacción es
 * obligatoria: contenido de mensajes, coordenadas, secretos e identificadores
 * de nodos/endpoints no salen en claro.
 */
export function buildDeviceReport(
  source: DeviceReportSource,
  options: BuildDeviceReportOptions = {},
): DeviceReport {
  const generatedAt = options.generatedAt ?? Date.now();
  if (!Number.isFinite(generatedAt)) {
    throw new Error('generatedAt debe ser un timestamp finito.');
  }

  const sanitizer = new DeviceReportSanitizer(options.additionalPrivateKeys ?? []);
  const report: DeviceReport = {
    format: 'anyway-device-report',
    version: 1,
    generatedAt,
    privacy: {
      privateContentRedacted: true,
      identitiesPseudonymized: true,
      redactedFieldCount: 0,
      pseudonymizedValueCount: 0,
    },
  };

  assignSanitized(report, 'app', source.app, sanitizer);
  assignSanitized(report, 'device', source.device, sanitizer);
  assignSanitized(report, 'permissions', source.permissions, sanitizer);
  assignSanitizedArray(report, 'capabilities', source.capabilities, sanitizer);
  assignSanitizedArray(report, 'links', source.links, sanitizer);
  assignSanitized(report, 'store', source.store, sanitizer);
  assignSanitizedArray(report, 'events', source.events, sanitizer);
  assignSanitized(report, 'extra', source.extra, sanitizer);

  report.privacy.redactedFieldCount = sanitizer.redactedFieldCount;
  report.privacy.pseudonymizedValueCount = sanitizer.pseudonymizedValueCount;
  return report;
}

/** Serializa todo el reporte como JSON o como registros NDJSON independientes. */
export function serializeDeviceReport(
  report: DeviceReport,
  options: SerializeDeviceReportOptions = {},
): string {
  const format = options.format ?? 'json';
  if (format === 'json') {
    return JSON.stringify(report, null, options.pretty === false ? undefined : 2);
  }

  const header = {
    recordType: 'report',
    format: report.format,
    version: report.version,
    generatedAt: report.generatedAt,
    privacy: report.privacy,
    app: report.app,
    device: report.device,
    permissions: report.permissions,
    extra: report.extra,
  };
  const lines = [JSON.stringify(withoutUndefined(header))];
  appendRecords(lines, 'capability', report.capabilities);
  appendRecords(lines, 'link', report.links);
  if (report.store !== undefined) {
    lines.push(JSON.stringify({ recordType: 'store', value: report.store }));
  }
  appendRecords(lines, 'event', report.events);
  return lines.join('\n');
}

/** Copia el reporte ya redactado mediante `expo-clipboard`. */
export async function copyDeviceReport(
  report: DeviceReport,
  options: SerializeDeviceReportOptions = {},
): Promise<CopiedDeviceReport> {
  const format = options.format ?? 'json';
  const serialized = serializeDeviceReport(report, options);
  const copied = await Clipboard.setStringAsync(serialized);
  return { copied, format, characterCount: serialized.length };
}

/** Abre la hoja nativa de compartir con el reporte como texto. */
export async function shareDeviceReport(
  report: DeviceReport,
  options: SerializeDeviceReportOptions & { title?: string } = {},
): Promise<SharedDeviceReport> {
  const format = options.format ?? 'json';
  const message = serializeDeviceReport(report, options);
  const title = options.title ?? 'Diagnóstico de Anyway';
  const result = await Share.share(
    { title, message },
    { dialogTitle: title, subject: title },
  );
  return {
    action: result.action === Share.dismissedAction ? 'dismissed' : 'shared',
    activityType: result.activityType,
    format,
  };
}

function assignSanitized(
  report: DeviceReport,
  key: 'app' | 'device' | 'permissions' | 'store' | 'extra',
  value: unknown,
  sanitizer: DeviceReportSanitizer,
): void {
  if (value !== undefined) report[key] = sanitizer.sanitize(value, key);
}

function assignSanitizedArray(
  report: DeviceReport,
  key: 'capabilities' | 'links' | 'events',
  value: readonly unknown[] | undefined,
  sanitizer: DeviceReportSanitizer,
): void {
  if (value !== undefined) {
    report[key] = value.map((item) => sanitizer.sanitize(item, key));
  }
}

function appendRecords(
  lines: string[],
  recordType: 'capability' | 'link' | 'event',
  values: readonly DiagnosticJsonValue[] | undefined,
): void {
  values?.forEach((value, index) => {
    lines.push(JSON.stringify({ recordType, index, value }));
  });
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function describeRedacted(value: unknown): string {
  if (typeof value === 'string') return `[redactado:${value.length} caracteres]`;
  if (Array.isArray(value)) return `[redactado:${value.length} elementos]`;
  if (value !== null && typeof value === 'object') return '[redactado:objeto]';
  return '[redactado]';
}
