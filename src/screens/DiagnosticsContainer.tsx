import React, { useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type {
  DiagnosticEvent,
  Link,
  MessageStoreStats,
  NodeCapabilities,
} from '../core';
import {
  buildDeviceReport,
  copyDeviceReport,
  shareDeviceReport,
  type DeviceReportFormat,
} from '../diagnostics/deviceReport';
import { useMesh } from '../mesh/MeshProvider';
import { APP_BUILD, APP_VERSION } from '../version';
import { palette } from '../ui/theme';
import {
  DiagnosticsScreen,
  type DiagnosticsCapabilityItem,
  type DiagnosticsEventItem,
  type DiagnosticsLinkItem,
  type DiagnosticsStoreSnapshot,
  type DiagnosticsViewState,
} from './DiagnosticsScreen';

export function DiagnosticsContainer({ onBack }: { onBack: () => void }) {
  const mesh = useMesh();
  const [format, setFormat] = useState<DeviceReportFormat>('json');
  const [capturedAt, setCapturedAt] = useState(() => Date.now());
  const [viewState, setViewState] = useState<DiagnosticsViewState>(() => ({
    status: 'ready',
    capturedAt: Date.now(),
  }));

  const capabilities = useMemo(
    () => mapCapabilities(mesh.capabilities),
    [mesh.capabilities],
  );
  const links = useMemo(() => mapLinks(mesh.coreLinks), [mesh.coreLinks]);
  const store = useMemo(
    () => mapStore(mesh.storeStats, capturedAt),
    [mesh.storeStats, capturedAt],
  );
  const events = useMemo(
    () => mapEvents(mesh.diagnosticEvents),
    [mesh.diagnosticEvents],
  );

  const report = () =>
    buildDeviceReport(
      {
        app: {
          name: 'Anyway',
          version: APP_VERSION,
          build: APP_BUILD,
          meshStatus: mesh.status,
          protocolVersions: mesh.capabilities.protocolVersions,
        },
        device: {
          platform: Platform.OS,
          platformVersion: Platform.Version,
          manufacturer: platformConstant('Manufacturer'),
          model: platformConstant('Model'),
          apiLevel: platformConstant('Version'),
        },
        permissions: {
          bleRuntimePermissionsGranted: mesh.radioState.hasPermissions,
          wifiAwarePermissionGranted: mesh.wifiAwareState.hasPermission,
          locationPermission: 'no consultado por esta pantalla',
        },
        capabilities: [mesh.capabilities],
        links: mesh.coreLinks,
        store: mesh.storeStats,
        events: mesh.diagnosticEvents,
        extra: {
          reportingNodeId: mesh.nodeId,
          reportScope: 'snapshot observado; no es una prueba funcional de radios',
          radioState: mesh.radioState,
          wifiAwareState: mesh.wifiAwareState,
          // Android rotates BLE addresses, so one phone can authenticate under
          // several of them and hold a separate link for each. Nothing tears
          // the extras down today, and every one of them competes for the same
          // radio's connection intervals — the suspected cause of an MTU
          // exchange collapsing to the 23-byte floor on one side only. Called
          // out explicitly because it is the measurement that decides whether
          // pruning duplicate links is worth the risk of touching that code.
          duplicateBleEndpoints: mesh.peerSessions
            .filter(
              (session) =>
                session.endpoints.filter((endpoint) => (endpoint.transport ?? 'ble') === 'ble')
                  .length > 1,
            )
            .map((session) => session.endpoints.length),
          // One row per identity rather than per radio address: this is where a
          // peer reachable over two transports at once becomes visible, and
          // which radio is actually carrying its traffic.
          peerSessions: mesh.peerSessions.map((session) => ({
            transports: session.transports,
            activeTransport: session.activeTransport,
            endpointCount: session.endpoints.length,
            endpoints: session.endpoints.map((endpoint) => ({
              transport: endpoint.transport ?? 'ble',
              rssiDbm: endpoint.rssiKnown ? endpoint.rssi : null,
              handshakeRttMs: endpoint.handshakeRttMs ?? null,
              upForMs:
                endpoint.establishedAt === undefined
                  ? null
                  : Math.max(0, capturedAt - endpoint.establishedAt),
            })),
          })),
        },
      },
      {
        // Raw topology/event metadata is useful, but these generic protocol
        // keys need explicit treatment in addition to the built-in redactor.
        additionalPrivateKeys: [
          'id',
          'from',
          'to',
          'path',
          'visited',
          'messageId',
          'receiptFor',
          'nextHops',
          'mappedNode',
          'previousHop',
        ],
      },
    );

  const refresh = async () => {
    setViewState({ status: 'refreshing', capturedAt });
    // The provider values are reactive. This action only timestamps a fresh
    // read of the current snapshot; it never starts a hardware test.
    await Promise.resolve();
    const nextCapturedAt = Date.now();
    setCapturedAt(nextCapturedAt);
    setViewState({ status: 'ready', capturedAt: nextCapturedAt });
  };

  return (
    <View style={styles.container}>
      <View style={styles.backBar}>
        <Pressable onPress={onBack} hitSlop={10}>
          <Text style={styles.backButton}>‹ Ajustes</Text>
        </Pressable>
      </View>
      <DiagnosticsScreen
        state={viewState}
        capabilities={capabilities}
        links={links}
        store={store}
        events={events}
        format={format}
        onFormatChange={setFormat}
        onCopy={(selectedFormat) =>
          copyDeviceReport(report(), { format: selectedFormat, pretty: true }).then(
            () => undefined,
          )
        }
        onShare={(selectedFormat) =>
          shareDeviceReport(report(), {
            format: selectedFormat,
            pretty: true,
            title: 'Diagnóstico redactado de Anyway',
          }).then(() => undefined)
        }
        onRefresh={refresh}
      />
    </View>
  );
}

function mapCapabilities(value: NodeCapabilities): DiagnosticsCapabilityItem[] {
  const items: DiagnosticsCapabilityItem[] = Object.values(value.transports).map(
    (transport) => ({
      id: `transport:${transport.kind}`,
      label: transportLabel(transport.kind),
      state: transport.availability,
      detail: capabilityDetail(transport.kind, transport.maxConcurrentLinks),
      observedAt: transport.evidence?.observedAt ?? value.updatedAt,
    }),
  );

  items.push(
    {
      id: 'store-and-forward',
      label: 'Store-and-forward',
      state: value.supportsStoreAndForward ? 'supported' : 'unsupported',
      detail: 'Capacidad declarada por el núcleo; no reemplaza la validación física.',
      observedAt: value.updatedAt,
    },
    {
      id: 'multipath',
      label: 'Ruteo multipath',
      state: value.supportsMultipath ? 'supported' : 'unsupported',
      detail: 'Capacidad del protocolo y router local.',
      observedAt: value.updatedAt,
    },
    {
      id: 'e2e',
      label: 'Cifrado de extremo a extremo',
      state: value.supportsEndToEndEncryption ? 'supported' : 'unsupported',
      detail: 'Aplicable a cargas privadas; los broadcasts son públicos.',
      observedAt: value.updatedAt,
    },
  );
  return items;
}

function mapLinks(values: readonly Link[]): DiagnosticsLinkItem[] {
  return values.map((link, index) => ({
    id: `link:${index + 1}`,
    peerLabel: `Par observado ${index + 1}`,
    transportLabel: transportLabel(link.transportKind),
    state: link.state,
    rssiDbm: link.metrics.rssiDbm
      ? {
          value: link.metrics.rssiDbm.value,
          provenance: link.metrics.rssiDbm.provenance,
          observedAt: link.metrics.rssiDbm.observedAt,
        }
      : { provenance: 'unknown' },
    lastActivityAt: link.lastActivityAt,
    detail:
      link.mtuBytes === undefined
        ? 'MTU no informado'
        : `MTU negociado informado: ${link.mtuBytes} bytes`,
  }));
}

function mapStore(
  value: MessageStoreStats,
  capturedAt: number,
): DiagnosticsStoreSnapshot {
  return {
    capturedAt,
    entries: value.entries,
    bytes: value.bytes,
    pending: value.pending,
    forwarded: value.forwarded,
    delivered: value.delivered,
    seenIds: value.seenIds,
    byPriority: value.byPriority,
    detail: 'Contadores persistentes informados por el store local.',
  };
}

function mapEvents(values: readonly DiagnosticEvent[]): DiagnosticsEventItem[] {
  return values.slice(-150).map((event) => ({
    id: `event:${event.sequence}`,
    at: event.at,
    level: event.level,
    area: event.area,
    name: event.name,
    detail:
      event.data === undefined
        ? undefined
        : 'El evento incluye metadata, redactada antes de copiar o compartir.',
  }));
}

function transportLabel(kind: string): string {
  switch (kind) {
    case 'ble':
      return 'Bluetooth LE';
    case 'wifi-aware':
      return 'Wi‑Fi Aware';
    case 'wifi-direct':
      return 'Wi‑Fi Direct (capacidad)';
    default:
      return kind;
  }
}

function capabilityDetail(kind: string, maxConcurrentLinks?: number): string {
  const concurrency =
    maxConcurrentLinks === undefined
      ? 'Concurrencia no informada.'
      : `Máximo informado: ${maxConcurrentLinks} links.`;
  if (kind === 'wifi-direct') {
    return `Sondeo dinámico de capacidad solamente; no está habilitado como ruta automática en esta entrega. ${concurrency}`;
  }
  if (kind === 'wifi-aware') {
    return `Transporte automático independiente con descubrimiento y canal de datos local. ${concurrency}`;
  }
  return `Disponibilidad observada por el adaptador. ${concurrency}`;
}

function platformConstant(key: string): unknown {
  return (Platform.constants as unknown as Record<string, unknown>)[key];
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  backBar: {
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  backButton: {
    color: palette.cyan,
    fontSize: 15,
    fontWeight: '600',
  },
});
