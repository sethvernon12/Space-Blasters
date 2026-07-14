// Types for segment.mjs (kept .mjs so the hub and the node tests share one implementation).
export interface DigitBox { x0: number; x1: number }
export function segmentDigits(
  gray: Float32Array | Uint8ClampedArray | number[],
  w: number,
  h: number,
  opts?: { inkThreshold?: number; minWidth?: number },
): DigitBox[]
