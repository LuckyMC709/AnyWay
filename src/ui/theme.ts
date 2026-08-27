import type { TextStyle, ViewStyle } from 'react-native';

export const palette = {
  background: '#03091A',
  backgroundRaised: '#061126',
  surface: '#0A1730',
  surfaceRaised: '#10213D',
  surfaceSoft: '#0C1B35',
  border: '#1A3153',
  borderStrong: '#294A70',
  text: '#F7FAFF',
  textMuted: '#A2B2C8',
  textDim: '#6F829D',
  cyan: '#19C8F4',
  cyanSoft: '#8BE8FF',
  cyanWash: 'rgba(25, 200, 244, 0.12)',
  amber: '#FFB31A',
  amberSoft: '#FFD87A',
  amberWash: 'rgba(255, 179, 26, 0.12)',
  green: '#3DDC97',
  greenWash: 'rgba(61, 220, 151, 0.12)',
  red: '#FF5E67',
  redStrong: '#D72D3A',
  redWash: 'rgba(255, 94, 103, 0.12)',
  white: '#FFFFFF',
  black: '#02050D',
} as const;

export const radius = {
  small: 10,
  medium: 16,
  large: 22,
  pill: 999,
} as const;

export const shadow: ViewStyle = {
  shadowColor: '#000000',
  shadowOffset: { width: 0, height: 10 },
  shadowOpacity: 0.24,
  shadowRadius: 20,
  elevation: 8,
};

export const type = {
  eyebrow: {
    color: palette.cyan,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  } satisfies TextStyle,
  screenTitle: {
    color: palette.text,
    fontSize: 30,
    lineHeight: 35,
    fontWeight: '800',
    letterSpacing: -0.7,
  } satisfies TextStyle,
  sectionTitle: {
    color: palette.text,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '700',
  } satisfies TextStyle,
  body: {
    color: palette.textMuted,
    fontSize: 14,
    lineHeight: 21,
  } satisfies TextStyle,
  caption: {
    color: palette.textDim,
    fontSize: 12,
    lineHeight: 17,
  } satisfies TextStyle,
} as const;
