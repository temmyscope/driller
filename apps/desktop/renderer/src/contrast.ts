/**
 * P3-13: WCAG 2.x contrast ratio between two sRGB colours, as used by
 * 1.4.3 (text, 4.5:1) and 1.4.11 (UI component boundaries, 3:1).
 *
 * Pure and DOM-free so `contrast.test.ts` can run it under `node --test`
 * against the real `:root` tokens parsed out of `styles.css` — the check
 * that keeps `--border-control` at 3:1 or better against every surface a
 * control sits on.
 */

/** Parses `#rgb` or `#rrggbb` (case-insensitive) into 0-255 channels. Throws on anything else. */
export function parseHex(hex: string): [number, number, number] {
  const digits = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())?.[1];
  if (digits === undefined) {
    throw new Error(`Not a #rgb/#rrggbb colour: ${JSON.stringify(hex)}`);
  }
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance of one 0-255 sRGB channel, linearised. */
function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** `(L1 + 0.05) / (L2 + 0.05)`, lighter over darker — symmetric, 1 to 21. */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
