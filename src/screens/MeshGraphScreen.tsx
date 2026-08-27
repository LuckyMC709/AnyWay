import React, { useMemo, useState } from 'react';
import { Dimensions, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { MeshNode } from '../mesh/graph';
import { useMesh } from '../mesh/MeshProvider';
import { palette } from '../ui/theme';

const NODE_SIZE_SELF = 30;
const NODE_SIZE_DIRECT = 24;
const NODE_SIZE_FAR = 18;
const CANVAS_PADDING = 24;
const MAX_CANVAS_SIZE = 420;

type Point = { x: number; y: number };

function ringOf(node: MeshNode, myNodeId: string | null): number {
  return node.nodeId === myNodeId ? 0 : node.hopsAway + 1;
}

/** Self at dead center, everyone else on concentric rings by hop distance
 *  (ring 1 = directly connected, ring 2 = one relay away, ...), spread
 *  evenly by angle within each ring. No layout library, no physics —
 *  just enough to make "who's close, who's far" readable at a glance. */
function layoutNodes(nodes: MeshNode[], myNodeId: string | null, canvasSize: number): Map<string, Point> {
  const center = canvasSize / 2;
  const maxRing = Math.max(1, ...nodes.map((n) => ringOf(n, myNodeId)));
  const ringStep = (center - NODE_SIZE_SELF) / maxRing;

  const byRing = new Map<number, MeshNode[]>();
  nodes.forEach((n) => {
    const r = ringOf(n, myNodeId);
    const list = byRing.get(r) ?? [];
    list.push(n);
    byRing.set(r, list);
  });

  const positions = new Map<string, Point>();
  byRing.forEach((ringNodes, ring) => {
    if (ring === 0) {
      ringNodes.forEach((n) => positions.set(n.nodeId, { x: center, y: center }));
      return;
    }
    const radius = ringStep * ring;
    // Stagger each ring's starting angle so spokes from different rings
    // don't all line up in the same few directions.
    const angleOffset = ((ring * 27) % 360) * (Math.PI / 180);
    ringNodes.forEach((n, i) => {
      const angle = angleOffset + (i / ringNodes.length) * Math.PI * 2 - Math.PI / 2;
      positions.set(n.nodeId, {
        x: center + radius * Math.cos(angle),
        y: center + radius * Math.sin(angle),
      });
    });
  });

  return positions;
}

function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return 'ahora';
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `hace ${hours}h`;
}

function EdgeLine({
  from,
  to,
  confirmed,
  transports,
}: {
  from: Point;
  to: Point;
  confirmed: boolean;
  transports: string[];
}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;

  return (
    <View
      pointerEvents="none"
      style={[
        styles.edgeLine,
        confirmed ? styles.edgeConfirmed : styles.edgeUnconfirmed,
        transports.includes('wifi-aware') && styles.edgeWifi,
        transports.includes('wifi-aware') && transports.includes('ble') && styles.edgeHybrid,
        {
          width: length,
          left: midX - length / 2,
          top: midY - 1,
          transform: [{ rotate: `${angleDeg}deg` }],
        },
      ]}
    />
  );
}

function LegendItem({ dotStyle, label }: { dotStyle: object; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, dotStyle]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

export function MeshGraphScreen({ onBack }: { onBack: () => void }) {
  const { meshGraph, meshEdges, articulationPoints, nodeId, links } = useMesh();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const canvasSize = Math.min(Dimensions.get('window').width - CANVAS_PADDING * 2, MAX_CANVAS_SIZE);
  const positions = useMemo(
    () => layoutNodes(meshGraph, nodeId, canvasSize),
    [meshGraph, nodeId, canvasSize]
  );

  const selected = selectedId ? meshGraph.find((n) => n.nodeId === selectedId) : undefined;
  const transportsBetween = (left: string, right: string): string[] =>
    Array.from(
      new Set(
        links
          .filter(
            (link) =>
              (link.from === left && link.to === right) ||
              (link.from === right && link.to === left),
          )
          .map((link) => link.transportKind),
      ),
    );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10}>
          <Text style={styles.backButton}>‹ Chats</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{meshGraph.length} en la malla</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.graphHelp}>
          Un nodo descubierto no implica un link activo. Las líneas intensas
          son declaraciones mutuas de vecindad; las tenues fueron anunciadas
          por un solo extremo. Ninguna línea garantiza por sí sola una ruta
          alcanzable ahora y la topología puede quedar desactualizada.
        </Text>
        <View style={[styles.canvas, { width: canvasSize, height: canvasSize }]}> 
          {meshEdges.map((edge) => {
            const from = positions.get(edge.a);
            const to = positions.get(edge.b);
            if (!from || !to) return null;
            const transports = transportsBetween(edge.a, edge.b);
            return (
              <EdgeLine
                key={`${edge.a}|${edge.b}`}
                from={from}
                to={to}
                confirmed={edge.confirmed}
                transports={transports}
              />
            );
          })}
          {meshGraph.map((node) => {
            const pos = positions.get(node.nodeId);
            if (!pos) return null;
            const isSelf = node.nodeId === nodeId;
            const isBridge = articulationPoints.has(node.nodeId);
            const size = isSelf ? NODE_SIZE_SELF : node.isDirect ? NODE_SIZE_DIRECT : NODE_SIZE_FAR;
            const label = node.nickname ?? `#${node.nodeId.slice(-4)}`;
            const nodeTransports = nodeId
              ? transportsBetween(nodeId, node.nodeId)
              : [];
            return (
              <Pressable
                key={node.nodeId}
                onPress={() => setSelectedId(node.nodeId)}
                style={[styles.nodeWrap, { left: pos.x - 30, top: pos.y - size / 2, width: 60 }]}
              >
                <View
                  style={[
                    styles.nodeDot,
                    {
                      width: size,
                      height: size,
                      borderRadius: size / 2,
                      backgroundColor: node.color ?? '#4b5563',
                      alignSelf: 'center',
                    },
                    isSelf && styles.nodeSelf,
                    isBridge && styles.nodeBridge,
                    selectedId === node.nodeId && styles.nodeSelected,
                  ]}
                />
                <Text style={styles.nodeLabel} numberOfLines={1}>
                  {isSelf ? 'Vos' : label}
                </Text>
                {!isSelf && node.isDirect && nodeTransports.length > 0 && (
                  <Text style={styles.nodeTransport} numberOfLines={1}>
                    {nodeTransports
                      .map((transport) =>
                        transport === 'wifi-aware' ? 'WI‑FI' : transport.toUpperCase(),
                      )
                      .join(' + ')}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>

        <View style={styles.legendRow}>
          <LegendItem dotStyle={styles.legendSelf} label="Vos" />
          <LegendItem dotStyle={styles.legendDirect} label="Directo" />
          <LegendItem dotStyle={styles.legendFar} label="1+ relevos" />
          <LegendItem dotStyle={styles.legendBridge} label="Puente único" />
          <LegendItem dotStyle={styles.legendWifi} label="Wi‑Fi" />
          <LegendItem dotStyle={styles.legendHybrid} label="BLE + Wi‑Fi" />
        </View>

        {selected && (
          <View style={styles.detailCard}>
            <Text style={styles.detailTitle}>
              {selected.nodeId === nodeId ? 'Vos' : selected.nickname ?? 'Desconocido'}
            </Text>
            <Text style={styles.detailRow}>ID completo: {selected.nodeId}</Text>
            <Text style={styles.detailRow}>
              {selected.nodeId === nodeId
                ? 'Este dispositivo'
                : selected.isDirect
                  ? 'Link directo'
                  : relayCountLabel(selected.hopsAway)}
            </Text>
            {selected.nodeId !== nodeId && selected.isDirect && selected.rssi !== undefined && (
              <Text style={styles.detailRow}>
                RSSI {selected.rssi} dBm medidos
              </Text>
            )}
            {selected.nodeId !== nodeId && selected.isDirect && selected.rssi === undefined && (
              <Text style={styles.detailRow}>RSSI no informado</Text>
            )}
            {selected.nodeId !== nodeId && selected.isDirect && (
              <Text style={styles.detailRow}>
                Medio: {transportsBetween(nodeId ?? '', selected.nodeId)
                  .map((transport) =>
                    transport === 'wifi-aware' ? 'Wi‑Fi Aware' : 'Bluetooth LE',
                  )
                  .join(' + ') || 'sin confirmar'}
              </Text>
            )}
            {selected.nodeId !== nodeId && (
              <Text style={styles.detailRow}>Visto {timeAgo(selected.lastAnnounceTs)}</Text>
            )}
            {articulationPoints.has(selected.nodeId) && (
              <Text style={styles.detailBridgeWarning}>
                Es el único puente entre dos partes de la malla — si se
                desconecta, la red podría partirse en dos.
              </Text>
            )}
          </View>
        )}

        {meshGraph.length <= 1 && (
          <Text style={styles.emptyText}>
            Todavía no se conoce a nadie más en la malla. En cuanto lleguen
            observaciones de presencia o topología van a aparecer acá. Esta
            vista no fija ni promete el tiempo de descubrimiento de la radio.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function relayCountLabel(relays: number): string {
  const normalized = Math.max(1, Math.floor(relays));
  return `${normalized} relevo${normalized === 1 ? '' : 's'} · ${normalized + 1} enlaces`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  backButton: {
    color: palette.cyan,
    fontSize: 15,
    width: 64,
  },
  headerTitle: {
    flex: 1,
    color: palette.text,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 64,
  },
  scrollContent: {
    alignItems: 'center',
    padding: CANVAS_PADDING,
  },
  graphHelp: {
    color: palette.textMuted,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    marginBottom: 14,
    maxWidth: MAX_CANVAS_SIZE,
  },
  canvas: {
    position: 'relative',
  },
  edgeLine: {
    position: 'absolute',
    height: 2,
    borderRadius: 1,
  },
  edgeConfirmed: {
    backgroundColor: palette.cyan,
  },
  edgeUnconfirmed: {
    backgroundColor: '#2b3542',
  },
  edgeWifi: {
    backgroundColor: palette.amber,
  },
  edgeHybrid: {
    backgroundColor: palette.green,
    height: 3,
  },
  nodeWrap: {
    position: 'absolute',
    alignItems: 'center',
  },
  nodeDot: {
    borderWidth: 2,
    borderColor: '#0d1117',
  },
  nodeSelf: {
    borderColor: '#f0f3f6',
    borderWidth: 3,
  },
  nodeBridge: {
    borderColor: '#f59e0b',
    borderWidth: 3,
  },
  nodeSelected: {
    borderColor: '#7dd3fc',
  },
  nodeLabel: {
    color: '#c3cad6',
    fontSize: 10,
    marginTop: 3,
    maxWidth: 60,
    textAlign: 'center',
  },
  nodeTransport: {
    color: palette.textDim,
    fontSize: 7,
    fontWeight: '800',
    marginTop: 1,
    textAlign: 'center',
  },
  legendRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 14,
    marginTop: 20,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 5,
  },
  legendSelf: {
    backgroundColor: '#f0f3f6',
  },
  legendDirect: {
    backgroundColor: '#3b82f6',
  },
  legendFar: {
    backgroundColor: '#4b5563',
  },
  legendBridge: {
    backgroundColor: '#f59e0b',
  },
  legendWifi: {
    backgroundColor: palette.amber,
  },
  legendHybrid: {
    backgroundColor: palette.green,
  },
  legendText: {
    color: '#9aa4b2',
    fontSize: 11,
  },
  detailCard: {
    marginTop: 20,
    width: '100%',
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#1f2732',
  },
  detailTitle: {
    color: '#f0f3f6',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 6,
  },
  detailRow: {
    color: '#9aa4b2',
    fontSize: 12,
    marginTop: 2,
  },
  detailBridgeWarning: {
    color: '#f59e0b',
    fontSize: 12,
    marginTop: 8,
    lineHeight: 17,
  },
  emptyText: {
    color: '#8a8f98',
    textAlign: 'center',
    marginTop: 24,
    lineHeight: 20,
  },
});
