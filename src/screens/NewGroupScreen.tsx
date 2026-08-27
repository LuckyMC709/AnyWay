import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useMesh } from '../mesh/MeshProvider';
import { groupConversationId } from '../mesh/types';
import { palette, radius, shadow } from '../ui/theme';

export function NewGroupScreen({
  onBack,
  onCreated,
}: {
  onBack: () => void;
  onCreated: (conversationId: string, groupName: string) => void;
}) {
  const { knownPeers, nodeId, createGroup } = useMesh();
  const candidates = knownPeers.filter((p) => p.nodeId !== nodeId);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const toggle = (peerNodeId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(peerNodeId)) next.delete(peerNodeId);
      else next.add(peerNodeId);
      return next;
    });
  };

  const canCreate = name.trim().length > 0 && selected.size > 0 && !creating;

  const submit = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const groupName = name.trim().slice(0, 40);
      const groupId = await createGroup(groupName, Array.from(selected));
      onCreated(groupConversationId(groupId), groupName);
    } finally {
      setCreating(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.headerEyebrow}>GRUPO CIFRADO</Text>
          <Text style={styles.headerTitle}>Nueva comunidad</Text>
        </View>
      </View>

      <View style={styles.nameCard}>
        <Text style={styles.inputLabel}>NOMBRE DEL GRUPO</Text>
        <TextInput
          style={styles.input}
          placeholder="Ej.: Brigada norte"
          placeholderTextColor={palette.textDim}
          value={name}
          onChangeText={setName}
          maxLength={40}
        />
      </View>

      <View style={styles.sectionRow}>
        <Text style={styles.sectionLabel}>Elegí integrantes</Text>
        <Text style={styles.selectionPill}>{selected.size} seleccionados</Text>
      </View>
      <FlatList
        data={candidates}
        keyExtractor={(item) => item.nodeId}
        renderItem={({ item }) => {
          const isSelected = selected.has(item.nodeId);
          return (
            <Pressable style={[styles.row, isSelected && styles.rowSelected]} onPress={() => toggle(item.nodeId)}>
              <View style={[styles.avatar, { backgroundColor: item.color }]}>
                <Text style={styles.avatarText}>{item.nickname.charAt(0).toUpperCase()}</Text>
              </View>
              <Text style={styles.name}>{item.nickname}</Text>
              <View style={[styles.checkbox, isSelected && styles.checkboxChecked]}>
                {isSelected && <Text style={styles.checkboxMark}>✓</Text>}
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            Todavía no se vio a nadie más en la mesh para invitar.
          </Text>
        }
      />

      <Pressable
        style={({ pressed }) => [
          styles.createButton,
          !canCreate && styles.createButtonDisabled,
          pressed && canCreate && styles.buttonPressed,
        ]}
        onPress={submit}
        disabled={!canCreate}
      >
        <Text style={styles.createButtonText}>{creating ? 'Creando…' : 'Crear grupo'}</Text>
      </Pressable>
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
  nameCard: {
    margin: 16,
    marginBottom: 10,
    padding: 14,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    ...shadow,
  },
  inputLabel: { color: palette.textDim, fontSize: 9, fontWeight: '900', letterSpacing: 1.1, marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: radius.medium,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: palette.text,
    backgroundColor: palette.backgroundRaised,
  },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 18, marginBottom: 8 },
  sectionLabel: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '700',
  },
  selectionPill: { color: palette.cyan, fontSize: 10, fontWeight: '800', backgroundColor: palette.cyanWash, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 4, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.medium,
    backgroundColor: palette.surface,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  rowSelected: { borderColor: 'rgba(25, 200, 244, 0.42)', backgroundColor: palette.cyanWash },
  avatar: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginRight: 11 },
  avatarText: { color: palette.black, fontSize: 15, fontWeight: '900' },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  checkboxChecked: {
    backgroundColor: palette.cyan,
    borderColor: palette.cyan,
  },
  checkboxMark: {
    color: palette.black,
    fontSize: 14,
    fontWeight: '700',
  },
  name: {
    flex: 1,
    color: palette.text,
    fontSize: 16,
  },
  emptyText: {
    color: palette.textDim,
    textAlign: 'center',
    marginTop: 24,
    paddingHorizontal: 24,
    lineHeight: 20,
  },
  createButton: {
    backgroundColor: palette.cyan,
    borderRadius: radius.medium,
    paddingVertical: 14,
    alignItems: 'center',
    margin: 16,
  },
  createButtonDisabled: {
    opacity: 0.4,
  },
  createButtonText: {
    color: palette.black,
    fontSize: 16,
    fontWeight: '800',
  },
  buttonPressed: { opacity: 0.72 },
});
