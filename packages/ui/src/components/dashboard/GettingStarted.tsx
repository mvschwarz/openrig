// C15: First-run "Getting started" card.
//
// Shown at the top of the Dashboard only when there are no running rigs
// (usePsEntries().data is an empty array) and the operator has not dismissed
// it (localStorage["openrig.getting-started.dismissed"] !== "1").
// Step check states reuse live query data:
//
//  1. "Connect to the daemon" — done when daemonStatus(...) (lib/daemon-status.ts,
//     C10) returns label "Healthy".
//  2. "Add a rig spec" — done when useSpecLibrary() returns >= 1 rig spec
//     (SpecLibraryEntry has a `kind: "rig" | "agent" | "workflow"` field, so
//     filter kind === "rig"; an unfiltered call returns all kinds).
//  3. "Launch your first rig" — done when ps has >= 1 entry (never true while
//     this card is shown; the condition is kept for the honest check state).
//  4. "Check your inbox" — no done state; action "Open inbox" -> /for-you.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "../ui/button.js";
import { daemonStatus } from "../../lib/daemon-status.js";
import { useDaemonHealth } from "../../hooks/useDaemonHealth.js";
import { usePsEntries } from "../../hooks/usePsEntries.js";
import { useSpecLibrary } from "../../hooks/useSpecLibrary.js";

export const GETTING_STARTED_DISMISSED_KEY = "openrig.getting-started.dismissed";

export function isGettingStartedVisible(psData: unknown, dismissed: string | null): boolean {
  return Array.isArray(psData) && psData.length === 0 && dismissed !== "1";
}

function Check({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        done
          ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand text-xs text-brand-foreground"
          : "inline-flex h-5 w-5 items-center justify-center rounded-full border border-outline-variant text-xs text-on-surface-variant"
      }
    >
      {done ? "✓" : "○"}
    </span>
  );
}

export function GettingStarted() {
  const { data: ps } = usePsEntries();
  const { query, signal } = useDaemonHealth();
  const { data: library } = useSpecLibrary();
  const [dismissed, setDismissed] = useState(() =>
    typeof window === "undefined" ? "1" : window.localStorage.getItem(GETTING_STARTED_DISMISSED_KEY),
  );

  if (!isGettingStartedVisible(ps, dismissed)) return null;

  const daemonDone = daemonStatus(query, signal).label === "Healthy";
  const rigSpecs = (library ?? []).filter((e) => e.kind === "rig");
  const hasRigSpec = rigSpecs.length >= 1;
  const hasRig = (ps ?? []).length >= 1;

  const dismiss = () => {
    window.localStorage.setItem(GETTING_STARTED_DISMISSED_KEY, "1");
    setDismissed("1");
  };

  return (
    <section data-testid="getting-started" aria-label="Get started with OpenRig">
      <div className="rounded-lg border bg-surface-lowest shadow-sm">
        <div className="flex items-start justify-between gap-4 px-4 pt-4">
          <div>
            <h2 className="text-sm font-semibold text-on-surface">Get started with OpenRig</h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              Four steps to your first running rig.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={dismiss}>
            Dismiss
          </Button>
        </div>
        <ol className="flex flex-col gap-1 px-4 py-4">
          <li className="flex items-center gap-3 rounded-lg px-2 py-2">
            <Check done={daemonDone} />
            <span className="min-w-0 flex-1 text-sm text-on-surface">Connect to the daemon</span>
          </li>
          <li className="flex items-center gap-3 rounded-lg px-2 py-2">
            <Check done={hasRigSpec} />
            <span className="min-w-0 flex-1 text-sm text-on-surface">Add a rig spec</span>
            <Button variant="outline" size="sm" asChild>
              <Link to="/specs">Open library</Link>
            </Button>
          </li>
          <li className="flex items-center gap-3 rounded-lg px-2 py-2">
            <Check done={hasRig} />
            <span className="min-w-0 flex-1 text-sm text-on-surface">Launch your first rig</span>
            <Button variant="outline" size="sm" asChild>
              <Link to="/specs/rig">New rig</Link>
            </Button>
          </li>
          <li className="flex items-center gap-3 rounded-lg px-2 py-2">
            <Check done={false} />
            <span className="min-w-0 flex-1 text-sm text-on-surface">Check your inbox</span>
            <Button variant="outline" size="sm" asChild>
              <Link to="/for-you">Open inbox</Link>
            </Button>
          </li>
        </ol>
      </div>
    </section>
  );
}
