// PL-005 Phase A: 7-verb action sub-component.
//
// Per PRD § Acceptance Criteria item 2: each of 7 verbs is one atomic
// transaction. The 4-step `handoff` shape is daemon-internal (not visible
// here); UI just submits the verb + required fields.

import { useState } from "react";
import {
  MISSION_CONTROL_VERBS,
  type MissionControlVerb,
  useMissionControlAction,
} from "../hooks/useMissionControlAction.js";
import { useMissionControlDestinations } from "../hooks/useMissionControlDestinations.js";
import { ACTION_VERB_META } from "../action-verb-meta.js";
import { cn } from "../../../lib/utils.js";
import type { FeedActionOutcome } from "../../for-you/FeedCard.js";

export interface VerbActionsProps {
  qitemId: string;
  actorSession: string;
  /** Restrict the verbs offered (e.g., my-queue may only show approve/deny). */
  enabledVerbs?: MissionControlVerb[];
  onSettled?: () => void;
  /**
   * 0.3.1 demo-bug fix — optimistic outcome callback. Fires on
   * mutation success with a FeedActionOutcome built from the input
   * verb + destination + actor. Parent (Feed.tsx) stashes this in a
   * local Map so the ActionOutcomePanel renders instantly without
   * waiting for the audit-log roundtrip. The audit query re-fetch
   * reconciles to the same shape later.
   */
  onOptimisticOutcome?: (outcome: FeedActionOutcome) => void;
}

function extractMutationErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Action failed.";
}

// Vellum-coherent verb buttons: bordered-no-fill at rest; hover inverts
// to filled. Active state stays filled to signal the operator's
// selection while filling out the verb's required fields.
//
// Tone classes are mapped to design tokens (success / warning / tertiary
// / secondary / stone-900) — never off-brand emerald/rose/sky/amber
// utilities.
const verbToneClass: Record<MissionControlVerb, { idle: string; active: string }> = {
  approve: {
    idle: "border-success text-success hover:bg-success hover:text-white",
    active: "border-success bg-success text-white",
  },
  deny: {
    idle: "border-tertiary text-tertiary hover:bg-tertiary hover:text-white",
    active: "border-tertiary bg-tertiary text-white",
  },
  route: {
    idle: "border-stone-700 text-stone-700 hover:bg-stone-900 hover:text-white",
    active: "border-stone-900 bg-stone-900 text-white",
  },
  annotate: {
    idle: "border-stone-700 text-stone-700 hover:bg-stone-900 hover:text-white",
    active: "border-stone-900 bg-stone-900 text-white",
  },
  hold: {
    idle: "border-warning text-warning hover:bg-warning hover:text-white",
    active: "border-warning bg-warning text-white",
  },
  drop: {
    idle: "border-stone-700 text-stone-700 hover:bg-stone-900 hover:text-white",
    active: "border-stone-900 bg-stone-900 text-white",
  },
  handoff: {
    idle: "border-stone-700 text-stone-700 hover:bg-stone-900 hover:text-white",
    active: "border-stone-900 bg-stone-900 text-white",
  },
};

export function VerbActions({
  qitemId,
  actorSession,
  enabledVerbs = [...MISSION_CONTROL_VERBS],
  onSettled,
  onOptimisticOutcome,
}: VerbActionsProps) {
  const mutation = useMissionControlAction();
  const [activeVerb, setActiveVerb] = useState<MissionControlVerb | null>(null);
  const [destinationSession, setDestinationSession] = useState("");
  const [manualDestination, setManualDestination] = useState(false);
  const [annotation, setAnnotation] = useState("");
  const [reason, setReason] = useState("");
  // Demo-bug fix #2 — inline error state. Cleared on verb selection +
  // explicit reset; held across mutation state transitions so the
  // operator sees what failed instead of a silent revert.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const needsDestination = activeVerb === "route" || activeVerb === "handoff";
  const needsAnnotation = activeVerb === "annotate";
  const needsReason = activeVerb === "hold" || activeVerb === "drop";

  function reset() {
    setActiveVerb(null);
    setDestinationSession("");
    setManualDestination(false);
    setAnnotation("");
    setReason("");
    setErrorMessage(null);
  }

  function selectVerb(verb: MissionControlVerb) {
    setActiveVerb(verb);
    setDestinationSession("");
    setManualDestination(false);
    setAnnotation("");
    setReason("");
    setErrorMessage(null);
  }

  function submit() {
    if (!activeVerb) return;
    const verb = activeVerb;
    const dest = needsDestination ? destinationSession : undefined;
    const reasonText = needsReason ? reason : undefined;
    mutation.mutate(
      {
        verb,
        qitemId,
        actorSession,
        destinationSession: dest,
        annotation: needsAnnotation ? annotation : undefined,
        reason: reasonText,
      },
      {
        // Demo-bug fix #1 — split onSuccess / onError so the error
        // path doesn't reset the selection (silent-revert symptom).
        // Optimistic outcome fires on success so ActionOutcomePanel
        // renders without waiting for the audit-log roundtrip.
        onSuccess: () => {
          onOptimisticOutcome?.({
            verb,
            actorSession,
            actedAt: new Date().toISOString(),
            destinationSession: dest ?? null,
            reason: reasonText ?? null,
          });
          reset();
          onSettled?.();
        },
        onError: (err) => {
          setErrorMessage(extractMutationErrorMessage(err));
        },
      },
    );
  }

  const destinationsQuery = useMissionControlDestinations(needsDestination);
  const destinationOptions = destinationsQuery.data?.destinations ?? [];
  const destinationListLoading = needsDestination && destinationsQuery.isLoading;
  const showDestinationSelect = needsDestination && (destinationOptions.length > 0 || destinationListLoading);
  const showManualDestinationInput =
    needsDestination &&
    (manualDestination || destinationsQuery.isError || (destinationsQuery.isFetched && destinationOptions.length === 0));

  return (
    <div data-testid="mc-verb-actions" className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2 border border-outline-variant bg-white/40 px-2 py-1.5 backdrop-blur-sm">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-stone-800">Choose response</div>
          <div className="mt-0.5 font-mono text-[10px] leading-relaxed text-stone-500">
            Pick the next move for this queue item.
          </div>
        </div>
        {activeVerb ? (
          <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
            Selected: <span className="text-stone-900">{ACTION_VERB_META[activeVerb].label}</span>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1">
        {enabledVerbs.map((verb) => {
          const meta = ACTION_VERB_META[verb];
          const Icon = meta.icon;
          return (
            <button
              key={verb}
              type="button"
              data-testid={`mc-verb-${verb}`}
              onClick={() => selectVerb(verb)}
              disabled={mutation.isPending}
              title={meta.description}
              className={cn(
                "inline-flex min-h-[44px] items-center gap-1 border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors disabled:opacity-50",
                activeVerb === verb ? verbToneClass[verb].active : verbToneClass[verb].idle,
              )}
            >
              <Icon className="h-3 w-3" strokeWidth={1.7} />
              {meta.label}
            </button>
          );
        })}
      </div>
      {activeVerb && (
        <div className="space-y-1 border border-stone-200 bg-stone-50 p-2">
          <div data-testid="mc-verb-guidance" className="font-mono text-[10px] leading-relaxed text-stone-600">
            {ACTION_VERB_META[activeVerb].description}
          </div>
          {needsDestination && (
            <div className="space-y-1">
              {showDestinationSelect ? (
                <select
                  data-testid="mc-verb-destination-select"
                  aria-label="Destination session"
                  value={manualDestination ? "__manual__" : destinationSession}
                  disabled={destinationListLoading}
                  onChange={(e) => {
                    if (e.target.value === "__manual__") {
                      setManualDestination(true);
                      setDestinationSession("");
                      return;
                    }
                    setManualDestination(false);
                    setDestinationSession(e.target.value);
                  }}
                  className="w-full border border-stone-300 bg-white px-2 py-1 font-mono text-xs"
                >
                  <option value="">
                    {destinationListLoading ? "loading destinations..." : "choose destination"}
                  </option>
                  {destinationOptions.map((destination) => (
                    <option key={destination.sessionName} value={destination.sessionName}>
                      {destination.label}
                    </option>
                  ))}
                  <option value="__manual__">manual entry</option>
                </select>
              ) : null}
              {showManualDestinationInput ? (
                <input
                  type="text"
                  data-testid="mc-verb-destination-input"
                  value={destinationSession}
                  onChange={(e) => setDestinationSession(e.target.value)}
                  placeholder="destination session (member@rig)"
                  className="w-full border border-stone-300 px-2 py-1 font-mono text-xs"
                />
              ) : null}
              {destinationsQuery.isError ? (
                <div className="font-mono text-[10px] text-amber-700">destination list unavailable</div>
              ) : null}
            </div>
          )}
          {needsAnnotation && (
            <textarea
              data-testid="mc-verb-annotation-input"
              value={annotation}
              onChange={(e) => setAnnotation(e.target.value)}
              placeholder="annotation"
              rows={2}
              className="w-full border border-stone-300 px-2 py-1 font-mono text-xs"
            />
          )}
          {needsReason && (
            <input
              type="text"
              data-testid="mc-verb-reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={`${activeVerb} reason`}
              className="w-full border border-stone-300 px-2 py-1 font-mono text-xs"
            />
          )}
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={reset}
              data-testid="mc-verb-cancel"
              className="border border-stone-300 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-stone-600"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              data-testid="mc-verb-submit"
              disabled={
                mutation.isPending ||
                (needsDestination && !destinationSession) ||
                (needsAnnotation && !annotation) ||
                (needsReason && !reason)
              }
              className="border border-stone-700 bg-stone-800 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-white disabled:opacity-50"
            >
              {mutation.isPending ? "..." : `Confirm ${ACTION_VERB_META[activeVerb].label}`}
            </button>
          </div>
        </div>
      )}
      {errorMessage ? (
        <div
          data-testid="mc-verb-error"
          role="alert"
          className="truncate border border-tertiary bg-stone-50/40 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-tertiary"
          title={errorMessage}
        >
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
