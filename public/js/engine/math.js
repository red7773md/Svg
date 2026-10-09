// Small numeric helpers shared by the engine.

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const clampInt = clamp;
export const radians = (deg) => (deg * Math.PI) / 180;
export const degrees = (rad) => (rad * 180) / Math.PI;

/** Rotate (x, y) by theta radians. */
export function rotate(x, y, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [x * c - y * s, x * s + y * c];
}
