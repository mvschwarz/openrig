// PULSE view data model (5.2 Wave B). A reusable, view-local model so the pulse
// row/section renderers (pulse/render-pulse.ts) can be shared — crash-cart rides
// the same renderers (plan §crash-cart-pre-work). Increment 1 populates this from
// a STATIC demo fixture reproducing the approved mock's EXACT rows; increments
// 2-3 build it from SHIPPED daemon reads (no new surface).
import type { Token } from "../theme.js";
import type { FleetSnapshot, QueueRead } from "../types.js";

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
  /** Honesty-floor placeholder for a DEFERRED (not-yet-served) read: when set,
   * the section renders its header WITHOUT a (n) count and a single dim line
   * carrying this text — the explicit "read pending" transition-state form,
   * NOT a ran-join (whose zero result is silence). See buildPulseModel PARKED. */
  pending?: string;
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

// mirror of daemon human-route-enforcer.ts isHumanSeatSession — keep byte-identical to that canonical regex.
// EXPORTED so hydrate reuses this ONE copy (no second mirror) to skip resolving human-park blockers.
const HUMAN_SEAT_SESSION_PATTERN = /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/;
export function isHumanSeatSession(value: string | null | undefined): boolean {
  return typeof value === "string" && HUMAN_SEAT_SESSION_PATTERN.test(value);
}

/** Coarse human age for an exception row's dim meta. Derives from the served
 * timestamp relative to the caller's clock; an absent/unparseable stamp renders
 * as "" (honest-unknown — never a fabricated age). */
function ageLabel(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/** First non-empty line of a body, trimmed — the NEEDS-YOU subject fallback. */
function bodyHead(body: string): string {
  return (body.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}

/** ▲ NEEDS YOU rows — the attention read IS the human-facing set (daemon-filtered);
 * subject from summary, fallback body head; age from claimedAt (fallback tsUpdated). */
function needsRows(attention: QueueRead[], nowMs: number): PulseException[] {
  return attention.map((q) => {
    const age = ageLabel(q.claimedAt ?? q.tsUpdated, nowMs);
    return {
      glyph: "●",
      token: "error" as Token,
      subject: q.summary ?? (bodyHead(q.body) || q.destinationSession),
      claim: "",
      meta: age ? ` · ${age}` : "",
    };
  });
}

/** ⧗ BLOCKED ON AGENTS rows — filter the state=blocked read to NON-human
 * blockers (human-blocked already appear under NEEDS YOU), then NAME the blocking
 * AGENT. blockedOn is a qitem POINTER for agent-blocks (a session only for
 * human-park), so the agent is the blocker qitem's OWNER — hydrate resolves it
 * into blockerSession (label==referent, the founder-caught class). Fallback to
 * the raw blockedOn when unresolved (gate name / lookup miss) — honest, never
 * fabricated. Render: blocked-seat · "blocked on" AGENT · dim(reason) · age. */
function blockedRows(blocked: QueueRead[], nowMs: number): PulseException[] {
  return blocked
    // exclude human-park whether it names the human in blockedOn (session form)
    // or resolves to a human owner — those belong under NEEDS YOU.
    .filter((q) => !isHumanSeatSession(q.blockedOn) && !isHumanSeatSession(q.blockerSession))
    .map((q) => {
      const age = ageLabel(q.claimedAt ?? q.tsUpdated, nowMs);
      const reason = q.summary ?? bodyHead(q.body);
      const meta = [reason, age].filter(Boolean).join(" · ");
      const blocker = q.blockerSession ?? q.blockedOn ?? "—";
      return {
        glyph: "⧗",
        token: PULSE_INFO_TOKEN,
        subject: q.destinationSession,
        claim: ` blocked on ${blocker}`,
        meta: meta ? ` · ${meta}` : "",
      };
    });
}

/** Increment-2 LIVE builder — the exception sections from the hydrated snapshot;
 * lanes + footer stay static (demoPulseModel) until their reads land. The two
 * LIVE joins obey empty-strip-is-silence (a ran join yielding zero is OMITTED);
 * PARKED is the DEFERRED read and renders the non-silent honesty-floor line. */
export function buildPulseModel(snap: FleetSnapshot, nowMs: number = Date.now()): PulseModel {
  const demo = demoPulseModel();
  const exceptions: PulseExceptionSection[] = [];

  const needs = needsRows(snap.attention, nowMs);
  // empty-strip-is-silence: a ran join with zero items is OMITTED (silence == zero)
  if (needs.length > 0) exceptions.push({ glyph: "▲", token: "error", label: "NEEDS YOU", rows: needs });

  // ◌ PARKED WITH BATON — DEFERRED: the per-seat idle-age (ageSeconds computed
  // then discarded at packages/daemon/src/domain/seat-activity-service.ts:77) is
  // not projected; PARKED lands in a later increment when it is. Until then this
  // is the NON-SILENT honesty-floor placeholder — an omitted section would
  // falsely claim "join ran, zero exceptions = all good".
  exceptions.push({ glyph: "◌", token: "warn", label: "PARKED WITH BATON", rows: [], pending: "— idle-age read pending" });

  const blocked = blockedRows(snap.blocked, nowMs);
  if (blocked.length > 0) exceptions.push({ glyph: "⧗", token: PULSE_INFO_TOKEN, label: "BLOCKED ON AGENTS", rows: blocked });

  return { exceptions, lanes: demo.lanes, footer: demo.footer };
}
