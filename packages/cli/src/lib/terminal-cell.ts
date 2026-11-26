import stringWidth from "string-width";

const cellSegmenter = new Intl.Segmenter();

/** A table cell filled to `width` terminal columns, or cut to `width - 1` columns plus "…" without splitting a
 *  character. Measured in columns, not string length, so wide (CJK) and combining text keeps the next column in place.
 *  Shared by `rig ps` and the `rig workflow` renderers. */
export function fitCell(value: string, width: number): string {
  if (stringWidth(value) > width) {
    const limit = width - 1;
    let prefix = "";
    let used = 0;
    for (const { segment } of cellSegmenter.segment(value)) {
      const segmentWidth = stringWidth(segment);
      if (used + segmentWidth > limit) break;
      prefix += segment;
      used += segmentWidth;
    }
    value = prefix + "…";
  }
  return value + " ".repeat(width - stringWidth(value));
}
