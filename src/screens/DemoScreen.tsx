import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { signalBars } from '../mesh/display';
import { NearbyDevice, RssiSample, useMesh } from '../mesh/MeshProvider';
import { DemoEvent } from '../mesh/types';
import { palette } from '../ui/theme';

function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return 'ahora';
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `hace ${hours}h`;
}

function SignalBars({ rssi }: { rssi: number | null | undefined }) {
  if (!hasMeasuredRssi(rssi)) {
    return <Text style={styles.unknownSignal}>RSSI desconocido</Text>;
  }
  const bars = signalBars(rssi);
  return (
    <View style={styles.barsRow}>
      {[1, 2, 3, 4].map((i) => (
        <View
          key={i}
          style={[
            styles.bar,
            { height: 4 + i * 3 },
            i <= bars ? styles.barActive : styles.barInactive,
          ]}
        />
      ))}
    </View>
  );
}

const RSSI_MIN = -100;
const RSSI_MAX = -30;

function RssiSparkline({ samples }: { samples: RssiSample[] }) {
  if (samples.length === 0) {
    return (
      <Text style={styles.emptyText}>
        Todavía no hay lecturas de señal para este dispositivo.
      </Text>
    );
  }
  return (
    <View style={styles.sparklineRow}>
      {samples.map((s, i) => {
        const clamped = Math.max(RSSI_MIN, Math.min(RSSI_MAX, s.rssi));
        const pct = (clamped - RSSI_MIN) / (RSSI_MAX - RSSI_MIN);
        const height = 6 + pct * 46;
        return <View key={i} style={[styles.sparklineBar, { height }]} />;
      })}
    </View>
  );
}

type Trend = 'up' | 'down' | 'flat';

function computeTrend(samples: RssiSample[]): Trend | null {
  if (samples.length < 6) return null;
  const half = Math.floor(samples.length / 2);
  const avg = (arr: RssiSample[]) => arr.reduce((sum, s) => sum + s.rssi, 0) / arr.length;
  const diff = avg(samples.slice(half)) - avg(samples.slice(0, half));
  if (diff > 3) return 'up';
  if (diff < -3) return 'down';
  return 'flat';
}

function TrendBadge({ trend }: { trend: Trend }) {
  const label =
    trend === 'up'
      ? '↑ RSSI subiendo'
      : trend === 'down'
        ? '↓ RSSI bajando'
        : '→ RSSI estable';
  const style = trend === 'up' ? styles.trendUp : trend === 'down' ? styles.trendDown : styles.trendFlat;
  return (
    <View style={[styles.trendBadge, style]}>
      <Text style={styles.trendText}>{label}</Text>
    </View>
  );
}

export function DemoScreen() {
  const { nearbyDevices, knownPeers, nodeId, color: myColor, demoEvents, getRssiHistory } =
    useMesh();
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const providerEventPulse = useRef(new Animated.Value(0.25)).current;

  const nameById = useMemo(() => {
    const map: Record<string, string> = {};
    knownPeers.forEach((p) => (map[p.nodeId] = p.nickname));
    return map;
  }, [knownPeers]);

  const colorById = useMemo(() => {
    const map: Record<string, string> = {};
    knownPeers.forEach((p) => (map[p.nodeId] = p.color));
    if (nodeId) map[nodeId] = myColor;
    return map;
  }, [knownPeers, nodeId, myColor]);

  const displayName = (id: string) => {
    if (id === nodeId) return 'Vos';
    return nameById[id] ?? `#${id.slice(-4)}`;
  };

  const allConnected = nearbyDevices
    .filter((d) => d.connected)
    .sort((a, b) => sortableRssi(b.rssi) - sortableRssi(a.rssi));
  const totalDetected = nearbyDevices.length;
  const latestEventTs = demoEvents[demoEvents.length - 1]?.ts ?? 0;

  useEffect(() => {
    providerEventPulse.stopAnimation();
    providerEventPulse.setValue(1);
    Animated.timing(providerEventPulse, {
      toValue: 0.25,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [allConnected.length, latestEventTs, providerEventPulse, totalDetected]);

  const selectedPeer: NearbyDevice | undefined = selectedPeerId
    ? nearbyDevices.find((d) => d.nodeId === selectedPeerId)
    : undefined;

  const connectedList = selectedPeerId
    ? allConnected.filter((d) => d.nodeId === selectedPeerId)
    : allConnected;

  const events = selectedPeerId
    ? demoEvents.filter((e) => eventInvolvesPeer(e, selectedPeerId, nearbyDevices))
    : demoEvents;

  const rssiSamples = selectedPeer ? getRssiHistory(selectedPeer.address) : [];
  const trend = computeTrend(rssiSamples);

  const renderPeer = ({ item }: { item: NearbyDevice }) => (
    <View style={styles.peerRow}>
      <View style={styles.peerInfo}>
        <Text style={styles.peerName}>{item.nickname ?? `Dispositivo ${item.address.slice(-5)}`}</Text>
        <Text style={styles.peerMeta}>
          {hasMeasuredRssi(item.rssi)
            ? `${item.rssi} dBm medidos`
            : 'Señal desconocida'}
          {' · '}visto {timeAgo(item.lastSeen)}
        </Text>
      </View>
      <SignalBars rssi={item.rssi} />
    </View>
  );

  const renderTrail = (path: string[]) => (
    <Text style={styles.eventTrail}>
      {path.map((id, i) => (
        <Text key={i}>
          <Text style={{ color: colorById[id] ?? '#9aa4b2' }}>{displayName(id)}</Text>
          <Text style={styles.eventTrail}>{i < path.length - 1 ? ' → ' : ''}</Text>
        </Text>
      ))}
    </Text>
  );

  const renderEvent = ({ item }: { item: DemoEvent }) => {
    if (item.kind === 'peer-connected') {
      const peer = nearbyDevices.find((d) => d.address === item.address);
      return (
        <View style={styles.eventRow}>
          <View style={[styles.eventDot, styles.eventDotUp]} />
          <Text style={styles.eventText}>
            {peer?.nickname ?? `Dispositivo ${item.address.slice(-5)}`} se conectó directamente
          </Text>
          <Text style={styles.eventTime}>{timeAgo(item.ts)}</Text>
        </View>
      );
    }
    if (item.kind === 'peer-disconnected') {
      const peer = nearbyDevices.find((d) => d.address === item.address);
      return (
        <View style={styles.eventRow}>
          <View style={[styles.eventDot, styles.eventDotDown]} />
          <Text style={styles.eventText}>
            {peer?.nickname ?? `Dispositivo ${item.address.slice(-5)}`} se desconectó
          </Text>
          <Text style={styles.eventTime}>{timeAgo(item.ts)}</Text>
        </View>
      );
    }
    return (
      <View style={styles.eventRow}>
        <View style={[styles.eventDot, styles.eventDotMsg]} />
        <Text style={styles.eventText}>
          Mensaje {item.wasForMe ? 'recibido' : 'reenviado'} · {relayCountLabel(item.hops)}
          {'\n'}
          {renderTrail(item.path)}
        </Text>
        <Text style={styles.eventTime}>{timeAgo(item.ts)}</Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.summaryRow}>
        <View style={styles.summaryStat}>
          <Text style={styles.summaryNumber}>{allConnected.length}</Text>
          <Text style={styles.summaryLabel}>conectados</Text>
        </View>
        <View style={styles.summaryStat}>
          <Text style={styles.summaryNumber}>{totalDetected}</Text>
          <Text style={styles.summaryLabel}>detectados</Text>
        </View>
      </View>
      <View style={styles.reactiveRow}>
        <Animated.View style={[styles.reactiveDot, { opacity: providerEventPulse }]} />
        <Text style={styles.reactiveText}>
          Respuesta visual de 300 ms al dato recibido; no representa la frecuencia de escaneo.
        </Text>
      </View>

      <Text style={styles.sectionHeader}>Enfocar en un dispositivo</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
        <Pressable
          style={[styles.chip, selectedPeerId === null && styles.chipSelected]}
          onPress={() => setSelectedPeerId(null)}
        >
          <Text style={[styles.chipText, selectedPeerId === null && styles.chipTextSelected]}>
            Todos
          </Text>
        </Pressable>
        {knownPeers.map((p) => (
          <Pressable
            key={p.nodeId}
            style={[styles.chip, selectedPeerId === p.nodeId && styles.chipSelected]}
            onPress={() => setSelectedPeerId(p.nodeId)}
          >
            <View style={[styles.chipDot, { backgroundColor: p.color }]} />
            <Text
              style={[styles.chipText, selectedPeerId === p.nodeId && styles.chipTextSelected]}
            >
              {p.nickname}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {selectedPeerId && (
        <View style={styles.focusCard}>
          {selectedPeer ? (
            <>
              <View style={styles.focusTitleRow}>
                <Text style={styles.focusTitle}>
                  {selectedPeer.nickname ?? displayName(selectedPeerId)}
                </Text>
                {trend && <TrendBadge trend={trend} />}
              </View>
              <View style={styles.focusReadingRow}>
                <Text style={styles.focusReading}>
                  {hasMeasuredRssi(selectedPeer.rssi)
                    ? `${selectedPeer.rssi} dBm`
                    : 'RSSI desconocido'}
                </Text>
                <SignalBars rssi={selectedPeer.rssi} />
              </View>
              <Text style={styles.peerMeta}>
                {hasMeasuredRssi(selectedPeer.rssi) ? 'Lectura medida' : 'Sin lectura informada'}
                {' · '}visto {timeAgo(selectedPeer.lastSeen)}
              </Text>
            </>
          ) : (
            <Text style={styles.focusTitle}>
              {displayName(selectedPeerId)} — no conectado directamente ahora
            </Text>
          )}
          <Text style={styles.sparklineLabel}>Señal en el tiempo (más reciente a la derecha)</Text>
          <RssiSparkline samples={rssiSamples} />
        </View>
      )}

      {!selectedPeerId && (
        <>
          <Text style={styles.sectionHeader}>Conexiones directas</Text>
          <FlatList
            data={connectedList}
            keyExtractor={(item) => item.key}
            renderItem={renderPeer}
            style={styles.peerList}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                Ningún dispositivo conectado directamente todavía.
              </Text>
            }
          />
        </>
      )}

      <Text style={styles.sectionHeader}>Actividad en vivo</Text>
      <Text style={styles.hint}>
        La vista reacciona a los eventos que informa el proveedor y no ejecuta
        simulaciones ni certifica el comportamiento de las radios. La señal y
        los saltos sólo aparecen cuando existe una observación real.
      </Text>
      <FlatList
        data={[...events].reverse()}
        keyExtractor={(_, index) => String(index)}
        renderItem={renderEvent}
        style={styles.eventList}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {selectedPeerId
              ? 'Sin actividad de este dispositivo todavía.'
              : 'Sin actividad todavía. Conectá otro dispositivo o mandá un mensaje para empezar a ver eventos acá.'}
          </Text>
        }
      />
    </View>
  );
}

function hasMeasuredRssi(rssi: number | null | undefined): rssi is number {
  return typeof rssi === 'number' && Number.isFinite(rssi);
}

function sortableRssi(rssi: number | null | undefined): number {
  return hasMeasuredRssi(rssi) ? rssi : Number.NEGATIVE_INFINITY;
}

/** DemoEvent.hops is the legacy relay count: zero means a direct link. */
function relayCountLabel(relays: number): string {
  if (relays <= 0) return 'directo';
  return `${relays} relevo${relays === 1 ? '' : 's'}`;
}

function eventInvolvesPeer(event: DemoEvent, peerId: string, devices: NearbyDevice[]): boolean {
  if (event.kind === 'message-seen') {
    return event.path.includes(peerId);
  }
  // peer-connected / peer-disconnected only carry a BLE address, so resolve
  // it to a nodeId via the current devices list (best-effort: right at
  // connect time the nodeId might not be known yet, in which case this
  // event just won't match the filter — it still shows up in "Todos").
  const device = devices.find((d) => d.address === event.address);
  return device?.nodeId === peerId;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  summaryRow: {
    flexDirection: 'row',
    padding: 16,
    gap: 24,
  },
  summaryStat: {
    alignItems: 'center',
  },
  summaryNumber: {
    color: palette.text,
    fontSize: 28,
    fontWeight: '700',
  },
  summaryLabel: {
    color: palette.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  reactiveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginTop: -8,
    marginBottom: 8,
  },
  reactiveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: palette.cyan,
    marginRight: 7,
  },
  reactiveText: {
    flex: 1,
    color: '#6b7280',
    fontSize: 10,
    lineHeight: 14,
  },
  sectionHeader: {
    color: palette.cyan,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
  },
  hint: {
    color: '#9aa4b2',
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  chipRow: {
    flexGrow: 0,
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2b3542',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginHorizontal: 4,
  },
  chipDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  chipSelected: {
    backgroundColor: '#3b82f6',
    borderColor: '#3b82f6',
  },
  chipText: {
    color: '#c3cad6',
    fontSize: 13,
    fontWeight: '600',
  },
  chipTextSelected: {
    color: '#ffffff',
  },
  focusCard: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#1f2732',
  },
  focusTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  focusTitle: {
    color: '#f0f3f6',
    fontSize: 16,
    fontWeight: '700',
  },
  trendBadge: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  trendUp: {
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
  },
  trendDown: {
    backgroundColor: 'rgba(248, 113, 113, 0.15)',
  },
  trendFlat: {
    backgroundColor: 'rgba(148, 163, 184, 0.15)',
  },
  trendText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#e5eaf0',
  },
  focusReadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  focusReading: {
    color: '#f0f3f6',
    fontSize: 22,
    fontWeight: '700',
  },
  sparklineLabel: {
    color: '#9aa4b2',
    fontSize: 11,
    marginTop: 12,
    marginBottom: 6,
  },
  sparklineRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: 52,
  },
  sparklineBar: {
    width: 4,
    borderRadius: 2,
    backgroundColor: '#3b82f6',
  },
  peerList: {
    maxHeight: 160,
  },
  peerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1a2029',
  },
  peerInfo: {
    flex: 1,
  },
  peerName: {
    color: '#f0f3f6',
    fontSize: 15,
    fontWeight: '600',
  },
  peerMeta: {
    color: '#9aa4b2',
    fontSize: 12,
    marginTop: 2,
  },
  barsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
  },
  unknownSignal: {
    color: '#6b7280',
    fontSize: 11,
  },
  bar: {
    width: 4,
    borderRadius: 2,
  },
  barActive: {
    backgroundColor: '#22c55e',
  },
  barInactive: {
    backgroundColor: '#2b3542',
  },
  eventList: {
    flex: 1,
  },
  emptyText: {
    color: '#8a8f98',
    textAlign: 'center',
    marginTop: 16,
    paddingHorizontal: 24,
    lineHeight: 20,
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  eventDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 5,
  },
  eventDotUp: {
    backgroundColor: '#22c55e',
  },
  eventDotDown: {
    backgroundColor: '#f87171',
  },
  eventDotMsg: {
    backgroundColor: '#38bdf8',
  },
  eventText: {
    flex: 1,
    color: '#e5eaf0',
    fontSize: 13,
    lineHeight: 18,
  },
  eventTrail: {
    color: '#9aa4b2',
    fontSize: 11,
  },
  eventTime: {
    color: '#6b7280',
    fontSize: 11,
  },
});
