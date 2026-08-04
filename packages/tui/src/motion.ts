// ROUND-3 mr7 — MOTION design language mechanics (founder-directed; sign-off
// of the set = open item riding the verification capture). Discipline built
// in: reduced-motion fallback for EVERYTHING, honest fallbacks (a spinner
// never fabricates progress; a bar renders real fractions only), and max ONE
// persistent animation per region (pinned at the call sites).
import type { ColorMode } from "./theme.js";

/** the env kill-switch — any of the accepted flags disables ALL motion */
export function reducedMotion(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["OPENRIG_REDUCED_MOTION"] === "1" || env["REDUCED_MOTION"] === "1" || env["NO_MOTION"] === "1";
}

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LINE_FRAMES = ["|", "/", "-", "\\"];

/** loading spinner: braille frames (truecolor/256), line frames at 16-color,
 * a STATIC dot under reduced motion — the state is still shown, honestly */
export function spinnerFrame(tick: number, mode: ColorMode, reduced: boolean): string {
  if (reduced) return "·";
  const frames = mode === "16" || mode === "none" ? LINE_FRAMES : BRAILLE_FRAMES;
  return frames[((tick % frames.length) + frames.length) % frames.length]!;
}

/** tmux-style ONE-SHOT row flash: active only within the window; never under
 * reduced motion */
export function flashActive(sinceMs: number, nowMs: number, durationMs = 600, reduced = false): boolean {
  if (reduced) return false;
  return nowMs >= sinceMs && nowMs - sinceMs < durationMs;
}

/** quiet DETERMINATE block-bar — REAL fractions only; null/NaN renders
 * nothing (a bar is a claim of measured progress, never fabricated) */
export function barCells(fraction: number | null, width: number): string {
  if (fraction == null || Number.isNaN(fraction)) return "";
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
