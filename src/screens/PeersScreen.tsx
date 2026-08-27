import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { EmptyState, ScreenHeading } from '../components/VisualFoundation';
import { NearbyDevice, useMesh } from '../mesh/MeshProvider';
import { palette, radius } from '../ui/theme';

function signalLabel(rssi: number | null | undefined): string {
  if (rssi === null || rssi === undefined || !Number.isFinite(rssi)) {
    return 'Señal desconocida';
  }
  if (rssi >= -60) return 'Muy cerca';
  if (rssi >= -75) return 'Cerca';
  if (rssi >= -90) return 'Lejos';
  return 'Muy lejos';
}

export function PeersScreen() {
  const { nearbyDevices, peerSessions, peers } = useMesh();
  const connectedCount = nearbyDevices.filter((device) => device.connected).length;

  const sorted = [...nearbyDevices].sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return sortableRssi(b.rssi) - sortableRssi(a.rssi);
  });

  const renderItem = ({ item }: { item: NearbyDevice }) => {
    const label = item.nickname ?? `Dispositivo ${item.address.slice(-5)}`;
    const session = item.nodeId
      ? peerSessions.find((candidate) => candidate.nodeId === item.nodeId)
      : undefined;
    const transports =
      session?.transports ??
      peers
        .filter((peer) => peer.address === item.address)
        .map((peer) => peer.transport ?? 'ble');
    return (
      <View style={styles.row}>
        <View style={styles.avatarWrap}>
          <View style={[styles.avatar, item.color ? { backgroundColor: item.color } : null]}>
            <Text style={[styles.avatarText, !item.color && styles.avatarTextDefault]}>
              {label.charAt(0).toUpperCase()}
            </Text>
          </View>
          {item.connected && <View style={styles.onlineDot} />}
        </View>
        <View style={styles.info}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>{label}</Text>
            {item.connected && <Text style={styles.directBadge}>DIRECTO</Text>}
          </View>
          <View style={styles.transportRow}>
            {Array.from(new Set(transports)).map((transport) => (
              <Text
                key={transport}
                style={[
                  styles.transportBadge,
                  transport === 'wifi-aware' && styles.transportBadgeWifi,
                ]}
              >
                {transport === 'wifi-aware' ? 'WI‑FI' : 'BLE'}
              </Text>
            ))}
            <Text style={styles.meta}>
              {item.connected ? 'enlace activo' : 'detectado'}
            </Text>
          </View>
          <Text style={styles.signalCopy}>
            {signalLabel(item.rssi)}{hasMeasuredRssi(item.rssi) ? ` · ${item.rssi} dBm` : ''}
          </Text>
        </View>
        <SignalBars rssi={item.rssi} connected={item.connected} />
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <ScreenHeading
        eyebrow="Radar híbrido"
        title="En alcance"
        subtitle="Teléfonos que este dispositivo puede ver directamente."
        side={
          <View style={styles.countPill}>
            <Text style={styles.countValue}>{connectedCount}</Text>
            <Text style={styles.countLabel}>links</Text>
          </View>
        }
      />
      <View style={styles.explainer}>
        <View style={styles.explainerLine} />
        <Text style={styles.header}>
          Los mensajes también pueden alcanzar equipos más lejanos saltando a través de estos nodos.
        </Text>
      </View>
      <FlatList
        data={sorted}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <EmptyState
            mark="⌁"
            title="Escuchando alrededor"
            detail="Abrí Anyway en el otro teléfono. La app probará Bluetooth y Wi‑Fi cercanos automáticamente."
          />
        }
      />
    </View>
  );
}

function SignalBars({
  rssi,
  connected,
}: {
  rssi: number | null | undefined;
  connected: boolean;
}) {
  const strength = !hasMeasuredRssi(rssi) ? 0 : rssi >= -60 ? 4 : rssi >= -75 ? 3 : rssi >= -90 ? 2 : 1;
  return (
    <View style={styles.signalBars} accessibilityLabel={signalLabel(rssi)}>
      {[1, 2, 3, 4].map((level) => (
        <View
          key={level}
          style={[
            styles.signalBar,
            { height: 4 + level * 4 },
            level <= strength && (connected ? styles.signalBarConnected : styles.signalBarSeen),
          ]}
        />
      ))}
    </View>
  );
}

function hasMeasuredRssi(rssi: number | null | undefined): rssi is number {
  return typeof rssi === 'number' && Number.isFinite(rssi);
}

function sortableRssi(rssi: number | null | undefined): number {
  return hasMeasuredRssi(rssi) ? rssi : Number.NEGATIVE_INFINITY;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  explainer: {
    flexDirection: 'row',
    marginHorizontal: 20,
    marginBottom: 14,
    padding: 12,
    borderRadius: radius.medium,
    backgroundColor: palette.amberWash,
    borderWidth: 1,
    borderColor: 'rgba(255, 179, 26, 0.2)',
  },
  explainerLine: { width: 3, borderRadius: 2, backgroundColor: palette.amber, marginRight: 10 },
  header: {
    flex: 1,
    color: palette.amberSoft,
    fontSize: 12,
    lineHeight: 17,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 20,
    flexGrow: 1,
  },
  countPill: {
    minWidth: 55,
    borderRadius: radius.medium,
    paddingHorizontal: 11,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: palette.cyanWash,
    borderWidth: 1,
    borderColor: 'rgba(25, 200, 244, 0.25)',
  },
  countValue: { color: palette.cyan, fontSize: 20, lineHeight: 22, fontWeight: '900' },
  countLabel: { color: palette.cyanSoft, fontSize: 9, fontWeight: '800', textTransform: 'uppercase' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: 'rgba(10, 23, 48, 0.9)',
    borderRadius: radius.medium,
    marginBottom: 10,
  },
  avatarWrap: {
    marginRight: 12,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 16,
    backgroundColor: palette.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: palette.black,
    fontWeight: '800',
    fontSize: 16,
  },
  avatarTextDefault: {
    color: palette.cyanSoft,
  },
  onlineDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: palette.green,
    borderWidth: 2,
    borderColor: palette.surface,
  },
  info: {
    flex: 1,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  name: {
    flexShrink: 1,
    color: palette.text,
    fontSize: 15,
    fontWeight: '700',
  },
  directBadge: {
    color: palette.green,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.7,
    marginLeft: 8,
    borderRadius: radius.pill,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: palette.greenWash,
    overflow: 'hidden',
  },
  meta: {
    color: palette.textMuted,
    fontSize: 12,
  },
  transportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
  },
  transportBadge: {
    color: palette.cyanSoft,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.6,
    borderRadius: radius.pill,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: palette.cyanWash,
    overflow: 'hidden',
  },
  transportBadgeWifi: {
    color: palette.amberSoft,
    backgroundColor: palette.amberWash,
  },
  signalCopy: { color: palette.textDim, fontSize: 10, marginTop: 2 },
  signalBars: { width: 28, height: 22, flexDirection: 'row', alignItems: 'flex-end', gap: 2, marginLeft: 10 },
  signalBar: { width: 4, borderRadius: 2, backgroundColor: palette.borderStrong },
  signalBarConnected: { backgroundColor: palette.green },
  signalBarSeen: { backgroundColor: palette.cyan },
});
