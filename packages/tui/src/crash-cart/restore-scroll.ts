// B1 ROUND 4 (HIGH-2) — the restore view's scroll input logic, pure + phase-agnostic. The crash-cart
// shell advertises "↑↓ scroll" whenever the restore content overflows the viewport, in EVERY phase; this
// is the logic that makes that affordance real (an advertised-but-unwired affordance is exactly the
// defect class 5.2 named). main.ts calls it BEFORE the phase-specific keys, so running / detached / done
// all scroll — reaching the lifecycle action row (cancel / reattach) below the fold on a large fleet.

/** A resolved scroll intent, or null when the event is not a scroll key. */
export type ScrollKey = "up" | "down" | null;

/** Map an input event to a scroll intent: ↑/↓ arrows and k/j (vim). Anything else → null. */
export function scrollKeyOf(ev: { type: string; key?: string; ch?: string }): ScrollKey {
  if (ev.type === "key" && (ev.key === "up" || ev.key === "down")) return ev.key === "up" ? "up" : "down";
  if (ev.type === "char" && ev.ch === "k") return "up";
  if (ev.type === "char" && ev.ch === "j") return "down";
  return null;
}

export function clampScroll(offset: number, maxOffset: number): number {
  return Math.max(0, Math.min(Math.max(0, maxOffset), offset));
}

/** The next scroll offset for a scroll key, clamped to [0, maxOffset]; null when `key` is not a scroll
 *  key (so the caller falls through to the phase-specific keys). Phase-agnostic BY DESIGN — the same
 *  scroll works in running, detached, and done. */
export function nextScrollOffset(key: ScrollKey, offset: number, maxOffset: number): number | null {
  if (key === null) return null;
  return clampScroll(offset + (key === "down" ? 1 : -1), maxOffset);
}
