/**
 * Tiny color helpers for the theme system (PLAN §7). Theme presets ship a
 * compact palette (hex); we derive the full NARU token set from it. All NARU
 * tokens are stored as bare HSL triplets ("h s% l%") so the CSS can use both
 * `hsl(var(--x))` and `hsl(var(--x) / 0.3)`.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  // drop alpha if present (#rrggbbaa)
  if (h.length === 8) h = h.slice(0, 6);
  const n = parseInt(h.padEnd(6, "0").slice(0, 6), 16);
  // invalid hex → black, not NaN (which would poison every derived token)
  if (Number.isNaN(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

function triplet(hsl: { h: number; s: number; l: number }): string {
  return `${Math.round(hsl.h)} ${Math.round(hsl.s * 100)}% ${Math.round(hsl.l * 100)}%`;
}

/** Hex → bare HSL triplet ("h s% l%"). */
export function hexToTriplet(hex: string): string {
  return triplet(rgbToHsl(parseHex(hex)));
}

/** Linear blend of two hex colors (in RGB) → HSL triplet. t=0 → a, t=1 → b. */
export function mixTriplet(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const lerp = (x: number, y: number) => Math.round(x + (y - x) * t);
  return triplet(
    rgbToHsl({ r: lerp(ca.r, cb.r), g: lerp(ca.g, cb.g), b: lerp(ca.b, cb.b) })
  );
}

/** Relative luminance (0..1) of a hex color. */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** A readable foreground triplet (near-white or near-black) over `hex`. */
export function readableOn(hex: string): string {
  return luminance(hex) > 0.55 ? "240 12% 9%" : "0 0% 100%";
}
