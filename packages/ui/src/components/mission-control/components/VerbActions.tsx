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

export interface VerbActionsProps {
  qitemId: string;
  actorSession: string;
  /** Restrict the verbs offered (e.g., my-queue may only show approve/deny). */
  enabledVerbs?: MissionControlVerb[];
  onSettled?: () => void;
}

const VERB_LABELS: Record<MissionControlVerb, string> = {
  approve: "Approve",
  deny: "Deny",
  route: "Route",
  annotate: "Annotate",
  hold: "Hold",
  drop: "Drop",
  handoff: "Handoff",
};

export function VerbActions({
  qitemId,
  actorSession,
  enabledVerbs = [...MISSION_CONTROL_VERBS],
  onSettled,
}: VerbActionsProps) {
  const mutation = useMissionControlAction();
  const [activeVerb, setActiveVerb] = useState<MissionControlVerb | null>(null);
  const [destinationSession, setDestinationSession] = useState("");
  const [manualDestination, setManualDestination] = useState(false);
  const [annotation, setAnnotation] = useState("");
  const [reason, setReason] = useState("");

  const needsDestination = activeVerb === "route" || activeVerb === "handoff";
  const needsAnnotation = activeVerb === "annotate";
  const needsReason = activeVerb === "hold" || activeVerb === "drop";

  function reset() {
    setActiveVerb(null);
    setDestinationSession("");
    setManualDestination(false);
    setAnnotation("");
    setReason("");
  }

  function selectVerb(verb: MissionControlVerb) {
    setActiveVerb(verb);
    setDestinationSession("");
    setManualDestination(false);
    setAnnotation("");
    setReason("");
  }

  function submit() {
    if (!activeVerb) return;
    mutation.mutate(
      {
        verb: activeVerb,
        qitemId,
        actorSession,
        destinationSession: needsDestination ? destinationSession : undefined,
        annotation: needsAnnotation ? annotation : undefined,
        reason: needsReason ? reason : undefined,
      },
      {
        onSettled: () => {
          reset();
          onSettled?.();
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
      <div className="flex flex-wrap gap-1">
        {enabledVerbs.map((verb) => (
          <button
            key={verb}
            type="button"
            data-testid={`mc-verb-${verb}`}
            onClick={() => selectVerb(verb)}
            disabled={mutation.isPending}
            className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] ${
              activeVerb === verb
                ? "border-stone-700 bg-stone-700 text-white"
                : "border-stone-300 text-stone-700 hover:bg-stone-100"
            } disabled:opacity-50`}
          >
            {VERB_LABELS[verb]}
          </button>
        ))}
      </div>
      {activeVerb && (
        <div className="space-y-1 border border-stone-200 bg-stone-50 p-2">
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
              {mutation.isPending ? "..." : "Submit"}
            </button>
          </div>
          {mutation.isError ? (
            <div data-testid="mc-verb-error" className="font-mono text-[10px] text-red-700">
              error: {mutation.error.message}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
