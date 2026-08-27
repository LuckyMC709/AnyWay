import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

/** One slot's horizontal footprint; also the snap interval. */
const SLOT = 78;

export type DockMode<T extends string> = {
  key: T;
  label: string;
  /** SOS gets its own treatment: bigger, red, and impossible to mistake. */
  tone?: 'normal' | 'sos';
  /** Optional count shown as a small badge, e.g. connected neighbours. */
  badge?: number;
};

/**
 * A sliding dock where the item under the centre lens is magnified.
 *
 * The glass is built from layered translucency rather than a real blur: on
 * Android, blur only exists from API 31, so a BlurView would frost the A52 and
 * do nothing on the Note 9. Instead the lens carries a specular highlight that
 * slides against the scroll — the part that actually reads as glass catching
 * light — plus a spring that overshoots when the selection lands.
 */
export function ModeDock<T extends string>({
  modes,
  active,
  onSelect,
}: {
  modes: DockMode<T>[];
  active: T;
  onSelect: (key: T) => void;
}) {
  const { width } = useWindowDimensions();
  const scrollX = useRef(new Animated.Value(0)).current;
  const settle = useRef(new Animated.Value(1)).current;
  const listRef = useRef<ScrollView>(null);
  const sidePadding = Math.max(0, (width - SLOT) / 2);
  const activeIndex = Math.max(
    0,
    modes.findIndex((mode) => mode.key === active),
  );
  const activeMode = modes[activeIndex];
  const isSosActive = activeMode?.tone === 'sos';

  useEffect(() => {
    listRef.current?.scrollTo({ x: activeIndex * SLOT, animated: true });
    // Overshoot on arrival: the lens gives a little, like a liquid surface
    // absorbing the item rather than snapping to it.
    settle.setValue(0.82);
    Animated.spring(settle, {
      toValue: 1,
      friction: 5.5,
      tension: 140,
      useNativeDriver: true,
    }).start();
  }, [activeIndex, settle]);

  const track = Math.max(1, (modes.length - 1) * SLOT);
  // Counter-parallax: the highlight drifts across the lens as content passes
  // beneath it, so the glass looks fixed and lit while the row moves.
  const sheenShift = scrollX.interpolate({
    inputRange: [0, track],
    outputRange: [14, -14],
    extrapolate: 'clamp',
  });
  const sheenTilt = scrollX.interpolate({
    inputRange: [0, track],
    outputRange: ['-16deg', '16deg'],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.dock}>
      <View pointerEvents="none" style={styles.plateSheen} />
      <View pointerEvents="none" style={styles.rim} />

      <View pointerEvents="none" style={styles.lensLayer}>
        {isSosActive && <View style={styles.lensGlow} />}
        <Animated.View
          style={[
            styles.lens,
            isSosActive && styles.lensSos,
            { transform: [{ scale: settle }] },
          ]}
        >
          <Animated.View
            style={[
              styles.sheen,
              { transform: [{ translateX: sheenShift }, { rotate: sheenTilt }] },
            ]}
          />
          <View style={[styles.lensInnerRim, isSosActive && styles.lensInnerRimSos]} />
        </Animated.View>
      </View>

      <Animated.ScrollView
        ref={listRef as never}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={SLOT}
        disableIntervalMomentum
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: sidePadding }}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
          useNativeDriver: true,
        })}
        onMomentumScrollEnd={(event) => {
          const index = Math.round(event.nativeEvent.contentOffset.x / SLOT);
          const clamped = Math.min(modes.length - 1, Math.max(0, index));
          if (modes[clamped] && modes[clamped].key !== active) onSelect(modes[clamped].key);
        }}
      >
        {modes.map((mode, index) => {
          const inputRange = [
            (index - 2) * SLOT,
            (index - 1) * SLOT,
            index * SLOT,
            (index + 1) * SLOT,
            (index + 2) * SLOT,
          ];
          const scale = scrollX.interpolate({
            inputRange,
            outputRange: [0.56, 0.76, 1, 0.76, 0.56],
            extrapolate: 'clamp',
          });
          // Outer items sit lower, so the row reads as an arc bending under the lens.
          const translateY = scrollX.interpolate({
            inputRange,
            outputRange: [12, 5, -10, 5, 12],
            extrapolate: 'clamp',
          });
          const opacity = scrollX.interpolate({
            inputRange,
            outputRange: [0.38, 0.66, 1, 0.66, 0.38],
            extrapolate: 'clamp',
          });
          const isSos = mode.tone === 'sos';

          return (
            <Pressable
              key={mode.key}
              onPress={() => onSelect(mode.key)}
              style={styles.slot}
              accessibilityRole="tab"
              accessibilityState={{ selected: mode.key === active }}
              accessibilityLabel={mode.label}
            >
              <Animated.View
                style={[
                  styles.puck,
                  isSos && styles.puckSos,
                  { opacity, transform: [{ translateY }, { scale }] },
                ]}
              >
                <View pointerEvents="none" style={styles.puckGloss} />
                <ModeMark mode={mode.key} sos={isSos} />
                {mode.badge !== undefined && mode.badge > 0 && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{mode.badge}</Text>
                  </View>
                )}
              </Animated.View>
            </Pressable>
          );
        })}
      </Animated.ScrollView>

      <Text style={[styles.caption, isSosActive && styles.captionSos]}>
        {activeMode?.label ?? ''}
      </Text>
    </View>
  );
}

/**
 * Marks are built from plain views rather than an icon font: the project has no
 * icon dependency, and these stay crisp at every magnification step.
 */
function ModeMark({ mode, sos }: { mode: string; sos: boolean }) {
  if (sos) return <Text style={styles.sosText}>SOS</Text>;

  switch (mode) {
    case 'chats':
      return (
        <View style={styles.bubble}>
          <View style={styles.bubbleDots}>
            <View style={styles.dot} />
            <View style={styles.dot} />
            <View style={styles.dot} />
          </View>
        </View>
      );
    case 'peers':
      // Concentric rings: the radar reading of who is within reach.
      return (
        <View style={styles.radar}>
          <View style={styles.radarRingOuter} />
          <View style={styles.radarRingInner} />
          <View style={styles.radarCore} />
        </View>
      );
    case 'demo':
      return (
        <View style={styles.bars}>
          <View style={[styles.bar, { height: 8 }]} />
          <View style={[styles.bar, { height: 14 }]} />
          <View style={[styles.bar, { height: 20 }]} />
        </View>
      );
    default:
      // Sliders: the conventional shorthand for settings.
      return (
        <View style={styles.sliders}>
          <View style={styles.sliderRow}>
            <View style={[styles.sliderKnob, { marginLeft: 2 }]} />
            <View style={styles.sliderTrack} />
          </View>
          <View style={styles.sliderRow}>
            <View style={styles.sliderTrack} />
            <View style={[styles.sliderKnob, { marginRight: 2 }]} />
          </View>
        </View>
      );
  }
}

const FILL = 'rgba(255,255,255,0.055)';
const RIM = 'rgba(255,255,255,0.20)';

const styles = StyleSheet.create({
  dock: {
    paddingTop: 14,
    paddingBottom: 8,
    backgroundColor: 'rgba(15,21,30,0.94)',
  },
  // A pale wash along the top edge: the plate reads as a lit sheet rather than
  // a flat bar, without needing a gradient dependency.
  plateSheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 36,
    backgroundColor: 'rgba(255,255,255,0.035)',
  },
  rim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },

  lensLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 6,
  },
  lensGlow: {
    position: 'absolute',
    top: 0,
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: 'rgba(192,42,32,0.22)',
  },
  lens: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1,
    borderColor: RIM,
    backgroundColor: FILL,
    overflow: 'hidden',
  },
  lensSos: {
    borderColor: 'rgba(255,150,138,0.5)',
    backgroundColor: 'rgba(192,42,32,0.16)',
  },
  // Thin bright arc just inside the edge — the highlight a curved glass rim
  // catches, which is what separates "translucent panel" from "glass".
  lensInnerRim: {
    position: 'absolute',
    top: 3,
    left: 3,
    right: 3,
    height: 34,
    borderRadius: 20,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  lensInnerRimSos: { borderColor: 'rgba(255,190,182,0.24)' },
  sheen: {
    position: 'absolute',
    top: -22,
    left: 4,
    width: 34,
    height: 116,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },

  slot: {
    width: SLOT,
    alignItems: 'center',
    justifyContent: 'center',
    height: 78,
  },
  puck: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    overflow: 'hidden',
  },
  puckSos: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#c02a20',
    borderColor: 'rgba(255,176,166,0.65)',
    borderWidth: 2,
  },
  puckGloss: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '46%',
    backgroundColor: 'rgba(255,255,255,0.09)',
  },
  sosText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  caption: {
    textAlign: 'center',
    color: '#93a5bb',
    fontSize: 12.5,
    fontWeight: '700',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  captionSos: { color: '#f79c91' },

  bubble: {
    width: 24,
    height: 19,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#c3d4e8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubbleDots: { flexDirection: 'row', gap: 3 },
  dot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: '#c3d4e8' },

  radar: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  radarRingOuter: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#7f93ad',
  },
  radarRingInner: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: '#c3d4e8',
  },
  radarCore: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: '#c3d4e8' },

  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 20 },
  bar: { width: 4, borderRadius: 2, backgroundColor: '#c3d4e8' },

  sliders: { width: 24, gap: 6 },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  sliderTrack: { flex: 1, height: 2, borderRadius: 1, backgroundColor: '#c3d4e8' },
  sliderKnob: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#c3d4e8' },

  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: '#1f6feb',
    borderWidth: 2,
    borderColor: '#0f151e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#ffffff', fontSize: 10, fontWeight: '800' },
});
