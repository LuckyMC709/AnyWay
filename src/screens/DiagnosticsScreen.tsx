import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ViewStyle } from 'react-native';

import type { DeviceReportFormat } from '../diagnostics/deviceReport';
import { palette } from '../ui/theme';

export type DiagnosticsCapabilityState =
  | 'supported'
  | 'unsupported'
  | 'temporarily-unavailable'
  | 'unknown';

export interface DiagnosticsCapabilityItem {
  id: string;
  label: string;
  state: DiagnosticsCapabilityState;
  detail?: string;
  observedAt?: number;
}

export type DiagnosticsLinkState =
  | 'discovered'
  | 'connecting'
  | 'active'
  | 'degraded'
  | 'disconnecting'
  | 'disconnected'
  | 'failed';

export interface DiagnosticsMetric {
  value?: number;
  provenance: 'measured' | 'estimated' | 'unknown';
  observedAt?: number;
}

export interface DiagnosticsLinkItem {
  id: string;
  peerLabel?: string;
  transportLabel?: string;
  state: DiagnosticsLinkState;
  rssiDbm?: DiagnosticsMetric;
  lastActivityAt?: number;
  detail?: string;
}

/** Todos los contadores son opcionales: ausente significa “no informado”, no cero. */
export interface DiagnosticsStoreSnapshot {
  capturedAt?: number;
  entries?: number;
  bytes?: number;
  pending?: number;
  forwarded?: number;
  delivered?: number;
  expired?: number;
  failed?: number;
  seenIds?: number;
  byPriority?: Partial<Record<'normal' | 'important' | 'sos', number>>;
  detail?: string;
}

export type DiagnosticsEventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DiagnosticsEventItem {
  /** `id` debe ser estable si el evento se actualiza en vivo. */
  id: string;
  at: number;
  level: DiagnosticsEventLevel;
  area: string;
  name: string;
  /** Sólo metadata diagnóstica; el exportador vuelve a aplicar redacción. */
  detail?: string;
}

export type DiagnosticsViewState =
  | { status: 'loading'; message?: string }
  | { status: 'refreshing'; capturedAt?: number }
  | { status: 'ready'; capturedAt?: number }
  | { status: 'error'; message: string; capturedAt?: number };

/**
 * API controlada de `DiagnosticsScreen`.
 *
 * El contenedor suministra snapshots reales de `capabilities`, `links`,
 * `store` y `events`; la pantalla nunca prueba hardware ni rellena faltantes.
 * `format` también es controlado. `onCopy` y `onShare` deben conectar con
 * `copyDeviceReport`/`shareDeviceReport` para conservar la redacción obligatoria.
 * `onRefresh` es opcional y representa una lectura, no una prueba funcional.
 */
export interface DiagnosticsScreenProps {
  state: DiagnosticsViewState;
  capabilities: readonly DiagnosticsCapabilityItem[];
  links: readonly DiagnosticsLinkItem[];
  store?: DiagnosticsStoreSnapshot | null;
  events: readonly DiagnosticsEventItem[];
  format: DeviceReportFormat;
  onFormatChange: (format: DeviceReportFormat) => void;
  onCopy: (format: DeviceReportFormat) => void | Promise<void>;
  onShare: (format: DeviceReportFormat) => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  /** Permite deshabilitar acciones si todavía no existe un snapshot exportable. */
  exportDisabled?: boolean;
  exportDisabledReason?: string;
  /** Timestamp inyectable para previews o capturas estables. */
  now?: number;
}

type ExportActionState =
  | { status: 'idle' }
  | { status: 'copying' }
  | { status: 'copied' }
  | { status: 'sharing' }
  | { status: 'shared' }
  | { status: 'error'; message: string };

export function DiagnosticsScreen({
  state,
  capabilities,
  links,
  store,
  events,
  format,
  onFormatChange,
  onCopy,
  onShare,
  onRefresh,
  exportDisabled = false,
  exportDisabledReason,
  now: suppliedNow,
}: DiagnosticsScreenProps) {
  const now = suppliedNow ?? Date.now();
  const [action, setAction] = useState<ExportActionState>({ status: 'idle' });
  const refreshBusy = state.status === 'loading' || state.status === 'refreshing';
  const exportBusy = action.status === 'copying' || action.status === 'sharing';

  useEffect(() => {
    if (action.status === 'copied' || action.status === 'shared') {
      const timeout = setTimeout(() => setAction({ status: 'idle' }), 2_500);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [action.status]);

  const runExport = async (kind: 'copy' | 'share') => {
    if (exportDisabled || exportBusy) return;
    setAction({ status: kind === 'copy' ? 'copying' : 'sharing' });
    try {
      if (kind === 'copy') {
        await onCopy(format);
        setAction({ status: 'copied' });
      } else {
        await onShare(format);
        setAction({ status: 'shared' });
      }
    } catch {
      setAction({
        status: 'error',
        message:
          kind === 'copy'
            ? 'No se pudo copiar el diagnóstico.'
            : 'No se pudo abrir la opción de compartir.',
      });
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={styles.eyebrow}>Pruebas físicas</Text>
          <Text style={styles.title}>Diagnóstico del dispositivo</Text>
        </View>
        {onRefresh && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Actualizar diagnóstico"
            accessibilityState={{ busy: refreshBusy, disabled: refreshBusy }}
            disabled={refreshBusy}
            onPress={onRefresh}
            style={({ pressed }) => [
              styles.refreshButton,
              pressed && styles.buttonPressed,
              refreshBusy && styles.buttonDisabled,
            ]}
          >
            {refreshBusy ? (
              <ActivityIndicator color="#8edfff" size="small" />
            ) : (
              <Text style={styles.refreshButtonText}>Actualizar</Text>
            )}
          </Pressable>
        )}
      </View>
      <Text style={styles.intro}>
        Muestra lo que la app observó. “No informado” y “desconocido” no se
        reemplazan por supuestos sobre el teléfono.
      </Text>

      <ViewStateBanner state={state} now={now} />

      <Section
        title="Capacidades"
        count={capabilities.length}
        empty="Todavía no se informaron capacidades."
      >
        {capabilities.map((capability) => (
          <CapabilityRow key={capability.id} capability={capability} now={now} />
        ))}
      </Section>

      <Section
        title="Links observados"
        count={links.length}
        empty="No hay links informados en este snapshot."
      >
        {links.map((link) => (
          <LinkRow key={link.id} link={link} now={now} />
        ))}
      </Section>

      <Section
        title="Store-and-forward"
        count={store ? undefined : 0}
        empty="No hay estadísticas del store."
      >
        {store && <StoreCard store={store} now={now} />}
      </Section>

      <Section
        title="Eventos"
        count={events.length}
        empty="No hay eventos diagnósticos en este snapshot."
      >
        {events.map((event) => (
          <EventRow key={event.id} event={event} now={now} />
        ))}
      </Section>

      <View style={styles.exportCard}>
        <Text style={styles.sectionTitle}>Copiar o compartir</Text>
        <Text style={styles.sectionHelp}>
          El exportador oculta contenido de mensajes, coordenadas y secretos;
          además usa alias para nodos y endpoints dentro de cada reporte.
        </Text>

        <Text style={styles.formatLabel}>Formato</Text>
        <View style={styles.formatRow} accessibilityRole="radiogroup">
          <FormatOption
            label="JSON"
            selected={format === 'json'}
            onPress={() => onFormatChange('json')}
          />
          <FormatOption
            label="NDJSON"
            selected={format === 'ndjson'}
            onPress={() => onFormatChange('ndjson')}
          />
        </View>
        <Text style={styles.formatHelp}>
          {format === 'json'
            ? 'Un único objeto, cómodo para leer y pegar completo.'
            : 'Un registro por línea, útil para procesar eventos grandes.'}
        </Text>

        {exportDisabledReason && exportDisabled && (
          <Text style={styles.disabledReason} accessibilityRole="alert">
            {exportDisabledReason}
          </Text>
        )}
        {action.status === 'error' && (
          <Text style={styles.errorText} accessibilityRole="alert">
            {action.message}
          </Text>
        )}
        {(action.status === 'copied' || action.status === 'shared') && (
          <Text style={styles.successText} accessibilityLiveRegion="polite">
            {action.status === 'copied'
              ? 'Diagnóstico copiado.'
              : 'Opción de compartir abierta.'}
          </Text>
        )}

        <View style={styles.exportActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Copiar diagnóstico en formato ${format.toUpperCase()}`}
            accessibilityState={{ disabled: exportDisabled || exportBusy, busy: action.status === 'copying' }}
            disabled={exportDisabled || exportBusy}
            onPress={() => runExport('copy')}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.buttonPressed,
              (exportDisabled || exportBusy) && styles.buttonDisabled,
            ]}
          >
            {action.status === 'copying' ? (
              <ActivityIndicator color="#071018" />
            ) : (
              <Text style={styles.primaryButtonText}>Copiar diagnóstico</Text>
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Compartir diagnóstico en formato ${format.toUpperCase()}`}
            accessibilityState={{ disabled: exportDisabled || exportBusy, busy: action.status === 'sharing' }}
            disabled={exportDisabled || exportBusy}
            onPress={() => runExport('share')}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.buttonPressed,
              (exportDisabled || exportBusy) && styles.buttonDisabled,
            ]}
          >
            {action.status === 'sharing' ? (
              <ActivityIndicator color="#8edfff" />
            ) : (
              <Text style={styles.secondaryButtonText}>Compartir diagnóstico</Text>
            )}
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count?: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeadingRow}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {count !== undefined && <Text style={styles.countBadge}>{count}</Text>}
      </View>
      {count === 0 ? <Text style={styles.emptyText}>{empty}</Text> : children}
    </View>
  );
}

function CapabilityRow({
  capability,
  now,
}: {
  capability: DiagnosticsCapabilityItem;
  now: number;
}) {
  const copy = capabilityStateCopy(capability.state);
  return (
    <View style={styles.rowCard}>
      <View style={styles.rowHeading}>
        <Text style={styles.rowTitle}>{capability.label}</Text>
        <View style={[styles.statusBadge, copy.style]}>
          <Text style={styles.statusBadgeText}>{copy.label}</Text>
        </View>
      </View>
      {capability.detail && <Text style={styles.rowDetail}>{capability.detail}</Text>}
      {capability.observedAt !== undefined && (
        <Text style={styles.rowMeta}>Observado {formatAge(now - capability.observedAt)}</Text>
      )}
    </View>
  );
}

function LinkRow({ link, now }: { link: DiagnosticsLinkItem; now: number }) {
  const stateCopy = linkStateCopy(link.state);
  const metric = link.rssiDbm;
  const showRssi = metric?.value !== undefined && Number.isFinite(metric.value);
  return (
    <View style={styles.rowCard}>
      <View style={styles.rowHeading}>
        <View style={styles.rowHeadingText}>
          <Text style={styles.rowTitle}>{link.peerLabel ?? 'Identidad no informada'}</Text>
          <Text style={styles.transportLabel}>
            {link.transportLabel ?? 'Transporte no informado'}
          </Text>
        </View>
        <View style={[styles.statusBadge, stateCopy.style]}>
          <Text style={styles.statusBadgeText}>{stateCopy.label}</Text>
        </View>
      </View>
      {showRssi && metric && (
        <Text style={styles.rowDetail}>
          RSSI: {metric.value} dBm · {metricProvenanceLabel(metric.provenance)}
        </Text>
      )}
      {metric?.provenance === 'unknown' && !showRssi && (
        <Text style={styles.rowDetail}>RSSI no informado</Text>
      )}
      {link.detail && <Text style={styles.rowDetail}>{link.detail}</Text>}
      {link.lastActivityAt !== undefined && (
        <Text style={styles.rowMeta}>Actividad {formatAge(now - link.lastActivityAt)}</Text>
      )}
    </View>
  );
}

function StoreCard({ store, now }: { store: DiagnosticsStoreSnapshot; now: number }) {
  const stats = [
    ['Entradas', store.entries],
    ['Bytes', store.bytes],
    ['Pendientes', store.pending],
    ['Reenviados', store.forwarded],
    ['Entregados', store.delivered],
    ['Expirados', store.expired],
    ['Fallidos', store.failed],
    ['IDs vistos', store.seenIds],
  ] as const;
  const visibleStats = stats.filter(([, value]) => isFiniteNumber(value));
  const priorities = [
    ['Normal', store.byPriority?.normal],
    ['Importante', store.byPriority?.important],
    ['SOS', store.byPriority?.sos],
  ] as const;
  const visiblePriorities = priorities.filter(([, value]) => isFiniteNumber(value));

  return (
    <View style={styles.rowCard}>
      {visibleStats.length > 0 ? (
        <View style={styles.statsGrid}>
          {visibleStats.map(([label, value]) => (
            <View key={label} style={styles.statCell}>
              <Text style={styles.statValue}>{value}</Text>
              <Text style={styles.statLabel}>{label}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.emptyText}>El store existe, pero no informó contadores.</Text>
      )}
      {visiblePriorities.length > 0 && (
        <View style={styles.priorityRow}>
          {visiblePriorities.map(([label, value]) => (
            <Text key={label} style={styles.priorityText}>
              {label}: {value}
            </Text>
          ))}
        </View>
      )}
      {store.detail && <Text style={styles.rowDetail}>{store.detail}</Text>}
      {store.capturedAt !== undefined && (
        <Text style={styles.rowMeta}>Snapshot {formatAge(now - store.capturedAt)}</Text>
      )}
    </View>
  );
}

function EventRow({ event, now }: { event: DiagnosticsEventItem; now: number }) {
  const levelCopy = eventLevelCopy(event.level);
  return (
    <View style={styles.eventRow}>
      <View style={[styles.eventMarker, levelCopy.style]} />
      <View style={styles.eventContent}>
        <View style={styles.eventHeading}>
          <Text style={styles.eventName}>{event.name}</Text>
          <Text style={styles.eventTime}>{formatAge(now - event.at)}</Text>
        </View>
        <Text style={styles.eventArea}>
          {levelCopy.label} · {event.area}
        </Text>
        {event.detail && <Text style={styles.rowDetail}>{event.detail}</Text>}
      </View>
    </View>
  );
}

function ViewStateBanner({ state, now }: { state: DiagnosticsViewState; now: number }) {
  const capturedAt = 'capturedAt' in state ? state.capturedAt : undefined;
  if (state.status === 'ready') {
    return (
      <View style={[styles.stateBanner, styles.stateReady]} accessibilityLiveRegion="polite">
        <Text style={styles.stateTitle}>Snapshot disponible</Text>
        <Text style={styles.stateText}>
          {capturedAt === undefined
            ? 'La fuente no informó la hora del snapshot.'
            : `Capturado ${formatAge(now - capturedAt)}.`}
        </Text>
      </View>
    );
  }
  if (state.status === 'error') {
    return (
      <View style={[styles.stateBanner, styles.stateError]} accessibilityRole="alert">
        <Text style={styles.stateTitle}>No se pudo actualizar</Text>
        <Text style={styles.stateText}>{state.message}</Text>
        {capturedAt !== undefined && (
          <Text style={styles.stateText}>Se muestran datos de {formatAge(now - capturedAt)}.</Text>
        )}
      </View>
    );
  }
  return (
    <View style={[styles.stateBanner, styles.stateLoading]} accessibilityLiveRegion="polite">
      <View style={styles.loadingRow}>
        <ActivityIndicator color="#8edfff" size="small" />
        <Text style={styles.stateTitle}>
          {state.status === 'loading' ? 'Leyendo diagnóstico…' : 'Actualizando diagnóstico…'}
        </Text>
      </View>
      {state.status === 'loading' && state.message && (
        <Text style={styles.stateText}>{state.message}</Text>
      )}
    </View>
  );
}

function FormatOption({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.formatOption,
        selected && styles.formatOptionSelected,
        pressed && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.formatOptionText, selected && styles.formatOptionTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

function capabilityStateCopy(state: DiagnosticsCapabilityState): {
  label: string;
  style: ViewStyle;
} {
  switch (state) {
    case 'supported':
      return { label: 'Disponible', style: styles.badgeOk };
    case 'unsupported':
      return { label: 'No compatible', style: styles.badgeNeutral };
    case 'temporarily-unavailable':
      return { label: 'No disponible ahora', style: styles.badgeWarning };
    case 'unknown':
      return { label: 'Desconocido', style: styles.badgeUnknown };
  }
}

function linkStateCopy(state: DiagnosticsLinkState): { label: string; style: ViewStyle } {
  switch (state) {
    case 'discovered':
      return { label: 'Descubierto', style: styles.badgeUnknown };
    case 'connecting':
      return { label: 'Conectando', style: styles.badgeWarning };
    case 'active':
      return { label: 'Activo', style: styles.badgeOk };
    case 'degraded':
      return { label: 'Degradado', style: styles.badgeWarning };
    case 'disconnecting':
      return { label: 'Desconectando', style: styles.badgeWarning };
    case 'disconnected':
      return { label: 'Desconectado', style: styles.badgeNeutral };
    case 'failed':
      return { label: 'Falló', style: styles.badgeError };
  }
}

function eventLevelCopy(level: DiagnosticsEventLevel): { label: string; style: ViewStyle } {
  switch (level) {
    case 'debug':
      return { label: 'Depuración', style: styles.eventDebug };
    case 'info':
      return { label: 'Información', style: styles.eventInfo };
    case 'warn':
      return { label: 'Advertencia', style: styles.eventWarn };
    case 'error':
      return { label: 'Error', style: styles.eventError };
  }
}

function metricProvenanceLabel(provenance: DiagnosticsMetric['provenance']): string {
  if (provenance === 'measured') return 'medido';
  if (provenance === 'estimated') return 'estimado';
  return 'procedencia desconocida';
}

function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return 'sin hora informada';
  if (ageMs < -5_000) return 'con hora futura informada';
  const seconds = Math.max(0, Math.floor(ageMs / 1_000));
  if (seconds < 5) return 'ahora';
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} día${days === 1 ? '' : 's'}`;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  content: {
    padding: 20,
    paddingBottom: 44,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  headerText: {
    flex: 1,
  },
  eyebrow: {
    color: palette.cyan,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  title: {
    color: palette.text,
    fontSize: 27,
    lineHeight: 33,
    fontWeight: '800',
    marginTop: 5,
  },
  intro: {
    color: palette.textMuted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
  },
  refreshButton: {
    minHeight: 44,
    minWidth: 92,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#4f9fc5',
    backgroundColor: '#102433',
  },
  refreshButtonText: {
    color: '#8edfff',
    fontSize: 13,
    fontWeight: '700',
  },
  stateBanner: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginTop: 18,
  },
  stateReady: {
    backgroundColor: '#10271d',
    borderColor: '#2c714d',
  },
  stateLoading: {
    backgroundColor: '#102433',
    borderColor: '#356986',
  },
  stateError: {
    backgroundColor: '#331519',
    borderColor: '#8f3740',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  stateTitle: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '800',
  },
  stateText: {
    color: '#c5d0dc',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  section: {
    marginTop: 26,
  },
  sectionHeadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  sectionTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  sectionHelp: {
    color: '#aab6c6',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
  },
  countBadge: {
    minWidth: 30,
    color: '#d8e1ec',
    backgroundColor: '#1c2938',
    borderRadius: 12,
    overflow: 'hidden',
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  emptyText: {
    color: '#96a4b6',
    fontSize: 13,
    lineHeight: 19,
    paddingVertical: 8,
  },
  rowCard: {
    backgroundColor: '#111a26',
    borderColor: '#29394b',
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  rowHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
  },
  rowHeadingText: {
    flex: 1,
  },
  rowTitle: {
    color: '#f3f7fb',
    fontSize: 15,
    fontWeight: '700',
    flexShrink: 1,
  },
  transportLabel: {
    color: '#8edfff',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 3,
  },
  rowDetail: {
    color: '#b7c2d0',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
  rowMeta: {
    color: '#8f9daf',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 7,
  },
  statusBadge: {
    borderRadius: 9,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 5,
    maxWidth: '48%',
  },
  statusBadgeText: {
    color: '#ffffff',
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
    textAlign: 'center',
  },
  badgeOk: {
    backgroundColor: '#153d2b',
    borderColor: '#3b9a68',
  },
  badgeWarning: {
    backgroundColor: '#41320e',
    borderColor: '#a68024',
  },
  badgeError: {
    backgroundColor: '#461a20',
    borderColor: '#b34852',
  },
  badgeNeutral: {
    backgroundColor: '#27303c',
    borderColor: '#596678',
  },
  badgeUnknown: {
    backgroundColor: '#1f2c3c',
    borderColor: '#516d8d',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statCell: {
    minWidth: 88,
    flexGrow: 1,
    backgroundColor: '#0c141f',
    borderRadius: 9,
    padding: 10,
  },
  statValue: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    color: '#9eacbd',
    fontSize: 11,
    marginTop: 2,
  },
  priorityRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  priorityText: {
    color: '#c5d0dc',
    backgroundColor: '#1a2634',
    borderRadius: 8,
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 6,
    fontSize: 12,
  },
  eventRow: {
    flexDirection: 'row',
    backgroundColor: '#111a26',
    borderColor: '#29394b',
    borderWidth: 1,
    borderRadius: 12,
    padding: 13,
    marginBottom: 9,
  },
  eventMarker: {
    width: 5,
    borderRadius: 3,
    marginRight: 11,
  },
  eventDebug: {
    backgroundColor: '#718096',
  },
  eventInfo: {
    backgroundColor: '#54c7f3',
  },
  eventWarn: {
    backgroundColor: '#f0bd45',
  },
  eventError: {
    backgroundColor: '#ff6675',
  },
  eventContent: {
    flex: 1,
  },
  eventHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  eventName: {
    color: '#f3f7fb',
    fontSize: 14,
    fontWeight: '700',
    flex: 1,
  },
  eventTime: {
    color: '#93a1b3',
    fontSize: 11,
  },
  eventArea: {
    color: '#8edfff',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
  },
  exportCard: {
    backgroundColor: '#111a26',
    borderColor: '#39536d',
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    marginTop: 28,
  },
  formatLabel: {
    color: '#dfe7f0',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
  },
  formatRow: {
    flexDirection: 'row',
    gap: 9,
  },
  formatOption: {
    minHeight: 44,
    minWidth: 88,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#4b5d71',
    borderRadius: 10,
    backgroundColor: '#101925',
    paddingHorizontal: 14,
  },
  formatOptionSelected: {
    borderColor: '#74d8ff',
    backgroundColor: '#173245',
  },
  formatOptionText: {
    color: '#aebaca',
    fontSize: 13,
    fontWeight: '700',
  },
  formatOptionTextSelected: {
    color: '#b9ecff',
  },
  formatHelp: {
    color: '#8f9daf',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 8,
  },
  disabledReason: {
    color: '#ffd166',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
  },
  errorText: {
    color: '#ff9ca5',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
  },
  successText: {
    color: '#74e5a3',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
    marginTop: 14,
  },
  exportActions: {
    gap: 10,
    marginTop: 16,
  },
  primaryButton: {
    minHeight: 50,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#74d8ff',
    borderRadius: 11,
    paddingHorizontal: 16,
  },
  primaryButtonText: {
    color: '#071018',
    fontSize: 15,
    fontWeight: '800',
  },
  secondaryButton: {
    minHeight: 50,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#4f9fc5',
    backgroundColor: '#102433',
    borderRadius: 11,
    paddingHorizontal: 16,
  },
  secondaryButtonText: {
    color: '#9ce5ff',
    fontSize: 15,
    fontWeight: '700',
  },
  buttonPressed: {
    opacity: 0.78,
  },
  buttonDisabled: {
    opacity: 0.42,
  },
});
