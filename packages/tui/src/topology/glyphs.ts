// SPIKE — the founder's 4-glyph status vocabulary as a RENDER MAPPING over
// the EXISTING projection states (arch binding 2, R7-clean, grounded
// @12862302). The 4 buckets COLLAPSE the richer existing states; nothing here
// invents state, and a projection with no value renders honest-unknown ○
// (PIN-2 as a glyph — NEVER a fabricated ●).
//
//   ● active/done   = startupStatus ready + session running; S19 MR3 splits
//                     the COLOR by activity (actActive vs actIdle roles) —
//                     the glyph stays one honest ●
//   ◐ partial/%     = the existing amber-attention family: startupStatus/
//                     lifecycle attention_required, needs_input, heldReason
//                     (ps-projection.ts seatNeedsAttention minus `failed`,
//                     which gets its own glyph). ctx% may overlay.
//   ○ queued/unknown= the SHIPPED unknown stateGlyph (compose.ts a.idle===null
//                     → "unknown") + pending/queued/no-session — honest-unknown
//   ✕ failed        = startupStatus failed / session stopped-failed
//
// Edge kinds → line COLOR (founder refinement: lines, no labels):
//   delegates_to = accent(teal) · collaborates_with = ok(green) ·
//   escalates_to = warn(amber); any other served kind renders dim (honest:
//   the kind string is data — unknown kinds are not forced into a bucket).
import type { Token } from "../theme.js";
import type { GraphNodeData } from "./graph-types.js";

export interface StatusGlyph {
  glyph: "●" | "◐" | "○" | "✕";
  token: Token;
  /** ctx% overlay text ("63%") when the ◐ bucket has a served percentage */
  overlay: string | null;
}

export function statusGlyph(data: GraphNodeData): StatusGlyph {
  const activity = data.agentActivity?.state;
  if (data.startupStatus === "failed" || data.status === "failed" || data.status === "stopped")
    return { glyph: "✕", token: "error", overlay: null };
  if (data.startupStatus === "attention_required" || data.heldReason != null || activity === "needs_input")
    return {
      glyph: "◐",
      token: "actAttention",
      overlay: data.contextUsedPercentage != null ? `${Math.round(data.contextUsedPercentage)}%` : null,
    };
  if (data.startupStatus === "ready" && data.status === "running") {
    // S19 MR3: ACTIVITY splits the ● bucket by color ROLE (glyph honesty
    // unchanged) — actively-working vs idle are visibly distinct
    const working = activity === "running" || data.terminalActive === true;
    return { glyph: "●", token: working ? "actActive" : "actIdle", overlay: null };
  }
  // everything else — pending, queued, detached, no session — is the honest
  // ○ bucket, rendered wherever the projection has no value (role: detached)
  return { glyph: "○", token: "actDetached", overlay: null };
}

/** S19 round-4 (guard finding 4): the EXPLORER row's status glyph+role,
 * folded from the SERVED AgentRow status vocabulary (hydrate.toAgentRow
 * derives it verbatim from the projection: failed / attention_required /
 * needs_input / active / idle / sessionStatus-or-"unknown"; the demo fixture
 * additionally uses the legacy "needs-attention" spelling). Same honest
 * 4-glyph vocabulary + activity roles as the topology statusGlyph — anything
 * not positively known renders ○, never a fabricated ●. */
export function rowStatusGlyph(agent: { status: string }): Pick<StatusGlyph, "glyph" | "token"> {
  const s = agent.status;
  if (s === "failed") return { glyph: "✕", token: "error" };
  if (s === "attention_required" || s === "needs_input" || s === "needs-attention")
    return { glyph: "◐", token: "actAttention" };
  if (s === "active") return { glyph: "●", token: "actActive" };
  if (s === "idle") return { glyph: "●", token: "actIdle" };
  return { glyph: "○", token: "actDetached" };
}

export function edgeToken(kind: string): Token {
  if (kind === "delegates_to") return "accent";
  if (kind === "collaborates_with") return "ok";
  if (kind === "escalates_to") return "warn";
  return "dim";
}
