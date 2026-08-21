// Crash-cart C3 follow-on — the cockpit action-key resolver (pure). Active ONLY while a daemon-down
// screen is showing; main.ts performs the resolved action (exec `rig daemon start` / re-probe / etc.).
// RESTORE (⏎) routes to the C1 batch conductor (EXCLUDED this wave → main.ts surfaces a labeled seam,
// never a silent no-op). Keys differ by mode: the recovery cockpit offers restore/inspect; first-run
// (no prior life) offers only onboarding + start-daemon (never restore-of-nothing).
import type { CrashCartRenderOpts } from "./from-emit.js";
import { evaluateOneClickGate } from "./one-click-gate.js";

// `restore` = the ZERO-GENERATION one-click (every seat resume-original); `restore-confirm` = the
// gated path when some rig has non-resumable seats (main.ts names the deltas before proceeding — never
// a silent resume→fresh downgrade). The founder's one-click rule is BINDING on ⏎.
export type CrashCartKeyAction = "start-daemon" | "retry" | "inspect" | "onboarding" | "restore" | "restore-confirm";

/** Map a key ("s"/"i"/"n"/"r"/"enter") to a crash-cart action for the active daemon-down screen, or
 *  null (not a crash-cart key here → falls through to normal TUI handling). */
export function resolveCrashCartKey(key: string, opts: CrashCartRenderOpts): CrashCartKeyAction | null {
  if (opts.daemonState === "down") {
    const firstRun = opts.crashCart?.mode === "first-run";
    if (key === "s") return "start-daemon";
    if (key === "n") return "onboarding";
    if (!firstRun && key === "i") return "inspect";
    if (!firstRun && key === "enter") {
      // H2 — CONSULT the one-click gate: ⏎ is a single keystroke ONLY when the restore plan is
      // zero-generation. Any rig with non-resumable seats routes to the confirm path (names the deltas).
      const gate = evaluateOneClickGate({
        foundOnHost: (opts.crashCart?.foundOnHost ?? []).map((r) => ({
          rigName: r.name,
          seatCount: r.seatCount,
          resumableCount: r.resumableCount,
        })),
      });
      return gate.zeroGeneration ? "restore" : "restore-confirm";
    }
    return null;
  }
  if (opts.daemonState === "unverified") {
    return key === "r" ? "retry" : null;
  }
  return null;
}
