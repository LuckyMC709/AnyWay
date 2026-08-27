// Curated, dark-theme-friendly palette a user picks from to identify their
// messages in the broadcast/group views (Settings screen). Kept small and
// fixed rather than a full color wheel — easier to tell apart at a glance
// in a crowded public channel, and trivial to render as a row of swatches.
export const COLOR_PALETTE = [
  '#f87171', // red
  '#fb923c', // orange
  '#fbbf24', // amber
  '#4ade80', // green
  '#2dd4bf', // teal
  '#38bdf8', // sky
  '#818cf8', // indigo
  '#e879f9', // fuchsia
] as const;

export const DEFAULT_COLOR = COLOR_PALETTE[0];

/** Deterministic pick so a peer has a distinct-ish color even before they
 *  ever open Settings to choose one themselves. */
export function defaultColorForNodeId(nodeId: string): string {
  let hash = 0;
  for (let i = 0; i < nodeId.length; i++) {
    hash = (hash * 31 + nodeId.charCodeAt(i)) >>> 0;
  }
  return COLOR_PALETTE[hash % COLOR_PALETTE.length];
}

export function isValidPaletteColor(value: unknown): value is string {
  return typeof value === 'string' && (COLOR_PALETTE as readonly string[]).includes(value);
}
