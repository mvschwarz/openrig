// Living Notes Packet 2 — NEEDS YOU (OPR.0.4.4.20 FR-4, blessed U3/U3a).
//
// A priority-ordered ACCORDION: one-line rows {summary, leg, where, age,
// priority} with the two-source glyphs — ● agent-initiated (incl. regime-2
// confirm-faithful) and ▲ machine-derived (every ▲ row renders ITS EVIDENCE
// + crossed threshold inline; no evidence, no exception). Exactly ONE row
// expands in place to the full card (evidence + the TWO founder affordances:
// APPROVE and CHAT — SS14; deny/route/decision-box are retired as buttons,
// their write paths ride CHAT-then-agent-records). Proven-empty renders the
// U4 provenance line, never a blank band.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { VELLUM_CARD } from "./vellum.js";
import type { NeedsYouBand, NeedsYouItem } from "../../hooks/useReview.js";
import { EvidenceOpener, type EvidenceContext } from "./EvidenceOpener.js";
import { approveSlice, type ActionOutcome } from "./review-actions.js";
import { buildChatPreamble } from "./chat.js";
import { ProgressiveTerminal } from "../terminal/ProgressiveTerminal.js";
import { useInvalidateReview } from "../../hooks/useReview.js";

function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (60 * 24))}d`;
}

function ExpandedCard({
  item,
  slice,
  actorSession,
  ctx,
  showApprove = true,
}: {
  item: NeedsYouItem;
  slice: string;
  actorSession: string;
  ctx: EvidenceContext;
  showApprove?: boolean;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const invalidate = useInvalidateReview();

  const chatSession = item.destinationSession;
  const itemRef = item.qitemId ? `${slice} ${item.qitemId}` : slice;

  const onApprove = async () => {
    // APPROVE maps to FAITHFUL (the slice-terminal approve verb / adjudication
    // semantics — the FR-2 write paths, unchanged; never a synthetic qitem).
    const result = await approveSlice(slice, actorSession);
    setOutcome(result);
    if (result.ok) invalidate(); // rows must actually LEAVE the band (FR-4)
  };

  return (
    <div data-testid={`needs-you-expanded-${item.identity}`} className="space-y-2 border-t border-outline-variant/50 p-2">
      {item.derived ? (
        <p data-testid="derived-evidence" className="font-mono text-[10px] text-amber-800">
          ▲ {item.derived.evidence} · threshold: {item.derived.threshold}
        </p>
      ) : null}
      {/* OPR.0.4.6.WF4 FR-3 — the WEB DESTINATION for workflow-sourced rows. The
          join is the Q6 structured `item.workflow` pointer ONLY (stamped
          daemon-side) — NEVER prose from identity/evidenceRef/summary (the
          anti-prose rule; P3 test). The ?step= anchor opens the gated/failed
          step. Absent on non-workflow rows → renders nothing. */}
      {item.workflow ? (
        <Link
          to="/workflow/instance/$instanceId"
          params={{ instanceId: item.workflow.instanceId }}
          search={item.workflow.stepId ? { step: item.workflow.stepId } : {}}
          data-testid={`needs-you-workflow-link-${item.identity}`}
          className="inline-block border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant"
        >
          View Instance →
        </Link>
      ) : null}
      {item.evidenceRef ? (
        <div>
          <span className="font-mono text-[10px] uppercase text-on-surface-variant">evidence: </span>
          <EvidenceOpener evidenceRef={item.evidenceRef} ctx={ctx} testId={`needs-you-evidence-${item.identity}`} />
        </div>
      ) : null}
      {item.unblocks ? (
        <p className="font-mono text-[10px] text-on-surface-variant">unblocks: {item.unblocks}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {showApprove ? (
          <button
            type="button"
            data-testid="needs-you-approve"
            onClick={() => void onApprove()}
            className="border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant"
          >
            Approve
          </button>
        ) : null}
        <button
          type="button"
          data-testid="needs-you-chat"
          disabled={!chatSession}
          title={chatSession ? `Talk to ${chatSession} in the terminal` : "No owning agent session resolved for this item"}
          onClick={() => setChatOpen((v) => !v)}
          className="border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant disabled:cursor-not-allowed disabled:opacity-50"
        >
          Chat
        </button>
        {outcome ? (
          <span data-testid="action-outcome" className={`font-mono text-[10px] ${outcome.ok ? "text-emerald-800" : "text-red-700"}`}>
            {outcome.message}
          </span>
        ) : null}
      </div>
      {chatOpen && chatSession ? (
        // BR-12: CHAT IS the existing terminal family — straight-to-interactive
        // with the one pre-populated no-Enter frame. No chat panel exists.
        <div className="border border-outline-variant" data-testid="needs-you-chat-terminal">
          <ProgressiveTerminal
            sessionName={chatSession}
            terminalKey={`review-chat:${item.identity}`}
            initialText={buildChatPreamble({ sessionName: chatSession, itemRef })}
          />
        </div>
      ) : null}
    </div>
  );
}

export function NeedsYouAccordion({
  band,
  slice,
  actorSession,
  ctx,
  anchorIdentity,
  showApprove = true,
}: {
  band: NeedsYouBand;
  slice: string;
  actorSession: string;
  ctx: EvidenceContext;
  /** FR-9 deep link: auto-expand this identity on load. */
  anchorIdentity?: string | null;
  /** OPR.0.4.4.22 — APPROVE is a slice-terminal act; the rig altitude hides
   *  it (zoom into the slice to approve — zoom, don't inline). Extension in
   *  this one home; P2 pages keep the default true. */
  showApprove?: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(anchorIdentity ?? null);

  return (
    <section data-testid="needs-you-band" className={cn(VELLUM_CARD, "space-y-1 p-2")}>
      <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">NEEDS YOU</h3>
      {band.items.length === 0 ? (
        <p data-testid="needs-you-empty" className="font-mono text-[11px] text-on-surface-variant">
          {band.provenance}
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
          {band.items.map((item) => (
            <li key={item.identity} id={`needs-you-${item.identity}`}>
              <button
                type="button"
                data-testid={`needs-you-row-${item.identity}`}
                onClick={() => setExpanded((cur) => (cur === item.identity ? null : item.identity))}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-variant/50"
              >
                <span className={item.source === "derived" ? "text-amber-700" : "text-on-surface"} aria-hidden>
                  {item.source === "derived" ? "▲" : "●"}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px]">{item.summary}</span>
                <span className="hidden font-mono text-[10px] text-on-surface-variant sm:inline">{item.leg}</span>
                <span className="hidden font-mono text-[10px] text-on-surface-variant md:inline truncate max-w-32">{item.where}</span>
                <span className="font-mono text-[10px] text-on-surface-variant">{ageLabel(item.ageIso)}</span>
                {item.priority ? <span className="font-mono text-[10px] uppercase">{item.priority}</span> : null}
              </button>
              {expanded === item.identity ? (
                <ExpandedCard item={item} slice={slice} actorSession={actorSession} ctx={ctx} showApprove={showApprove} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {band.items.length > 0 ? (
        <p className="font-mono text-[10px] text-on-surface-variant">{band.provenance}</p>
      ) : null}
    </section>
  );
}
