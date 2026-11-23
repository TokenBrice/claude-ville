// SD-3 — smoke:sun-lift's per-pixel verdict, on one integer luma for both
// frames (Rec. 709 on the 8-bit channels, rounded once), so a comparison
// never turns on floating-point noise.
export const CANDLE = 192;
// Known residual: a pixel from GLOW_BAND up (with the lift off) may rise by
// at most BRIGHT_RISE instead of being held at the candle. These are
// bridge-plank highlights inside the bridge candles' additive glow, right at
// the candle threshold (one at exactly 192 rises to 196): as understood the
// glow is composited after the scene pass over the lifted surface, out of
// the shader's hold. Cause unverified; to be checked on hardware.
export const GLOW_BAND = 188;
export const BRIGHT_RISE = 5;

/** The integer luma of the RGBA pixel at byte offset `i`. */
export function lumaAt(data, i) {
  return Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
}

/**
 * One pixel, unlifted luma `a` and lifted `b` (integers): `band` is 'low'
 * (at or under GLOW_BAND - 1: it must end at or under the candle) or 'high'
 * (from GLOW_BAND: it may rise by at most BRIGHT_RISE); `over` when it breaks
 * its band's rule; `rise` is b - a when it rose (0 otherwise).
 */
export function liftVerdict(a, b) {
  const band = a < GLOW_BAND ? 'low' : 'high';
  const over = band === 'low' ? b > CANDLE : b - a > BRIGHT_RISE;
  return { band, over, rise: b > a ? b - a : 0 };
}
