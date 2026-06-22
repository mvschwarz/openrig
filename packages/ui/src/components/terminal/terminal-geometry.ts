// OPR.0.4.0.39 - the single source of truth for the static<->live terminal mirror.
//
// Founder spec (spec-dev2-authored-2026-06-22): the static (polling-preview) and the
// live (interactive xterm) terminals are THE SAME shape - the optimal Claude/Codex
// CLI geometry, which is the live xterm's pinned 120x40 at fontSize 12 / lineHeight 1.
// The static plate renders at this exact font + 120-col width so it mirrors the live;
// ScaleToFitTerminal scales both identically to the column. Only glass (static) vs
// opaque (live) differs.
//
// Kept dependency-free (no xterm import) so the lightweight static preview can share
// it without pulling the xterm bundle into the static path.

export const LIVE_TERMINAL_RENDER_BACKGROUND = "#0c0a09";
// OPR.0.4.0.39 (founder-directed): 90 cols. Claude Code (Ink) + Codex CLI reflow to
// any width (80 is the too-narrow legacy fallback); 90 stays above that floor while
// rendering the scaled static/live mirror bigger/more legible in the grid cells than
// 120 did. MUST match the daemon broker CANONICAL_COLS (TerminalSessionBroker.ts) -
// the client xterm grid must equal the pane geometry.
export const LIVE_TERMINAL_COLS = 90;
export const LIVE_TERMINAL_ROWS = 27;
export const LIVE_TERMINAL_FONT_SIZE = 12;
export const LIVE_TERMINAL_LINE_HEIGHT = 1;
export const LIVE_TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
