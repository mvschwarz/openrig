// Crash-cart C3 follow-on — the cockpit action-key resolver (pure). Active ONLY while a daemon-down
// screen is showing; main.ts performs the resolved action (exec `rig daemon start` / re-probe / etc.).
// RESTORE (⏎) routes to the C1 batch conductor (EXCLUDED this wave → main.ts surfaces a labeled seam,
// never a silent no-op). Keys differ by mode: the recovery cockpit offers restore/inspect; first-run
// (no prior life) offers only onboarding + start-daemon (never restore-of-nothing).
import type { CrashCartRenderOpts } from "./from-emit.js";

export type CrashCartKeyAction = "start-daemon" | "retry" | "inspect" | "onboarding" | "restore";

/** Map a key ("s"/"i"/"n"/"r"/"enter") to a crash-cart action for the active daemon-down screen, or
 *  null (not a crash-cart key here → falls through to normal TUI handling). */
export function resolveCrashCartKey(key: string, opts: CrashCartRenderOpts): CrashCartKeyAction | null {
  if (opts.daemonState === "down") {
    const firstRun = opts.crashCart?.mode === "first-run";
    if (key === "s") return "start-daemon";
    if (key === "n") return "onboarding";
    if (!firstRun && key === "i") return "inspect";
    if (!firstRun && key === "enter") return "restore";
    return null;
  }
  if (opts.daemonState === "unverified") {
    return key === "r" ? "retry" : null;
  }
  return null;
}
