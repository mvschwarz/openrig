import stringWidth from "string-width";

/** Founder-selected L2 explorer: one quarter of the terminal, bounded so the
 * tree stays useful without stealing the factory/mission canvas. */
export function explorerWidth(cols: number): number {
  return Math.max(24, Math.min(32, Math.round(cols * 0.25)));
}

/** MOT-03: useful visible work animates at two frames per second. */
export const MOTION_FRAME_MS = 500;

const graphemes = new Intl.Segmenter();

export function columns(text: string): number {
  return /^[\x20-\x7e]*$/.test(text) ? text.length : stringWidth(text);
}

/** String index after the longest whole-grapheme prefix that fits in `width` terminal columns. */
export function columnIndex(text: string, width: number): number {
  if (/^[\x20-\x7e]*$/.test(text)) return Math.min(text.length, width);
  let used = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    used += stringWidth(segment);
    if (used > width) return index;
  }
  return text.length;
}
