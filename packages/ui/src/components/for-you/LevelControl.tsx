// OPR.0.4.1.27 Unit 3 — LevelControl (Option-B named-level segmented control).
//
// The founder-approved v5 control: the 5 feed.subscriptions toggles reframed as
// ONE plain-language level (All activity / Highlights / Needs you). It is a
// CONTROL-PRESENTATION over the existing toggle model — NO model change. The 4
// toggleable kinds map to a preset (feed-levels.ts); action_required is floored
// ON and never part of a level. A toggle combo matching no preset reads "custom"
// (the individual toggles remain the advanced view). Paper/ink/amber soul.

import { useFeedSubscriptions } from "../../hooks/useFeedSubscriptions.js";
import {
  deriveLevel,
  FEED_LEVEL_LABELS,
  type FeedLevel,
  type DerivedLevel,
} from "../../lib/feed-levels.js";

// v5 visual order: broadest -> tightest (left -> right).
const ORDER: readonly FeedLevel[] = ["all-activity", "highlights", "needs-you"] as const;

const OPTION_TESTID: Record<FeedLevel, string> = {
  "all-activity": "level-control-option-all-activity",
  "highlights": "level-control-option-highlights",
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
    <div data-testid="level-control" className="border border-outline-variant bg-background">
      {/* SHOW ME header — the floor is non-negotiable. */}
      <div className="flex items-center justify-between bg-inverse-surface text-background font-mono text-[8px] tracking-[0.16em] uppercase px-2.5 py-1.5">
        <span>Show me</span>
        <span className="text-on-surface-variant">action items always on</span>
      </div>

      {/* The segmented level picker. */}
      <div className="flex px-2.5 pt-2.5 pb-1">
        {ORDER.map((level) => {
          const active = current === level;
          return (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!interactive}
              data-testid={OPTION_TESTID[level]}
              data-active={active ? "true" : "false"}
              onClick={() => setLevel(level)}
              className={
                "flex-1 -ml-px first:ml-0 border px-1 py-2 font-mono text-[9px] uppercase tracking-[0.06em] whitespace-nowrap " +
                (active
                  ? "bg-inverse-surface text-background border-on-surface relative z-10"
                  : "bg-transparent text-on-surface-variant border-outline-variant") +
                (interactive && !active ? " hover:bg-surface-low" : "") +
                (interactive ? "" : " opacity-60 cursor-not-allowed")
              }
            >
              {FEED_LEVEL_LABELS[level]}
            </button>
          );
        })}
      </div>

      {/* Plain-language readout of what the current level shows. */}
      <div
        data-testid="level-control-readout"
        className="font-mono text-[8px] tracking-[0.04em] text-on-surface-variant leading-relaxed px-2.5 pb-2.5 pt-1.5"
      >
        <Readout level={current} />
      </div>

      {unavailable ? (
        <p
          data-testid="level-control-unavailable"
          className="font-mono text-[8px] text-on-surface-variant italic px-2.5 pb-2.5"
        >
          Settings endpoint unreachable (legacy daemon). Showing canonical defaults.
        </p>
      ) : null}
    </div>
  );
}
