// OPR.0.4.1.27 Unit 3 — LevelControl (Option-B named-level segmented control).
//
// C11 Inbox v2: presentation is now a row of tabs ("Needs you" /
// "Highlights" / "Everything") over the same toggle model — NO model
// change. The 4 toggleable kinds map to a preset (feed-levels.ts);
// action_required is floored ON and never part of a level. A toggle
// combo matching no preset reads "custom" (the individual toggles
// remain the advanced view).
//
// The "All activity" tab label renders as "Everything" (tab display only);
// the FeedLevel value and storage keys are unchanged.

import { useFeedSubscriptions } from "../../hooks/useFeedSubscriptions.js";
import {
  deriveLevel,
  type FeedLevel,
  type DerivedLevel,
} from "../../lib/feed-levels.js";

// v5 visual order: tightest -> broadest (left -> right).
const ORDER: readonly FeedLevel[] = ["needs-you", "highlights", "all-activity"] as const;

// Tab display labels. "All activity" renders as "Everything" in the tab
// only; the level value and storage keys keep "all-activity".
const TAB_LABELS: Record<FeedLevel, string> = {
  "needs-you": "Needs you",
  highlights: "Highlights",
  "all-activity": "Everything",
};

const OPTION_TESTID: Record<FeedLevel, string> = {
  "all-activity": "level-control-option-all-activity",
  highlights: "level-control-option-highlights",
  "needs-you": "level-control-option-needs-you",
};

function Readout({ level }: { level: DerivedLevel }) {
  if (level === "needs-you") {
    return (
      <>
        <b className="text-on-surface">Just what needs you</b> · <span className="text-amber-700">action items</span> only
      </>
    );
  }
  if (level === "all-activity") {
    return (
      <>
        <b className="text-on-surface">All activity</b> · <span className="text-amber-700">what needs you</span> + everything, incl. audit log
      </>
    );
  }
  if (level === "highlights") {
    return (
      <>
        <b className="text-on-surface">Highlights</b> · <span className="text-amber-700">what needs you</span> + approvals + ships + progress · <span className="text-on-surface-variant">audit hidden</span>
      </>
    );
  }
  return (
    <>
      <b className="text-on-surface">Custom</b> · set via the individual toggles below
    </>
  );
}

export function LevelControl() {
  const { state, setLevel, isMutating, unavailable } = useFeedSubscriptions();
  const current = deriveLevel(state);
  const interactive = !unavailable && !isMutating;

  return (
    <div data-testid="level-control" role="tablist" aria-label="Feed level" className="border-b border-outline-variant">
      <div className="flex gap-1">
      {ORDER.map((level) => {
        const active = current === level;
        return (
          <button
            key={level}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={!interactive}
            data-testid={OPTION_TESTID[level]}
            data-active={active ? "true" : "false"}
            onClick={() => setLevel(level)}
            className={
              "px-3 py-2 text-sm whitespace-nowrap " +
              (active
                ? "text-on-surface border-b-2 border-on-surface font-medium"
                : "text-on-surface-variant hover:text-on-surface") +
              (interactive ? "" : " opacity-60 cursor-not-allowed")
            }
          >
            {TAB_LABELS[level]}
          </button>
        );
      })}
      </div>
      {/* Screen-reader readout of the current level (visual readout was part
          of the retired SHOW ME box; the tab labels carry the meaning now). */}
      <div data-testid="level-control-readout" className="sr-only" aria-live="polite">
        <Readout level={current} />
      </div>

      {unavailable ? (
        <p
          data-testid="level-control-unavailable"
          className="mt-1 text-xs italic text-on-surface-variant"
        >
          Settings endpoint unreachable (legacy daemon). Showing canonical defaults.
        </p>
      ) : null}
    </div>
  );
}
