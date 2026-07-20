// Living Notes Packet 2 — mission altitude (OPR.0.4.4.20 FR-7).
//
// BOARD-FIRST: every slice is an independent slot in its DERIVED lane
// (INTENT · PLAN · BUILD · REVIEW · LOCKED — BR-10 vocabulary), so
// done / in-flight / left reads at a glance. U5: a board row EXPANDS IN
// PLACE (exactly one at a time) consuming the SAME composed-review read
// contract scoped per-row — one contract, one more consumer, never a
// second endpoint — with approve + CHAT riding the same verbs as the
// slice altitude (BR-9: no board-altitude parallel writer). The
// completion ledger renders verbatim as the mission's SETTLED band with
// the triple cut-complete rule. Band order: NEEDS YOU → AGENTS → the
// board → SETTLED (delta-A: the mission AGENTS band sits directly below
// NEEDS YOU at mission:<id> scope; rows + zoom only — this band NEVER
// embeds slice pages). 40-slice invariant: lanes collapse to counts +
// attention-worthy rows; "show all" is one tap; one row per slice always.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  useMissionReview,
  useSliceReview,
  type BoardSlot,
  type ComposedMissionReview,
} from "../../hooks/useReview.js";
import { AgentsBandView } from "./AgentsBandView.js";
import { VerifyLineageCard } from "./VerifyLineageCard.js";
import { approveSlice, type ActionOutcome } from "./review-actions.js";
import { buildChatPreamble } from "./chat.js";
import { ProgressiveTerminal } from "../terminal/ProgressiveTerminal.js";
import { useInvalidateReview } from "../../hooks/useReview.js";
import { EmptyState } from "../ui/empty-state.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";

const LANES = ["INTENT", "PLAN", "BUILD", "REVIEW", "LOCKED"] as const;
const COLLAPSE_THRESHOLD = 12;
const SURFACE_ACTOR = "human@host";

const TONE_CLASS: Record<string, string> = {
  pass: "bg-emerald-100 text-emerald-900 border-emerald-300",
  fail: "bg-red-100 text-red-900 border-red-300",
  unknown: "bg-surface-variant text-on-surface-variant border-outline-variant",
};

/** U5 expansion — leads with INTENT + DELIVERED/PROOF (the mission-altitude
 *  lead pair; PRD-concise one tap deeper via the slice page), actions ride
 *  the same verbs as the slice altitude. */
function BoardRowExpansion({ slot }: { slot: BoardSlot }) {
  const detail = useSliceReview(slot.slice);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const invalidate = useInvalidateReview();

  if (detail.isLoading) return <p className="p-2 font-mono text-[10px] text-on-surface-variant">composing…</p>;
  if (detail.isError || !detail.data) return <p className="p-2 font-mono text-[10px] text-red-700">expansion unavailable</p>;
  const d = detail.data;
  const chatSession = d.agents.rows[0]?.sessionName ?? null;

  const onApprove = async () => {
    const result = await approveSlice(d.slice, SURFACE_ACTOR);
    setOutcome(result);
    if (result.ok) invalidate();
  };

  // CORRECTIVE §3.1 — the expansion reads the SAME collapsed contract as the
  // slice tab: INTENT verbatim + the DELIVERED per-item verified summary at
  // altitude (bounded — the full pairing w/ media lives on the slice page).
  const verifiedCounts = d.delivered.items.reduce(
    (acc, it) => ({ ...acc, [it.verified]: (acc[it.verified] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  return (
    <div data-testid={`board-expansion-${slot.slice}`} className="space-y-2 border-t border-outline-variant/60 bg-surface p-2">
      <div className="min-w-0 border border-outline-variant p-2">
        <h5 className="font-mono text-[10px] uppercase text-on-surface-variant">INTENT</h5>
        <MarkdownViewer content={d.intent.text ?? d.intent.degrade ?? ""} hideFrontmatter hideRawToggle />
      </div>
      <div className="min-w-0 border border-outline-variant p-2">
        <h5 className="font-mono text-[10px] uppercase text-on-surface-variant">DELIVERED</h5>
        {d.delivered.items.length === 0 ? (
          <p className="font-mono text-[11px] text-on-surface-variant">— no proof contract declared in the plan yet</p>
        ) : (
          <>
            <ul className="space-y-0.5">
              {d.delivered.items.map((it, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                  <span className="min-w-0 flex-1">{it.promised.text}</span>
                  <span
                    className={
                      it.verified === "verified"
                        ? "font-mono text-[10px] uppercase text-emerald-700 dark:text-emerald-400"
                        : it.verified === "missing"
                          ? "font-mono text-[10px] font-bold uppercase text-red-700 dark:text-red-400"
                          : "font-mono text-[10px] uppercase text-amber-700 dark:text-amber-400"
                    }
                  >
                    {it.verified === "verified" ? "✓ QA-verified" : it.verified === "missing" ? "✗ missing" : "◇ unverified"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1 font-mono text-[10px] text-on-surface-variant">
              {verifiedCounts["verified"] ?? 0}/{d.delivered.items.length} QA-verified · full pairing on the slice page
            </p>
          </>
        )}
      </div>
      <VerifyLineageCard lineage={d.lineage} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={`board-approve-${slot.slice}`}
          onClick={() => void onApprove()}
          className="border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant"
        >
          Approve
        </button>
        <button
          type="button"
          data-testid={`board-send-back-${slot.slice}`}
          disabled={!chatSession}
          title={chatSession ? `Send back via ${chatSession}` : "No owning agent resolved"}
          onClick={() => setChatOpen((v) => !v)}
          className="border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant disabled:opacity-50"
        >
          Send back (chat)
        </button>
        <Link
          to="/project/slice/$sliceId"
          params={{ sliceId: slot.slice }}
          className="font-mono text-[10px] underline text-on-surface-variant"
        >
          full slice →
        </Link>
        {outcome ? (
          <span className={`font-mono text-[10px] ${outcome.ok ? "text-emerald-800" : "text-red-700"}`}>{outcome.message}</span>
        ) : null}
      </div>
      {chatOpen && chatSession ? (
        <div className="border border-outline-variant">
          <ProgressiveTerminal
            sessionName={chatSession}
            terminalKey={`board-chat:${slot.slice}`}
            initialText={buildChatPreamble({ sessionName: chatSession, itemRef: slot.slice })}
          />
        </div>
      ) : null}
    </div>
  );
}

function Board({ review }: { review: ComposedMissionReview }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const collapse = review.board.length > COLLAPSE_THRESHOLD && !showAll;

  return (
    <section data-testid="mission-board" className="space-y-3">
      <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">SLICES</h3>
      {review.board.length === 0 ? (
        <p data-testid="board-empty" className="font-mono text-[11px] text-on-surface-variant">
          no slices yet
        </p>
      ) : (
        LANES.map((lane) => {
          const slots = review.board.filter((b) => b.laneLabel === lane);
          if (slots.length === 0) {
            return (
              <div key={lane} className="flex items-center gap-2">
                <span className="w-16 font-mono text-[10px] uppercase text-on-surface-variant">{lane}</span>
                <span className="font-mono text-[10px] text-on-surface-variant">0</span>
              </div>
            );
          }
          const visible = collapse ? slots.filter((s) => s.attentionWorthy) : slots;
          const hidden = slots.length - visible.length;
          return (
            <div key={lane} data-testid={`board-lane-${lane}`}>
              <div className="flex items-center gap-2">
                <span className="w-16 font-mono text-[10px] uppercase text-on-surface-variant">{lane}</span>
                <span className="font-mono text-[10px] text-on-surface-variant">{slots.length}</span>
                {collapse && hidden > 0 ? (
                  <span className="font-mono text-[9px] text-on-surface-variant">({hidden} collapsed)</span>
                ) : null}
              </div>
              <ul className="mt-1 divide-y divide-outline-variant/40 border border-outline-variant">
                {visible.map((slot) => (
                  <li key={slot.slice}>
                    <div className="flex w-full flex-wrap items-center gap-2 px-2 py-1.5 hover:bg-surface-variant/50">
                      <button
                        type="button"
                        data-testid={`board-row-${slot.slice}`}
                        onClick={() => setExpanded((cur) => (cur === slot.slice ? null : slot.slice))}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="min-w-0 flex-1 truncate text-[12px]">{slot.title}</span>
                        {slot.attentionWorthy ? <span className="text-amber-700">▲</span> : null}
                        {slot.changedSinceStamp ? (
                          <span className="font-mono text-[9px] uppercase text-amber-800">changed</span>
                        ) : null}
                        <span className="font-mono text-[10px] text-on-surface-variant">{slot.stageCell}</span>
                      </button>
                      {/* OPR.0.4.4.22 FR-5: the board agent-count chip is a
                          front door — zooms to the AGENTS altitude at rig
                          scope, as a sibling control so the row expansion
                          button keeps valid interactive markup. */}
                      <a
                        href="/agents"
                        data-testid={`board-agents-zoom-${slot.slice}`}
                        className="font-mono text-[10px] text-on-surface-variant underline-offset-2 hover:underline"
                        title="Zoom to the AGENTS altitude (rig scope)"
                      >
                        agents {slot.agentsCount}
                      </a>
                    </div>
                    {expanded === slot.slice ? <BoardRowExpansion slot={slot} /> : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
      {review.board.length > COLLAPSE_THRESHOLD ? (
        <button
          type="button"
          data-testid="board-show-all"
          onClick={() => setShowAll((v) => !v)}
          className="font-mono text-[10px] underline text-on-surface-variant"
        >
          {showAll ? "collapse to attention-worthy" : `show all ${review.board.length} slices`}
        </button>
      ) : null}
    </section>
  );
}

function Ledger({ review }: { review: ComposedMissionReview }) {
  return (
    <section data-testid="mission-ledger" className="space-y-2">
      <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">SETTLED — completion ledger</h3>
      <p
        data-testid="cut-complete"
        className={`border px-2 py-1 font-mono text-[11px] ${review.cutComplete ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-outline-variant text-on-surface-variant"}`}
      >
        cut-gating {review.cutComplete ? "COMPLETE" : "incomplete"} — {review.cutCompleteBasis}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-outline-variant font-mono text-[10px] uppercase text-on-surface-variant">
              <th className="py-1 pr-2 text-left">slice</th>
              <th className="py-1 pr-2 text-left">candidate</th>
              <th className="py-1 pr-2 text-left">gates</th>
              <th className="py-1 pr-2 text-left">merged</th>
              <th className="py-1 text-left">needs-human</th>
            </tr>
          </thead>
          <tbody>
            {review.ledger.map((row) => (
              <tr key={row.slice} data-testid={`ledger-row-${row.slice}`} className="border-b border-outline-variant/50">
                <td className="py-1 pr-2">{row.slice}</td>
                <td className="py-1 pr-2 font-mono">{row.candidateSha ?? "unknown"}</td>
                <td className="py-1 pr-2">
                  <span className="flex flex-wrap gap-1">
                    {row.gateCells.map((c) => (
                      <span key={c.role} className={`border px-1 font-mono text-[9px] ${TONE_CLASS[c.tone]}`}>
                        {c.role}:{c.recordedToken ?? "missing"}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="py-1 pr-2 font-mono">{row.mergeSha ?? "unknown"}</td>
                <td className="py-1 font-mono">{row.needsHumanCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function MissionReviewTab({ missionId }: { missionId: string }) {
  const review = useMissionReview(missionId);

  if (review.isLoading) {
    return <EmptyState label="COMPOSING" description={`Composing mission review for ${missionId}…`} variant="card" testId="mission-review-loading" />;
  }
  if (review.isError || !review.data) {
    return (
      <EmptyState
        label="REVIEW UNAVAILABLE"
        description={review.error instanceof Error ? review.error.message : "The review composer could not compose this mission."}
        variant="card"
        testId="mission-review-error"
      />
    );
  }
  const data = review.data;

  return (
    <div data-testid="mission-review-tab" className="space-y-5">
      {/* FR-8: the brief's What & why — the founder's words, verbatim, never edited. */}
      {data.intent ? (
        <section data-testid="mission-intent" className="border border-outline-variant p-3">
          <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">WHAT &amp; WHY</h3>
          <MarkdownViewer content={data.intent} hideFrontmatter hideRawToggle />
        </section>
      ) : null}

      {/* Mission NEEDS YOU — the union query, COMPACT one-line rows only
          (never full cards at this altitude); each row deep-links into the
          slice Review tab anchored at the item. */}
      <section data-testid="mission-needs-you" className="space-y-1">
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">NEEDS YOU</h3>
        {data.needsYou.items.length === 0 ? (
          <p className="font-mono text-[11px] text-on-surface-variant">{data.needsYou.provenance}</p>
        ) : (
          <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
            {data.needsYou.items.map((item) => {
              const sliceName = item.where.includes("/slices/") ? item.where.split("/slices/")[1] : null;
              const inner = (
                <span className="flex w-full items-center gap-2 px-2 py-1.5">
                  <span className={item.source === "derived" ? "text-amber-700" : "text-on-surface"}>{item.source === "derived" ? "▲" : "●"}</span>
                  {sliceName ? (
                    <span className="shrink-0 font-mono text-[10px] text-on-surface-variant">{sliceName}</span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-[12px]">{item.summary}</span>
                  <span className="hidden font-mono text-[10px] text-on-surface-variant sm:inline">{item.leg}</span>
                  {item.priority ? <span className="font-mono text-[10px] uppercase">{item.priority}</span> : null}
                </span>
              );
              return (
                <li key={item.identity}>
                  {sliceName ? (
                    <Link
                      to="/project/slice/$sliceId"
                      params={{ sliceId: sliceName }}
                      hash={`needs-you-${item.identity}`}
                      className="block hover:bg-surface-variant/50"
                      data-testid={`mission-needs-you-${item.identity}`}
                    >
                      {inner}
                    </Link>
                  ) : (
                    inner
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Delta-A: the mission AGENTS band, directly below NEEDS YOU, at
          mission:<id> scope — rows + zoom only, never embedded slice pages. */}
      <AgentsBandView band={data.agents} itemRef={data.mission} />

      <Board review={data} />
      <Ledger review={data} />

      {/* FR-8: the generated status spine — always-fresh in-tab projection of
          the SAME composer queries; the file version lands only at freeze
          moments (zero writes from rendering this). */}
      <section data-testid="brief-spine" className="space-y-2">
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">BRIEF SPINE (generated)</h3>
        {(["building", "progress", "proven", "needsYou"] as const).map((k) => (
          <div key={k} className="border border-outline-variant p-2">
            <h4 className="font-mono text-[9px] uppercase text-on-surface-variant">{k === "needsYou" ? "Needs you" : k}</h4>
            <pre className="whitespace-pre-wrap break-words text-[11px]">{data.briefSpine[k]}</pre>
          </div>
        ))}
      </section>
    </div>
  );
}
