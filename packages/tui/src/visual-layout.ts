/** Founder-selected L2 explorer: one quarter of the terminal, bounded so the
 * tree stays useful without stealing the factory/mission canvas. */
export function explorerWidth(cols: number): number {
  return Math.max(24, Math.min(32, Math.round(cols * 0.25)));
}

/** MOT-03: useful visible work animates at two frames per second. */
export const MOTION_FRAME_MS = 500;
