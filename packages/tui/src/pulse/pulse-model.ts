// PULSE view data model (5.2 Wave B). A reusable, view-local model so the pulse
// row/section renderers (pulse/render-pulse.ts) can be shared — crash-cart rides
// the same renderers (plan §crash-cart-pre-work). Increment 1 populates this from
// a STATIC demo fixture reproducing the approved mock's EXACT rows; increments
// 2-3 build it from SHIPPED daemon reads (no new surface).
import type { Token } from "../theme.js";

/** One exception row: an accent glyph + bold subject + plain claim + dim metadata. */
export interface PulseException {
  glyph: string; // ● / ◌ / ⧗ per the mock
  token: Token; // the row's accent (see PULSE_SECTION_TOKENS)
  subject: string; // bold subject (mock <b>)
  claim: string; // plain claim text
  meta: string; // dim trailing metadata (age / hint)
}

export interface PulseExceptionSection {
  glyph: string; // ▲ / ◌ / ⧗ header glyph
  token: Token;
  label: string; // NEEDS YOU / PARKED WITH BATON / BLOCKED ON AGENTS
  rows: PulseException[];
}

export interface PulseLaneRow {
  glyph: string; // ● / ✓ / ○
  token: Token;
  time?: string; // dim time (JUST FINISHED)
  label: string; // seat+work / label
  selected?: boolean; // the mock .sel row
}

export interface PulseLane {
  label: string; // NOW / JUST FINISHED / UP NEXT
  count: number; // header (n) — MUST equal rows.length referent (honesty floor)
  rows: PulseLaneRow[];
}

export interface PulseModel {
  exceptions: PulseExceptionSection[]; // EMPTY section omitted entirely (empty-strip-is-silence)
  lanes: [PulseLane, PulseLane, PulseLane]; // NOW, JUST FINISHED, UP NEXT
  footer: { active: number; parked: number; waitingYou: number; updatedAgo: string };
}

// The mock section accents (▲ err / ◌ warn / ⧗ info). D4 RESOLVED (lock owner,
// 2026-08-06, option (a)): the `info`-class semantic token bearing the mock's
// EXACT #8fb8d8 is added to the theme (info-class, reusable — not blocked-blue),
// so `⧗ BLOCKED` renders the mock's blue directly. Glyph/label/ordering final.
export const PULSE_INFO_TOKEN: Token = "info";

/** Increment-1 static fixture — the approved mock's EXACT rows (render contract). */
export function demoPulseModel(): PulseModel {
  return {
    exceptions: [
      {
        glyph: "▲",
        token: "error",
        label: "NEEDS YOU",
        rows: [
          { glyph: "●", token: "error", subject: "push-go", claim: " — 0.5.0 cut packet ready · waiting on you", meta: " · 22m" },
          { glyph: "●", token: "warn", subject: "style verdict", claim: " — slice-20 routing pixels · waiting on you", meta: " · 3h" },
        ],
      },
      {
        glyph: "◌",
        token: "warn",
        label: "PARKED WITH BATON",
        rows: [
          { glyph: "◌", token: "warn", subject: "dev.qa", claim: " · qitem 8f3a… in-progress 47m idle, no handoff", meta: " → enter: transcript check" },
        ],
      },
      {
        glyph: "⧗",
        token: PULSE_INFO_TOKEN,
        label: "BLOCKED ON AGENTS",
        rows: [
          { glyph: "⧗", token: PULSE_INFO_TOKEN, subject: "dev50.driver", claim: " blocked on review-r1 · \"terminal verdict for 51209941\"", meta: " · 1h" },
        ],
      },
    ],
    lanes: [
      {
        label: "NOW",
        count: 4,
        rows: [
          { glyph: "●", token: "ok", label: "dev.impl  slice 51-01 stub" },
          { glyph: "●", token: "ok", label: "orch.lead fold receipt" },
          { glyph: "●", token: "ok", label: "qa.seat   matrix leg B" },
          { glyph: "●", token: "ok", label: "oversight.watch  token sweep", selected: true },
        ],
      },
      {
        label: "JUST FINISHED",
        count: 3,
        rows: [
          { glyph: "✓", token: "ok", time: "14:02", label: "slice-03 close-out" },
          { glyph: "✓", token: "ok", time: "13:44", label: "repair fold" },
          { glyph: "✓", token: "ok", time: "13:10", label: "terminal CLEAR" },
        ],
      },
      {
        label: "UP NEXT",
        count: 5,
        rows: [
          { glyph: "○", token: "dim", label: "51-02 scenario runner" },
          { glyph: "○", token: "dim", label: "RM ceremony" },
          { glyph: "○", token: "dim", label: "51-03 seed scenarios" },
          { glyph: "○", token: "dim", label: "…" },
        ],
      },
    ],
    footer: { active: 4, parked: 1, waitingYou: 2, updatedAgo: "2s ago" },
  };
}
