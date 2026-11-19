// SD-3 — smoke:sun-lift's per-pixel verdict, on one integer luma for both
// frames (Rec. 709 on the 8-bit channels, rounded once), so a comparison
// never turns on floating-point noise.
export const CANDLE = 192;
export const BRIGHT_RISE = 5;

/** The integer luma of the RGBA pixel at byte offset `i`. */
export function lumaAt(data, i) {
  return Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
}

/**
 * One pixel, unlifted luma `a` and lifted `b` (integers): `over` when a
 * pixel at or under the candle ends above it, or one above it rises more
 * than BRIGHT_RISE; `brightRise` its rise when it already stood above the
 * candle and rose (0 otherwise).
 */
export function liftVerdict(a, b) {
  const over = a <= CANDLE ? b > CANDLE : b - a > BRIGHT_RISE;
  return { over, brightRise: a > CANDLE && b > a ? b - a : 0 };
}
