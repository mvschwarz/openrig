// OPR.0.5.1.1 — the stub RESTORE behavior executor (A5 items 6-8).
//
// PRD §4.3/§4.4 (arch R3, binding): the stub TRIGGERS the exact shipped restore seam, it
// never FABRICATES its outputs. On an `emit restore` script step the runner calls
// fireRestore, which spawns the REAL compaction-restore-bridge.cjs — the same product
// asset a real Claude seat runs on SessionStart(matcher=compact)/UserPromptSubmit — so it
// reads THIS seat's keyed restore-pending marker (written by the precompact seam), injects
// ONE hookSpecificOutput.additionalContext restore directive, and stamps
// deliveredAt/deliveryCount on the marker (one-shot). The observable (the real injected
// directive + a stamped marker) is production-identical and deterministic under the shared
// injectable clock (OPENRIG_TEST_CLOCK_NOW).
//
// A restore with NO pending marker legitimately no-ops (nothing to deliver) — that is NOT
// an error (unlike a fired compaction that produced no marker): the bridge stays silent and
// fireRestore reports delivered=false, which the runner mirrors honestly.
//
// Effectful by nature (it spawns a subprocess); kept separate from the pure stub-script
// model so that model stays hermetic. Symmetric to stub-compaction.ts.

import nodeFs from "node:fs";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";

export interface FireRestoreOpts {
  /** Absolute path to the shipped compaction-restore-bridge.cjs (the caller resolves it
   *  from the installed plugin layout; fireRestore fails FAST if it is absent). */
  bridgeScriptPath: string;
  /** The seat's canonical session name — the marker key (identity). */
  sessionName: string;
  /** OPENRIG_HOME the seam reads the restore-pending marker under. */
  openrigHome: string;
  /** The seat's managed cwd (part of the hook payload). */
  cwd: string;
  /** The delivering hook event (SessionStart / UserPromptSubmit). Defaults to
   *  UserPromptSubmit — the bridge's own default and a real delivery trigger. */
  hookEventName?: string;
  /** Deterministic clock injection (an ISO instant) forwarded to the seam's stamps. */
  injectClockNow?: string;
}

export interface RestoreResult {
  /** The injected restore directive (hookSpecificOutput.additionalContext), or null when
   *  nothing was delivered (no pending marker, or the marker was already delivered). */
  additionalContext: string | null;
  /** Absolute path to the seat-keyed restore-pending marker the seam reads/stamps. */
  markerPath: string;
  /** True iff the bridge actually injected a restore directive this call. */
  delivered: boolean;
}

/** Loud, typed failure — a missing bridge or a non-zero bridge exit must fail, never a
 *  silent skip that leaves the seat looking restored when it was not. */
export class StubRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StubRestoreError";
  }
}

/** The marker key sanitizer — MUST match compaction-restore-bridge.cjs / precompact-hook.mjs
 *  (identical character class) so the marker the seam keys on is the one we resolve. */
function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.@-]/g, "_");
}

/** Fire the real restore bridge for a stub seat and return the directive it injected. */
export function fireRestore(opts: FireRestoreOpts): RestoreResult {
  // HIGH-6 existence contract: never invoke a phantom bridge; fail fast and loud.
  if (!nodeFs.existsSync(opts.bridgeScriptPath)) {
    throw new StubRestoreError(`restore bridge script not found: ${opts.bridgeScriptPath}`);
  }

  const hookInput: Record<string, unknown> = {
    hook_event_name: opts.hookEventName ?? "UserPromptSubmit",
    cwd: opts.cwd,
    session_name: opts.sessionName,
  };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENRIG_HOME: opts.openrigHome,
    OPENRIG_SESSION_NAME: opts.sessionName,
    // Don't let a stray RIGGED_HOME pre-empt the isolated OPENRIG_HOME.
    RIGGED_HOME: undefined,
    OPENRIG_TEST_CLOCK_NOW: opts.injectClockNow,
  } as NodeJS.ProcessEnv;

  const result = spawnSync(process.execPath, [opts.bridgeScriptPath], {
    input: JSON.stringify(hookInput),
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new StubRestoreError(
      `restore bridge exited ${result.status}: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }

  const markerPath = nodePath.join(
    opts.openrigHome, "compaction", "restore-pending", `${sanitizeKey(opts.sessionName)}.json`,
  );

  // The bridge writes a hookSpecificOutput.additionalContext directive to stdout ONLY when
  // it delivered this seat's marker; an empty/non-JSON stdout means nothing was delivered
  // (no pending marker or an already-delivered one) — an honest no-op, not a failure.
  let additionalContext: string | null = null;
  const out = (result.stdout || "").trim();
  if (out.length > 0) {
    try {
      const parsed = JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: unknown } };
      const ctx = parsed?.hookSpecificOutput?.additionalContext;
      if (typeof ctx === "string" && ctx.length > 0) additionalContext = ctx;
    } catch {
      // non-JSON stdout = nothing delivered; leave additionalContext null.
    }
  }
  return { additionalContext, markerPath, delivered: additionalContext !== null };
}
