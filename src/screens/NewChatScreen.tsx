import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { EmptyState } from '../components/VisualFoundation';
import { useMesh } from '../mesh/MeshProvider';
import { directConversationId } from '../mesh/types';
import { palette, radius } from '../ui/theme';

export function NewChatScreen({
  onBack,
  onPick,
}: {
  onBack: () => void;
  onPick: (conversationId: string, nodeId: string, nickname: string) => void;
}) {
  const { knownPeers, nodeId, nearbyDevices } = useMesh();
  const candidates = knownPeers.filter((p) => p.nodeId !== nodeId);
  const connectedNodeIds = React.useMemo(
    () => new Set(nearbyDevices.filter((d) => d.connected && d.nodeId).map((d) => d.nodeId)),
    [nearbyDevices]
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.headerEyebrow}>CONVERSACIÓN PRIVADA</Text>
          <Text style={styles.headerTitle}>Elegí una persona</Text>
        </View>
      </View>
      <FlatList
        data={candidates}
        keyExtractor={(item) => item.nodeId}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => {
          const isOnline = connectedNodeIds.has(item.nodeId);
          return (
            <Pressable
              style={styles.row}
              onPress={() => onPick(directConversationId(item.nodeId), item.nodeId, item.nickname)}
            >
              <View style={styles.avatarWrap}>
                <View style={[styles.avatar, { backgroundColor: item.color }]}>
                  <Text style={styles.avatarText}>{item.nickname.charAt(0).toUpperCase()}</Text>
                </View>
                {isOnline && <View style={styles.onlineDot} />}
              </View>
              <View>
                <Text style={styles.name}>{item.nickname}</Text>
                <Text style={styles.status}>{isOnline ? 'Conectado ahora' : 'No conectado'}</Text>
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <EmptyState
            mark="⌁"
            title="Todavía no conocemos a nadie"
            detail="Acercate a otro teléfono con Anyway abierto y esperá a que intercambien identidad."
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.cyanWash,
  },
  backButtonText: { color: palette.cyan, fontSize: 29, lineHeight: 30, marginTop: -2 },
  headerCopy: { flex: 1, marginLeft: 12 },
  headerEyebrow: { color: palette.cyan, fontSize: 9, fontWeight: '900', letterSpacing: 1.1 },
  headerTitle: {
    color: palette.text,
    fontSize: 19,
    fontWeight: '800',
    marginTop: 2,
  },
  listContent: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 20, flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.medium,
    backgroundColor: palette.surface,
    marginBottom: 9,
  },
  avatarWrap: {
    marginRight: 12,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: palette.black,
    fontWeight: '800',
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
  name: {
    color: palette.text,
    fontSize: 16,
  },
  status: {
    color: palette.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
});
