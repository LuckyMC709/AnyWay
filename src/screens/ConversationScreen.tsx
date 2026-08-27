import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { KeyboardAvoider } from '../components/KeyboardAvoider';
import { hopLabel } from '../mesh/display';
import { useMesh } from '../mesh/MeshProvider';
import { MeshTarget } from '../mesh/protocol';
import { ChatMessage } from '../mesh/types';
import { palette, radius, shadow } from '../ui/theme';

const MAX_CHAT_MESSAGE_LENGTH = 2_048;

function formatTime(ts: number): string {
  const date = new Date(ts);
  const hh = date.getHours().toString().padStart(2, '0');
  const mm = date.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatDateTime(ts: number): string {
  const date = new Date(ts);
  return `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1)
    .toString()
    .padStart(2, '0')}/${date.getFullYear()} ${formatTime(ts)}`;
}

function formatAge(ts: number): string {
  const elapsedMs = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 5) return 'ahora';
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} día${days === 1 ? '' : 's'}`;
}

export function ConversationScreen({
  conversationId,
  target,
  title,
  onBack,
  onOpenMeshGraph,
}: {
  conversationId: string;
  target: MeshTarget;
  title: string;
  onBack: () => void;
  onOpenMeshGraph?: () => void;
}) {
  const { getMessages, sendText, nodeId, setActiveConversation, nearbyDevices, meshGraph } =
    useMesh();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const messages = getMessages(conversationId);
  const nearbyPresence =
    target.kind === 'broadcast' ? nearbyDevices.filter((d) => d.connected && d.nodeId) : [];

  useEffect(() => {
    setActiveConversation(conversationId);
    return () => setActiveConversation(null);
  }, [conversationId, setActiveConversation]);

  const submit = async () => {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await sendText(target, text);
      setDraft('');
    } catch {
      setSendError('No se pudo guardar el mensaje. El texto sigue en el borrador.');
    } finally {
      setSending(false);
    }
  };

  const renderItem = ({ item }: { item: ChatMessage }) => {
    const isMine = item.senderId === nodeId;
    // In a 1:1 chat the other person's name is already the screen title, so
    // only broadcast (public channel) and group bubbles need it per message.
    const showSenderName = target.kind !== 'direct' && !isMine;
    return (
      <View style={[styles.bubbleRow, isMine && styles.bubbleRowMine]}>
        <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
          {showSenderName && (
            <Text style={[styles.senderName, { color: item.senderColor }]}>
              {item.senderName}
            </Text>
          )}
          {item.priority && item.priority !== 'normal' && (
            <Text style={[styles.priorityLabel, item.priority === 'sos' && styles.prioritySos]}>
              {item.priority === 'sos' ? 'SOS' : 'IMPORTANTE'}
            </Text>
          )}
          <Text style={styles.messageText}>{item.text}</Text>
          {item.location && (
            <View style={styles.locationBlock}>
              <Text style={styles.locationText} selectable>
                {item.location.latitude.toFixed(6)}, {item.location.longitude.toFixed(6)}
              </Text>
              <Text style={styles.locationMeta}>
                {item.location.accuracyMeters === undefined
                  ? 'Precisión no informada'
                  : `Precisión ±${Math.round(item.location.accuracyMeters)} m`}
              </Text>
              <Text style={styles.locationMeta}>
                Obtenida {formatDateTime(item.location.acquiredAt)} ({formatAge(item.location.acquiredAt)})
              </Text>
              <Text style={styles.locationMeta}>
                Enviada {formatDateTime(item.createdAt)} ({formatAge(item.createdAt)})
              </Text>
              {item.receivedAt !== undefined && (
                <Text style={styles.locationMeta}>
                  Recibida {formatDateTime(item.receivedAt)} ({formatAge(item.receivedAt)})
                </Text>
              )}
            </View>
          )}
          <View style={styles.metaRow}>
            {!isMine && (
              <Text style={styles.metaText}>
                {hopLabel(item.networkHops ?? item.hops)}
              </Text>
            )}
            <Text style={styles.metaText}>
              {item.encrypted === true
                ? 'cifrado E2E'
                : item.encrypted === false
                  ? 'público'
                  : 'privacidad no informada'}
            </Text>
            <Text style={styles.metaText}>{formatTime(item.ts)}</Text>
            {isMine && (
              <Text
                style={[
                  styles.messageState,
                  item.state === 'delivered' && styles.messageStateDelivered,
                  (item.state === 'failed' || item.state === 'expired') &&
                    styles.messageStateFailed,
                ]}
              >
                {messageStateLabel(item.state)}
              </Text>
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoider style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} style={styles.backButton} accessibilityLabel="Volver a chats">
          <Text style={styles.backButtonText}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {target.kind === 'broadcast'
              ? `${nearbyPresence.length} conectado${nearbyPresence.length === 1 ? '' : 's'} ahora`
              : target.kind === 'direct'
                ? 'Conversación privada'
                : 'Grupo cifrado'}
          </Text>
        </View>
        <View style={[styles.securityPill, target.kind === 'broadcast' && styles.securityPillPublic]}>
          <Text style={[styles.securityMark, target.kind === 'broadcast' && styles.securityMarkPublic]}>
            {target.kind === 'broadcast' ? '◎' : '◇'}
          </Text>
          <Text style={[styles.securityText, target.kind === 'broadcast' && styles.securityTextPublic]}>
            {target.kind === 'broadcast' ? 'PÚBLICO' : 'E2E'}
          </Text>
        </View>
      </View>
      <View style={styles.privacyBanner}>
        <View style={styles.privacyLine} />
        <Text style={styles.privacyBannerText}>
          {target.kind === 'broadcast'
            ? 'Canal público: texto y ubicación visibles para la malla.'
            : target.kind === 'direct'
              ? 'Contenido cifrado de extremo a extremo; los relevos sólo transportan ciphertext.'
              : 'Cada miembro recibe una copia cifrada de extremo a extremo.'}
        </Text>
      </View>
      {target.kind === 'broadcast' && onOpenMeshGraph && (
        <Pressable style={styles.meshBanner} onPress={onOpenMeshGraph}>
          <Text style={styles.meshBannerText}>
            {meshGraph.length} en la malla
          </Text>
          <Text style={styles.meshBannerArrow}>›</Text>
        </Pressable>
      )}
      {target.kind === 'broadcast' && (
        <View style={styles.presenceBar}>
          {nearbyPresence.length === 0 ? (
            <Text style={styles.presenceEmpty}>Nadie más conectado por ahora</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text style={styles.presenceLabel}>En el aire ahora ·</Text>
              {nearbyPresence.map((d) => (
                <View key={d.key} style={styles.presenceChip}>
                  <View style={[styles.presenceDot, { backgroundColor: d.color ?? '#7dd3fc' }]} />
                  <Text style={styles.presenceChipText}>
                    {d.nickname ?? `#${d.address.slice(-4)}`}
                  </Text>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      )}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {target.kind === 'broadcast'
              ? 'Todavía no hay mensajes en el canal público.'
              : 'Todavía no hay mensajes en esta conversación.'}
          </Text>
        }
      />
      {sendError && <Text style={styles.sendError}>{sendError}</Text>}
      <View style={styles.inputRow}>
        <View style={styles.composerColumn}>
          <TextInput
            style={styles.input}
            placeholder="Escribí un mensaje"
            placeholderTextColor="#8a8f98"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            returnKeyType="send"
            multiline
            maxLength={MAX_CHAT_MESSAGE_LENGTH}
            editable={!sending}
          />
          <Text style={styles.counter}>
            {draft.length} / {MAX_CHAT_MESSAGE_LENGTH}
          </Text>
        </View>
        <Pressable
          style={[
            styles.sendButton,
            (sending || draft.trim().length === 0) && styles.sendButtonDisabled,
          ]}
          onPress={submit}
          disabled={sending || draft.trim().length === 0}
        >
          <Text style={styles.sendButtonText}>{sending ? '…' : '↑'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoider>
  );
}

function messageStateLabel(state: ChatMessage['state']): string {
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    backgroundColor: 'rgba(3, 9, 26, 0.94)',
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.cyanWash,
    borderWidth: 1,
    borderColor: 'rgba(25, 200, 244, 0.2)',
  },
  backButtonText: { color: palette.cyan, fontSize: 29, lineHeight: 30, fontWeight: '500', marginTop: -2 },
  headerCopy: { flex: 1, marginLeft: 11, marginRight: 8 },
  headerTitle: {
    color: palette.text,
    fontSize: 17,
    fontWeight: '700',
  },
  headerSubtitle: { color: palette.textDim, fontSize: 10, marginTop: 2 },
  securityPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: palette.greenWash,
    borderWidth: 1,
    borderColor: 'rgba(61, 220, 151, 0.2)',
  },
  securityPillPublic: { backgroundColor: palette.amberWash, borderColor: 'rgba(255, 179, 26, 0.22)' },
  securityMark: { color: palette.green, fontSize: 11, marginRight: 4 },
  securityMarkPublic: { color: palette.amber },
  securityText: { color: palette.green, fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },
  securityTextPublic: { color: palette.amber },
  privacyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: palette.surface,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  privacyLine: { width: 3, height: 22, borderRadius: 2, backgroundColor: palette.cyan, marginRight: 9 },
  privacyBannerText: {
    flex: 1,
    color: palette.textMuted,
    fontSize: 10,
    lineHeight: 14,
  },
  meshBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    backgroundColor: palette.cyanWash,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  meshBannerText: {
    color: palette.cyanSoft,
    fontSize: 13,
    fontWeight: '600',
  },
  meshBannerArrow: {
    color: palette.cyan,
    fontSize: 15,
    marginLeft: 4,
  },
  presenceBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  presenceEmpty: {
    color: palette.textDim,
    fontSize: 12,
  },
  presenceLabel: {
    color: palette.textDim,
    fontSize: 12,
    marginRight: 8,
    alignSelf: 'center',
  },
  presenceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: palette.surfaceRaised,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 6,
  },
  presenceDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 5,
  },
  presenceChipText: {
    color: palette.text,
    fontSize: 12,
    fontWeight: '600',
  },
  listContent: {
    paddingHorizontal: 13,
    paddingVertical: 16,
    flexGrow: 1,
  },
  emptyText: {
    color: palette.textDim,
    textAlign: 'center',
    marginTop: 40,
    paddingHorizontal: 24,
    lineHeight: 20,
  },
  bubbleRow: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  bubbleRowMine: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 18,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderWidth: 1,
  },
  bubbleTheirs: {
    backgroundColor: palette.surfaceRaised,
    borderColor: palette.borderStrong,
    borderBottomLeftRadius: 5,
  },
  bubbleMine: {
    backgroundColor: '#075274',
    borderColor: '#12779E',
    borderBottomRightRadius: 5,
  },
  senderName: {
    color: palette.cyanSoft,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 2,
  },
  messageText: {
    color: palette.text,
    fontSize: 15,
  },
  priorityLabel: {
    color: palette.amberSoft,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  prioritySos: {
    color: '#FFADB2',
  },
  locationBlock: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.18)',
    paddingTop: 6,
  },
  locationText: {
    color: palette.text,
    fontSize: 12,
    fontWeight: '700',
  },
  locationMeta: {
    color: palette.textMuted,
    fontSize: 10,
    marginTop: 2,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: 4,
    gap: 6,
  },
  metaText: {
    color: palette.textMuted,
    fontSize: 10,
    opacity: 0.75,
  },
  messageState: {
    color: palette.textMuted,
    fontSize: 10,
    fontWeight: '600',
    opacity: 0.85,
  },
  messageStateDelivered: {
    color: palette.cyanSoft,
    opacity: 1,
  },
  messageStateFailed: {
    color: '#FFADB2',
    opacity: 1,
  },
  sendError: {
    color: '#FFADB2',
    backgroundColor: palette.redWash,
    fontSize: 12,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 9,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: palette.border,
    backgroundColor: 'rgba(3, 9, 26, 0.97)',
  },
  input: {
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: palette.text,
    backgroundColor: palette.surface,
    maxHeight: 100,
  },
  composerColumn: {
    flex: 1,
    marginRight: 8,
  },
  counter: {
    color: palette.textDim,
    fontSize: 9,
    textAlign: 'right',
    marginTop: 2,
  },
  sendButton: {
    width: 46,
    height: 46,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.cyan,
    ...shadow,
  },
  sendButtonDisabled: {
    opacity: 0.45,
  },
  sendButtonText: {
    color: palette.black,
    fontSize: 24,
    lineHeight: 26,
    fontWeight: '900',
  },
});
