import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { palette, radius, type } from '../ui/theme';

export function AmbientBackground() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.topRing} />
      <View style={styles.topNode} />
      <View style={styles.midNode} />
      <View style={styles.bottomRing} />
      <View style={styles.bottomNode} />
      <View style={styles.meshLineOne} />
      <View style={styles.meshLineTwo} />
    </View>
  );
}

export function BrandMark({ size = 64 }: { size?: number }) {
  return (
    <Image
      source={require('../../assets/anyway-icon.png')}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.24) }}
      accessibilityIgnoresInvertColors
    />
  );
}

export function ScreenHeading({
  eyebrow,
  title,
  subtitle,
  side,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  side?: React.ReactNode;
}) {
  return (
    <View style={styles.heading}>
      <View style={styles.headingCopy}>
        <Text style={type.eyebrow}>{eyebrow}</Text>
        <Text style={styles.headingTitle}>{title}</Text>
        {subtitle ? <Text style={styles.headingSubtitle}>{subtitle}</Text> : null}
      </View>
      {side ? <View style={styles.headingSide}>{side}</View> : null}
    </View>
  );
}

export function EmptyState({
  mark = '·',
  title,
  detail,
}: {
  mark?: string;
  title: string;
  detail: string;
}) {
  return (
    <View style={styles.emptyCard}>
      <View style={styles.emptyMark}>
        <Text style={styles.emptyMarkText}>{mark}</Text>
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDetail}>{detail}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  topRing: {
    position: 'absolute',
    width: 290,
    height: 290,
    borderRadius: 145,
    borderWidth: 1,
    borderColor: 'rgba(25, 200, 244, 0.08)',
    top: -170,
    right: -105,
  },
  topNode: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(25, 200, 244, 0.28)',
    top: 72,
    right: 46,
  },
  midNode: {
    position: 'absolute',
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255, 179, 26, 0.24)',
    top: 205,
    right: 94,
  },
  bottomRing: {
    position: 'absolute',
    width: 240,
    height: 240,
    borderRadius: 120,
    borderWidth: 1,
    borderColor: 'rgba(255, 179, 26, 0.06)',
    bottom: -150,
    left: -105,
  },
  bottomNode: {
    position: 'absolute',
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 179, 26, 0.22)',
    bottom: 88,
    left: 36,
  },
  meshLineOne: {
    position: 'absolute',
    width: 94,
    height: 1,
    backgroundColor: 'rgba(25, 200, 244, 0.07)',
    top: 141,
    right: 42,
    transform: [{ rotate: '-42deg' }],
  },
  meshLineTwo: {
    position: 'absolute',
    width: 74,
    height: 1,
    backgroundColor: 'rgba(255, 179, 26, 0.06)',
    bottom: 136,
    left: 24,
    transform: [{ rotate: '52deg' }],
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 16,
  },
  headingCopy: { flex: 1 },
  headingTitle: {
    ...type.screenTitle,
    marginTop: 5,
  },
  headingSubtitle: {
    ...type.body,
    marginTop: 6,
    maxWidth: 300,
  },
  headingSide: { marginLeft: 14, paddingBottom: 2 },
  emptyCard: {
    marginHorizontal: 20,
    marginTop: 28,
    paddingHorizontal: 24,
    paddingVertical: 28,
    alignItems: 'center',
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: 'rgba(10, 23, 48, 0.82)',
  },
  emptyMark: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.cyanWash,
    borderWidth: 1,
    borderColor: 'rgba(25, 200, 244, 0.28)',
  },
  emptyMarkText: { color: palette.cyan, fontSize: 25, fontWeight: '700' },
  emptyTitle: { ...type.sectionTitle, marginTop: 14, textAlign: 'center' },
  emptyDetail: { ...type.body, marginTop: 6, textAlign: 'center' },
});
