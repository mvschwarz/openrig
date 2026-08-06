// PULSE view data model (5.2 Wave B). A reusable, view-local model so the pulse
// row/section renderers (pulse/render-pulse.ts) can be shared — crash-cart rides
// the same renderers (plan §crash-cart-pre-work). Increment 1 populates this from
// a STATIC demo fixture reproducing the approved mock's EXACT rows; increments
// 2-3 build it from SHIPPED daemon reads (no new surface).
import type { Token } from "../theme.js";
import type { Action, FleetSnapshot, QueueRead, SeatActivitySummary } from "../types.js";
import { findAgentBySession } from "../state.js";

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
  /** incr-5 motion budget: this NOW seat produced fresh pane output inside the
   * one-shot flash window (a served terminalActive false→true onset, keyed by
   * the same agent key the table's row flash uses). Set by renderPulseScreen from
   * the refresh owner's rowFlashes; painted PER-CELL (inverse on THIS cell only,
   * never the zipped sibling cells). Reduced motion / window expiry clears it. */
  flashed?: boolean;
  /** incr-4 drill-in: the Action Enter/click dispatches on this row. Present on
   * every REAL lane row (absent on the "…" overflow marker, which is not an
   * entity). A row about a seat resolvable in the topology drills to that AGENT
   * (recovering the full identity the compact lane label drops); an unresolvable
   * seat degrades to a `notice` that reveals the full identity — honest, never a
   * dead key. Rows with no action are not registered as selection targets. */
  action?: Action;
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

/** The subject/detail boundary the mock's NEEDS-YOU rows use: "<who/what> — <detail>"
 * (space, EM DASH U+2014, space). The founder's Option-1 taste ruling: the who/what
 * SUBJECT leads in bold, the detail plain after. */
const NEEDS_SUBJECT_SEP = " — ";

/** ▲ NEEDS YOU rows — the attention read IS the human-facing set (daemon-filtered);
 * subject from summary, fallback body head; age from claimedAt (fallback tsUpdated).
 *
 * Founder Option-1 taste ruling (resolves the incr-2 bold/plain disclosure): the
 * who/what SUBJECT leads in BOLD, the detail plain after. We split on the " — "
 * boundary the served summary AFFORDS (the mock's own subject/detail convention) —
 * subject = before it (bold via renderExceptionSection), claim = from it onward
 * (plain, keeping the separator so the run reads naturally). A summary WITHOUT the
 * boundary renders whole-as-subject: honest, no synthesis the flat summary can't
 * support. (A guaranteed subject for every row would need a served subject field or
 * an authored-summary convention — a served-data question, not this increment.) */
function needsRows(attention: QueueRead[], nowMs: number): PulseException[] {
  return attention.map((q) => {
    const age = ageLabel(q.claimedAt ?? q.tsUpdated, nowMs);
    const full = q.summary ?? (bodyHead(q.body) || q.destinationSession);
    const sep = full.indexOf(NEEDS_SUBJECT_SEP);
    return {
      glyph: "●",
      token: "error" as Token,
      subject: sep > 0 ? full.slice(0, sep) : full,
      claim: sep > 0 ? full.slice(sep) : "",
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

/** Short qitem reference for a PARKED row — the trailing id segment, 4 chars +
 * ellipsis (mock "8f3a…"). NEVER the full pointer (label==referent honesty). */
function qitemShort(qitemId: string): string {
  const tail = qitemId.split("-").pop() ?? qitemId;
  return `${tail.slice(0, 4)}…`;
}

/** ◌ PARKED WITH BATON rows — the premature-park join (IMPL-PLAN §exceptions:
 * in-progress qitem ∧ idle owner ∧ no handoff — queue ⋈ ps/activity). "idle
 * owner" is the SHIPPED ps/activity idle boolean (terminalActive===false); a
 * null signal is honest-unknown and EXCLUDED (never assumed idle). The idle
 * DURATION is a VIEW derived HERE from the owner's raw lastActivityAt (arch
 * 3a947fb1) + the reader clock (nowMs) — the renderer-side test-clock seam,
 * DISTINCT from the .cjs OPENRIG_TEST_CLOCK_NOW env clock. Render: owner ·
 * qitem-short · idle-duration · no-handoff · the drill hint. */
function parkedRows(
  inProgress: QueueRead[],
  seatBySession: Map<string, SeatActivitySummary>,
  nowMs: number,
): PulseException[] {
  const out: PulseException[] = [];
  for (const q of inProgress) {
    if (q.state !== "in-progress") continue;       // defensive: the read is already state=in-progress
    if (q.handedOffTo != null) continue;           // handed off → not a stranded baton
    const seat = seatBySession.get(q.destinationSession);
    if (!seat || seat.terminalActive !== false) continue; // IDLE owner ONLY (null ≠ idle — honest-unknown)
    const idle = ageLabel(seat.lastActivityAt, nowMs);
    // r1 belt (incr-3): a false-active seat carries a record, so it carries a
    // lastActivityAt (same-observation ladder) → this fallback is unreachable
    // post-fold, purely defensive against a bare "in-progress  idle" if the age
    // is ever absent/unparseable — never a fabricated duration.
    const idleText = idle ? `${idle} idle` : "idle (age unknown)";
    out.push({
      glyph: "◌",
      token: "warn",
      subject: q.destinationSession,
      claim: ` · qitem ${qitemShort(q.qitemId)} in-progress ${idleText}, no handoff`,
      meta: " → enter: transcript check",
    });
  }
  return out;
}

/** Per-lane DISPLAY cap. A lane never dumps an unbounded set; overflow past the
 * cap is signalled explicitly (UP NEXT renders a "…" marker with the TRUE total
 * in the header) — never a silent truncation (see [[pagination-terminates-on-data-not-budgets]]). */
const LANE_ROW_CAP = 5;

/** Absolute UTC clock label for a JUST FINISHED transition time (e.g. "11:44").
 * UTC keeps it deterministic + TZ-independent; an unparseable stamp renders "". */
function hhmm(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** The drill-in Action for a lane row keyed on a SEAT session. A seat resolvable
 * in the topology drills to that AGENT (the shipped agent drill — recovers the
 * full identity the compact lane label drops, parity with clicking the agent
 * anywhere); an unresolvable seat (remote/absent from the local topology) degrades
 * to a `notice` that still reveals the full identity — honest, never a dead key.
 * Shipped-reads-only: no invented qitem-detail endpoint (a missing detail read is
 * a routed finding, not an improvised surface). */
function seatRowAction(snap: FleetSnapshot, session: string, fullDetail: string): Action {
  const found = findAgentBySession(snap, session);
  if (found) return { type: "drill", resource: "agent", name: found.agent.name, target: { host: found.host.name, rig: found.rig.name, pod: found.pod.name } };
  return { type: "notice", message: fullDetail };
}

/** ● NOW rows — running seats with active work: each ACTIVE seat
 * (terminalActive===true) joined to its in-progress qitem (IMPL-PLAN §lanes).
 * null/false-activity owners are excluded here (idle → PARKED; null → honest-
 * unknown). An active seat with no in-progress qitem is still running, so it is
 * shown bare (the seat is the load-bearing referent; its work is context). The
 * lane LABEL is the seat's COMPACT logicalId (r1 mock-authority ruling — short
 * canonical forms in lanes, full sessions in exceptions); the full session is
 * recovered on drill-in via the row's action. Both inputs already ride the
 * snapshot from incr-2b — NO new read. */
function nowRows(seatActivity: SeatActivitySummary[], inProgress: QueueRead[], snap: FleetSnapshot): PulseLaneRow[] {
  const workBySession = new Map<string, QueueRead>();
  for (const q of inProgress) if (!workBySession.has(q.destinationSession)) workBySession.set(q.destinationSession, q);
  const out: PulseLaneRow[] = [];
  for (const seat of seatActivity) {
    if (seat.terminalActive !== true) continue; // ACTIVE only (null ≠ active — honest-unknown)
    const q = workBySession.get(seat.session);
    const work = q ? (q.summary ?? bodyHead(q.body)) : "";
    // COMPACT label = logicalId; the FULL session lives in the drill action.
    const label = work ? `${seat.logicalId}  ${work}` : seat.logicalId;
    const fullDetail = work ? `${seat.session} · ${work}` : seat.session;
    out.push({ glyph: "●", token: "ok", label, action: seatRowAction(snap, seat.session, fullDetail) });
  }
  return out;
}

/** ✓ JUST FINISHED rows — recent terminal transitions newest-FINISHED-first.
 * The shipped /list read serves ts_created order, so we re-sort by tsUpdated
 * DESC (the finish time) and cap to a recent window (count == rendered — this is
 * inherently a WINDOW, not a total). Time = the transition's tsUpdated (HH:MM). */
function finishedRows(recent: QueueRead[], cap: number, snap: FleetSnapshot): PulseLaneRow[] {
  return [...recent]
    .sort((a, b) => Date.parse(b.tsUpdated) - Date.parse(a.tsUpdated))
    .slice(0, cap)
    .map((q) => {
      const label = q.summary ?? bodyHead(q.body);
      // drill to the seat that FINISHED it (destinationSession → agent).
      return { glyph: "✓", token: "ok" as Token, time: hhmm(q.tsUpdated), label, action: seatRowAction(snap, q.destinationSession, `${q.destinationSession} · ${label}`) };
    });
}

/** ○ UP NEXT lane — the unclaimed pending backlog. Carried in the daemon's
 * SERVED order (ts_created DESC — verbatim; re-sorting by an invented priority
 * scale the daemon does not serve would be exactly the forbidden client-side
 * synthesis). Beyond the display cap the last row is a "…" overflow marker and
 * the header count is the TRUE total (honesty floor — the count is the referent
 * total, the rows are the rendered subset). */
function upNextLane(pending: QueueRead[], cap: number, snap: FleetSnapshot): PulseLane {
  const unclaimed = pending.filter((q) => q.claimedAt == null); // unclaimed only (claimedAt null)
  const toRow = (q: QueueRead): PulseLaneRow => {
    const label = q.summary ?? bodyHead(q.body);
    // drill to the seat the work is DESTINED for (destinationSession → agent).
    return { glyph: "○", token: "dim", label, action: seatRowAction(snap, q.destinationSession, `${q.destinationSession} · ${label}`) };
  };
  // The overflow marker is NOT an entity → it carries no action (never a selection target).
  const rows = unclaimed.length > cap
    ? [...unclaimed.slice(0, cap - 1).map(toRow), { glyph: "○", token: "dim" as Token, label: "…" }]
    : unclaimed.map(toRow);
  return { label: "UP NEXT", count: unclaimed.length, rows };
}

/** Increment-3 LIVE builder — exception sections (incr 2/2b) PLUS the three
 * lanes + footer, all from the hydrated snapshot's SHIPPED reads. The LIVE joins
 * obey empty-strip-is-silence for the EXCEPTION sections (a ran join yielding
 * zero is OMITTED); the LANES always render (a lane with zero rows is an honest
 * "(0)", not silence — an empty backlog IS information). The footer counts are
 * derived FROM the built model so header numbers can never diverge from their
 * referent sets (label==referent). demoPulseModel is retained only as a static
 * renderer fixture (spatial-contract tests), no longer this builder's source. */
export function buildPulseModel(snap: FleetSnapshot, nowMs: number = Date.now()): PulseModel {
  const exceptions: PulseExceptionSection[] = [];

  const needs = needsRows(snap.attention, nowMs);
  // empty-strip-is-silence: a ran join with zero items is OMITTED (silence == zero)
  if (needs.length > 0) exceptions.push({ glyph: "▲", token: "error", label: "NEEDS YOU", rows: needs });

  // ◌ PARKED WITH BATON — now a LIVE ran-join (arch 3a947fb1 landed the owner
  // idle-age fact): in-progress qitems whose owner is idle and un-handed-off,
  // idle-duration derived at the renderer. Zero parked = silence (OMITTED), like
  // the other live joins — the incr-2 "read pending" placeholder is retired.
  const seatBySession = new Map(snap.seatActivity.map((s) => [s.session, s]));
  const parked = parkedRows(snap.inProgress, seatBySession, nowMs);
  if (parked.length > 0) exceptions.push({ glyph: "◌", token: "warn", label: "PARKED WITH BATON", rows: parked });

  const blocked = blockedRows(snap.blocked, nowMs);
  if (blocked.length > 0) exceptions.push({ glyph: "⧗", token: PULSE_INFO_TOKEN, label: "BLOCKED ON AGENTS", rows: blocked });

  const now = nowRows(snap.seatActivity, snap.inProgress, snap);
  const finished = finishedRows(snap.recentlyFinished, LANE_ROW_CAP, snap);
  const lanes: [PulseLane, PulseLane, PulseLane] = [
    { label: "NOW", count: now.length, rows: now },
    { label: "JUST FINISHED", count: finished.length, rows: finished },
    upNextLane(snap.pending, LANE_ROW_CAP, snap),
  ];

  // Footer counts ARE the built referent sets (label==referent — never a second
  // source of truth). "updated" freshness from the TUI's own hydration stamp;
  // absent (pre-first-hydration) → honest "—", never a fabricated age.
  const parkedCount = exceptions.find((s) => s.label === "PARKED WITH BATON")?.rows.length ?? 0;
  const waitingYou = exceptions.find((s) => s.label === "NEEDS YOU")?.rows.length ?? 0;
  const ago = ageLabel(snap.hydratedAt, nowMs);
  const footer = { active: now.length, parked: parkedCount, waitingYou, updatedAgo: ago ? `${ago} ago` : "—" };

  return { exceptions, lanes, footer };
}
