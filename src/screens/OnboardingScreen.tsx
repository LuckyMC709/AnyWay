import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { KeyboardAvoider } from '../components/KeyboardAvoider';
import { AmbientBackground, BrandMark } from '../components/VisualFoundation';
import { useMesh } from '../mesh/MeshProvider';
import { palette, radius, shadow, type } from '../ui/theme';

export function OnboardingScreen() {
  const { setNickname } = useMesh();
  const [value, setValue] = useState('');

  const canSubmit = value.trim().length > 0;

  const submit = () => {
    const trimmed = value.trim().slice(0, 24);
    if (trimmed.length === 0) return;
    setNickname(trimmed);
  };

  return (
    <KeyboardAvoider style={styles.container}>
      <AmbientBackground />
      <View style={styles.brandRow}>
        <BrandMark size={78} />
        <View style={styles.brandCopy}>
          <Text style={styles.eyebrow}>COMUNICACIÓN RESILIENTE</Text>
          <Text style={styles.title}>Anyway</Text>
        </View>
      </View>
      <Text style={styles.subtitle}>
        Una red que viaja con las personas. Mandá mensajes entre teléfonos cercanos aunque no haya
        Internet ni señal celular.
      </Text>

      <View style={styles.featureRow}>
        <Feature mark="⌁" label="Sin Internet" />
        <Feature mark="◇" label="Privado E2E" />
        <Feature mark="↗" label="Multi‑salto" />
      </View>

      <View style={styles.setupCard}>
        <Text style={styles.cardEyebrow}>TU IDENTIDAD LOCAL</Text>
        <Text style={styles.label}>¿Cómo querés que te vean los demás?</Text>
        <TextInput
          style={styles.input}
          placeholder="Escribí tu apodo"
          placeholderTextColor={palette.textDim}
          value={value}
          onChangeText={setValue}
          maxLength={24}
          autoFocus
          onSubmitEditing={submit}
          returnKeyType="done"
        />

        <Pressable
          style={({ pressed }) => [
            styles.button,
            !canSubmit && styles.buttonDisabled,
            pressed && canSubmit && styles.buttonPressed,
          ]}
          onPress={submit}
          disabled={!canSubmit}
        >
          <Text style={styles.buttonText}>Crear mi nodo</Text>
          <Text style={styles.buttonArrow}>→</Text>
        </Pressable>
      </View>

      <Text style={styles.footer}>
        Sin cuentas ni servidores. Tu identidad criptográfica se crea y permanece en este teléfono.
      </Text>
    </KeyboardAvoider>
  );
}

function Feature({ mark, label }: { mark: string; label: string }) {
  return (
    <View style={styles.feature}>
      <Text style={styles.featureMark}>{mark}</Text>
      <Text style={styles.featureLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 22,
    backgroundColor: palette.background,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  brandCopy: { marginLeft: 16, flex: 1 },
  eyebrow: {
    ...type.eyebrow,
    color: palette.amber,
  },
  title: {
    color: palette.text,
    fontSize: 38,
    lineHeight: 42,
    letterSpacing: -1.2,
    fontWeight: '900',
    marginTop: 3,
  },
  subtitle: {
    ...type.body,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 18,
  },
  featureRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 18,
    marginBottom: 24,
  },
  feature: {
    flex: 1,
    minHeight: 62,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
    backgroundColor: palette.cyanWash,
    borderWidth: 1,
    borderColor: 'rgba(25, 200, 244, 0.16)',
  },
  featureMark: { color: palette.cyan, fontSize: 17, fontWeight: '800' },
  featureLabel: { color: palette.cyanSoft, fontSize: 9, fontWeight: '800', marginTop: 3 },
  setupCard: {
    padding: 18,
    borderRadius: radius.large,
    backgroundColor: 'rgba(10, 23, 48, 0.94)',
    borderWidth: 1,
    borderColor: palette.border,
    ...shadow,
  },
  cardEyebrow: {
    color: palette.textDim,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    marginBottom: 7,
  },
  label: {
    color: palette.text,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '700',
    marginBottom: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: radius.medium,
    paddingHorizontal: 15,
    paddingVertical: 13,
    fontSize: 16,
    color: palette.text,
    backgroundColor: palette.backgroundRaised,
    marginBottom: 12,
  },
  button: {
    minHeight: 50,
    flexDirection: 'row',
    justifyContent: 'center',
    backgroundColor: palette.cyan,
    borderRadius: radius.medium,
    paddingHorizontal: 18,
    paddingVertical: 13,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: palette.black,
    fontSize: 15,
    fontWeight: '900',
  },
  buttonArrow: { color: palette.black, fontSize: 19, fontWeight: '800', marginLeft: 8 },
  buttonPressed: { opacity: 0.72 },
  footer: {
    color: palette.textDim,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    paddingHorizontal: 16,
    marginTop: 18,
  },
});
