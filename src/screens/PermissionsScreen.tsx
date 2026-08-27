import React, { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AmbientBackground, BrandMark } from '../components/VisualFoundation';
import {
  PermissionKey,
  StartupPermissions,
  hasEssentialPermissions,
  locationGatesRadios,
  requestStartupPermissions,
} from '../mesh/permissions';
import { palette, radius, shadow, type } from '../ui/theme';

const ROWS: { key: PermissionKey; mark: string; label: string; why: string; essential: boolean }[] = [
  {
    key: 'bluetooth',
    mark: '⌁',
    label: 'Bluetooth cercano',
    why: 'Es la base compatible de la malla. Si lo negás, un teléfono compatible todavía puede comunicarse por Wi‑Fi Aware.',
    // On modern Android Wi-Fi Aware can be the independent alternative.
    essential: false,
  },
  {
    key: 'location',
    mark: '⌖',
    label: 'Ubicación',
    // On Android 12+ the mesh runs fine without it, so promising otherwise
    // would be asking for a permission under false pretences.
    why: locationGatesRadios()
      ? 'En tu versión de Android, el sistema exige este permiso para poder buscar equipos cercanos. También sirve para adjuntar tus coordenadas en un pedido de auxilio.'
      : 'Solo para adjuntar tus coordenadas en un pedido de auxilio. La malla funciona igual sin este permiso.',
    essential: locationGatesRadios(),
  },
  {
    key: 'notifications',
    mark: '•',
    label: 'Notificaciones',
    why: 'Para el aviso fijo que mantiene la malla activa con la pantalla apagada.',
    essential: false,
  },
  {
    key: 'nearbyWifi',
    mark: '≋',
    label: 'Wi‑Fi cercano',
    why: 'Para usar Wi‑Fi entre teléfonos cuando haya que mover más datos, más rápido que por Bluetooth.',
    essential: false,
  },
];

const STATE_LABEL: Record<string, string> = {
  granted: 'Concedido',
  denied: 'Pendiente',
  blocked: 'Bloqueado',
  'not-required': 'No hace falta',
};

export function PermissionsScreen({
  initial,
  onDone,
}: {
  initial: StartupPermissions;
  onDone: (outcomes: StartupPermissions) => void;
}) {
  const [outcomes, setOutcomes] = useState<StartupPermissions>(initial);
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);

  const request = async () => {
    setBusy(true);
    try {
      const next = await requestStartupPermissions();
      setOutcomes(next);
      setAsked(true);
      if (hasEssentialPermissions(next)) onDone(next);
    } finally {
      setBusy(false);
    }
  };

  const blocked = Object.values(outcomes).some((value) => value === 'blocked');
  const essentialsOk = hasEssentialPermissions(outcomes);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <AmbientBackground />
      <View style={styles.brandRow}>
        <BrandMark size={56} />
        <View style={styles.brandCopy}>
          <Text style={styles.eyebrow}>PUESTA A PUNTO</Text>
          <Text style={styles.title}>Conectemos tu nodo</Text>
        </View>
      </View>
      <Text style={styles.intro}>
        Android necesita algunas autorizaciones para mantener la malla disponible. Podés revisar
        claramente qué hace cada una antes de continuar.
      </Text>

      {ROWS.map((row) => {
        const state = outcomes[row.key];
        if (state === 'not-required') return null;
        return (
          <View key={row.key} style={styles.row}>
            <View style={styles.permissionMark}>
              <Text style={styles.permissionMarkText}>{row.mark}</Text>
            </View>
            <View style={styles.rowCopy}>
              <View style={styles.rowHead}>
                <Text style={styles.rowLabel}>{row.label}</Text>
                <Text
                  style={[
                    styles.badge,
                    state === 'granted' && styles.badgeOk,
                    state === 'blocked' && styles.badgeBlocked,
                  ]}
                >
                  {STATE_LABEL[state]}
                </Text>
              </View>
              <Text style={styles.rowWhy}>{row.why}</Text>
              {!row.essential && <Text style={styles.rowOptional}>OPCIONAL</Text>}
            </View>
          </View>
        );
      })}

      {!essentialsOk && asked && !blocked && (
        <Text style={styles.warn}>
          Hace falta autorizar al menos una radio cercana: Bluetooth o Wi‑Fi. Podés volver a intentarlo.
        </Text>
      )}

      {blocked && (
        <Text style={styles.warn}>
          Algún permiso quedó bloqueado, así que Android ya no lo va a volver a preguntar. Hay que
          activarlo a mano desde los ajustes del sistema.
        </Text>
      )}

      <Pressable
        style={({ pressed }) => [styles.primary, busy && styles.buttonDisabled, pressed && styles.pressed]}
        onPress={request}
        disabled={busy}
      >
        <Text style={styles.primaryText}>
          {busy ? 'Pidiendo permisos…' : asked ? 'Volver a pedir' : 'Conceder permisos'}
        </Text>
      </Pressable>

      {blocked && (
        <Pressable style={styles.secondary} onPress={() => void Linking.openSettings()}>
          <Text style={styles.secondaryText}>Abrir ajustes del sistema</Text>
        </Pressable>
      )}

      {asked && (
        <Pressable style={styles.secondary} onPress={() => onDone(outcomes)}>
          <Text style={styles.secondaryText}>
            {essentialsOk ? 'Continuar' : 'Continuar igual'}
          </Text>
        </Pressable>
      )}

      <Text style={styles.footnote}>
        La ubicación en segundo plano se pide aparte, desde Ajustes. Android exige que sea un
        pedido separado y solo hace falta en Android 10 y 11.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.background },
  content: { padding: 22, paddingTop: 32, paddingBottom: 48 },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  brandCopy: { flex: 1, marginLeft: 14 },
  eyebrow: { ...type.eyebrow, color: palette.amber },
  title: { color: palette.text, fontSize: 26, lineHeight: 31, fontWeight: '800', marginTop: 3 },
  intro: { color: palette.textMuted, fontSize: 14, lineHeight: 21, marginTop: 18, marginBottom: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(10, 23, 48, 0.94)',
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: palette.border,
    padding: 15,
    marginTop: 11,
    ...shadow,
  },
  permissionMark: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.cyanWash,
    borderWidth: 1,
    borderColor: 'rgba(25, 200, 244, 0.22)',
    marginRight: 12,
  },
  permissionMarkText: { color: palette.cyan, fontSize: 20, fontWeight: '800' },
  rowCopy: { flex: 1 },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel: { color: palette.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    color: palette.textMuted,
    backgroundColor: palette.surfaceRaised,
    overflow: 'hidden',
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 8,
  },
  badgeOk: { color: palette.green, backgroundColor: palette.greenWash },
  badgeBlocked: { color: '#FFADB2', backgroundColor: palette.redWash },
  rowWhy: { color: palette.textMuted, fontSize: 12, lineHeight: 18, marginTop: 6 },
  rowOptional: { color: palette.amber, fontSize: 9, fontWeight: '900', letterSpacing: 0.8, marginTop: 7 },
  warn: { color: palette.amberSoft, fontSize: 13, lineHeight: 19, marginTop: 18 },
  primary: {
    backgroundColor: palette.cyan,
    borderRadius: radius.medium,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 22,
  },
  primaryText: { color: palette.black, fontSize: 15, fontWeight: '800' },
  secondary: {
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    backgroundColor: palette.surface,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 10,
  },
  secondaryText: { color: palette.cyanSoft, fontSize: 15, fontWeight: '700' },
  footnote: { color: palette.textDim, fontSize: 12, lineHeight: 18, marginTop: 22 },
  pressed: { opacity: 0.72 },
  buttonDisabled: { opacity: 0.45 },
});
