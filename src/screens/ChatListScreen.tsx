import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { EmptyState, ScreenHeading } from '../components/VisualFoundation';
import { conversationTarget, conversationTitle } from '../mesh/display';
import { ConversationSummary, useMesh } from '../mesh/MeshProvider';
import { MeshTarget } from '../mesh/protocol';
import type { ChatMessage } from '../mesh/types';
import { palette, radius } from '../ui/theme';

function formatTime(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return `${date.getHours().toString().padStart(2, '0')}:${date
      .getMinutes()
      .toString()
      .padStart(2, '0')}`;
  }
  return `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1)
    .toString()
    .padStart(2, '0')}`;
}

export function ChatListScreen({
  onOpenConversation,
  onNewChat,
  onNewGroup,
}: {
  onOpenConversation: (conversationId: string, target: MeshTarget, title: string) => void;
  onNewChat: () => void;
  onNewGroup: () => void;
}) {
  const { conversationSummaries, knownPeers, nearbyDevices } = useMesh();
  const knownPeersById = React.useMemo(() => {
    const map: Record<string, (typeof knownPeers)[number]> = {};
    knownPeers.forEach((p) => (map[p.nodeId] = p));
    return map;
  }, [knownPeers]);
  const connectedNodeIds = React.useMemo(
    () => new Set(nearbyDevices.filter((d) => d.connected && d.nodeId).map((d) => d.nodeId)),
    [nearbyDevices]
  );
  const connectedCount = connectedNodeIds.size;

  const renderItem = ({ item }: { item: ConversationSummary }) => {
    const title = conversationTitle(item.conversation, knownPeersById);
    const preview = item.lastMessage
      ? `${priorityPrefix(item.lastMessage.priority)}${item.lastMessage.text} · ${statePreview(
          item.lastMessage.state,
        )}`
      : item.conversation.kind === 'broadcast'
      ? 'Canal público de la mesh — todos lo ven'
      : item.conversation.kind === 'direct'
        ? 'Privado E2E · sin mensajes todavía'
        : 'Grupo con copias privadas E2E · sin mensajes todavía';
    const peerColor =
      item.conversation.kind === 'direct' && item.conversation.peerNodeId
        ? knownPeersById[item.conversation.peerNodeId]?.color
        : undefined;
    const isOnline =
      item.conversation.kind === 'direct' &&
      !!item.conversation.peerNodeId &&
      connectedNodeIds.has(item.conversation.peerNodeId);

    return (
      <Pressable
        style={styles.row}
        onPress={() =>
          onOpenConversation(item.conversation.id, conversationTarget(item.conversation), title)
        }
      >
        <View style={styles.avatarWrap}>
          <View style={[styles.avatar, peerColor ? { backgroundColor: peerColor } : null]}>
            <Text style={[styles.avatarText, !peerColor && styles.avatarTextDefault]}>
              {title.charAt(0).toUpperCase()}
            </Text>
          </View>
          {isOnline && <View style={styles.onlineDot} />}
        </View>
        <View style={styles.info}>
          <View style={styles.infoTopRow}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {item.lastMessage && (
              <Text style={styles.time}>{formatTime(item.lastMessage.ts)}</Text>
            )}
          </View>
          <View style={styles.infoBottomRow}>
            <Text style={styles.preview} numberOfLines={1}>
              {preview}
            </Text>
            {item.conversation.unreadCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{item.conversation.unreadCount}</Text>
              </View>
            )}
          </View>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <ScreenHeading
        eyebrow="Red local"
        title="Mensajes"
        subtitle="Privados, grupos y canal público, incluso sin Internet."
        side={
          <View style={[styles.livePill, connectedCount > 0 && styles.livePillActive]}>
            <View style={[styles.liveDot, connectedCount > 0 && styles.liveDotActive]} />
            <Text style={[styles.liveText, connectedCount > 0 && styles.liveTextActive]}>
              {connectedCount > 0 ? `${connectedCount} cerca` : 'Buscando'}
            </Text>
          </View>
        }
      />
      <View style={styles.headerRow}>
        <Pressable
          style={({ pressed }) => [styles.headerButton, styles.headerButtonPrimary, pressed && styles.pressed]}
          onPress={onNewChat}
        >
          <Text style={styles.headerButtonMark}>＋</Text>
          <Text style={styles.headerButtonTextPrimary}>Nuevo chat</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
          onPress={onNewGroup}
        >
          <Text style={styles.headerButtonMarkSecondary}>◇</Text>
          <Text style={styles.headerButtonText}>Crear grupo</Text>
        </Pressable>
      </View>
      <FlatList
        data={conversationSummaries}
        keyExtractor={(item) => item.conversation.id}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <EmptyState
            mark="↗"
            title="Tu malla está lista"
            detail="Creá un chat o acercate a otro teléfono con Anyway para empezar."
          />
        }
      />
    </View>
  );
}

function priorityPrefix(priority: ChatMessage['priority']): string {
  if (priority === 'sos') return '[SOS] ';
  if (priority === 'important') return '[Importante] ';
  return '';
}

function statePreview(state: ChatMessage['state']): string {
  switch (state) {
    case 'created':
      return 'creado';
    case 'stored':
      return 'guardado';
    case 'pending':
      return 'pendiente';
    case 'forwarded':
      return 'aceptado por relevo';
    case 'received':
      return 'recibido';
    case 'delivered':
      return 'entregado';
    case 'expired':
      return 'vencido';
    case 'failed':
      return 'falló';
    default:
      return 'sin estado';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  headerRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingBottom: 14,
    gap: 10,
  },
  headerButton: {
    flex: 1,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: radius.medium,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: palette.surface,
  },
  headerButtonPrimary: {
    backgroundColor: palette.cyan,
    borderColor: palette.cyan,
  },
  headerButtonText: {
    color: palette.cyanSoft,
    fontWeight: '700',
    fontSize: 13,
  },
  headerButtonTextPrimary: { color: palette.black, fontWeight: '800', fontSize: 13 },
  headerButtonMark: { color: palette.black, fontSize: 18, fontWeight: '700', marginRight: 5 },
  headerButtonMarkSecondary: { color: palette.amber, fontSize: 17, fontWeight: '800', marginRight: 6 },
  pressed: { opacity: 0.7 },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  livePillActive: { borderColor: 'rgba(61, 220, 151, 0.28)', backgroundColor: palette.greenWash },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.textDim, marginRight: 6 },
  liveDotActive: { backgroundColor: palette.green },
  liveText: { color: palette.textDim, fontSize: 10, fontWeight: '800' },
  liveTextActive: { color: palette.green },
  listContent: { paddingHorizontal: 14, paddingBottom: 18, flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.medium,
    backgroundColor: 'rgba(10, 23, 48, 0.9)',
    marginHorizontal: 6,
    marginBottom: 9,
  },
  avatarWrap: {
    marginRight: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 17,
    backgroundColor: palette.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: palette.black,
    fontWeight: '800',
    fontSize: 18,
  },
  avatarTextDefault: {
    color: palette.cyanSoft,
  },
  onlineDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: palette.green,
    borderWidth: 2,
    borderColor: palette.surface,
  },
  info: {
    flex: 1,
  },
  infoTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  infoBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
  },
  time: {
    color: palette.textDim,
    fontSize: 12,
  },
  preview: {
    color: palette.textMuted,
    fontSize: 13,
    flex: 1,
    marginRight: 8,
  },
  badge: {
    backgroundColor: palette.amber,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  badgeText: {
    color: palette.black,
    fontSize: 11,
    fontWeight: '700',
  },
});
