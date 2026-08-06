// OPR.0.5.1.1 — the pane-hosted stub-runner (A5 / ContextMonitor settlement).
//
// A Pi-shaped node-script runner: the stub adapter types `node <thisEntry> …` into
// the seat's tmux pane; this process persists the readiness sidecar the daemon polls
// and prints the READY marker, then idles as the pane's live foreground process (so
// the adapter's hasSession/atShell liveness cross-checks see a running seat). A
// self-invocation guard keeps the module import-safe: nothing runs unless this file
// is the process entry.
//
// Step-4 scope: come up + persist readiness + honest exit. The four seeded behaviors
// {compaction, slow_output, mid_turn_death, restore} and the ctx% context sidecar are
// later increments (A5 items 5-8) — deliberately NOT simulated here yet.

import nodeFs from "node:fs";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import {
  stubSeatSidecarPath,
  STUB_RUNNER_READY_MARKER,
  STUB_RUNNER_EXIT_MARKER,
  STUB_RUNNER_ERROR_MARKER,
  type StubRunnerState,
} from "./stub-runner-protocol.js";

export interface StubRunnerArgs {
  sessionName: string;
  cwd: string;
  launchId: string;
  posture: "floor" | "full_bypass";
  resumeToken?: string;
}

/** Parse the runner argv (the flags buildStubRunnerCommand emits). Pure. */
export function parseStubRunnerArgs(argv: string[]): StubRunnerArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const sessionName = get("--session-name");
  const cwd = get("--cwd");
  const launchId = get("--launch-id");
  const postureRaw = get("--posture");
  if (!sessionName) throw new Error("stub-runner: --session-name is required");
  if (!cwd) throw new Error("stub-runner: --cwd is required");
  if (!launchId) throw new Error("stub-runner: --launch-id is required");
  const posture = postureRaw === "full_bypass" ? "full_bypass" : "floor";
  return { sessionName, cwd, launchId, posture, resumeToken: get("--session") };
}

function writeSidecar(cwd: string, state: StubRunnerState): void {
  const sidecarPath = stubSeatSidecarPath(cwd);
  nodeFs.mkdirSync(nodePath.dirname(sidecarPath), { recursive: true });
  // Atomic replace: write a temp sibling then rename, so a poller never reads a
  // half-written sidecar (a torn read would misreport readiness).
  const tmp = `${sidecarPath}.${process.pid}.tmp`;
  nodeFs.writeFileSync(tmp, JSON.stringify(state), "utf-8");
  nodeFs.renameSync(tmp, sidecarPath);
}

export async function runStubRunner(args: StubRunnerArgs): Promise<void> {
  // PRD §5 (no wall-clock in the stub's OWN behavior): the runner's own stamps honor
  // the same A3-R3 injectable clock the compaction assets use — OPENRIG_TEST_CLOCK_NOW
  // (an ISO instant) when set, real wall-clock otherwise (absent = production).
  const nowIso = () => {
    const injected = process.env.OPENRIG_TEST_CLOCK_NOW;
    return typeof injected === "string" && injected.trim().length > 0 ? injected : new Date().toISOString();
  };
  try {
    writeSidecar(args.cwd, { ready: true, launchId: args.launchId, updatedAt: nowIso() });
    // eslint-disable-next-line no-console
    console.log(`${STUB_RUNNER_READY_MARKER} session=${args.sessionName} posture=${args.posture}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`${STUB_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // Keep the Node event loop alive so the process IDLES as the pane's live
  // foreground process. The `await new Promise(()=>{})` below never resolves, but an
  // unresolved promise does NOT ref the loop — nor do signal listeners — so without a
  // ref'd handle the loop drains and the runner exits immediately after READY; the
  // daemon then sees the pane fall back to a shell and readiness fails (F1). This
  // timer never fires (its callback is a no-op); it exists only to ref the loop.
  const keepAlive = setInterval(() => { /* ref the event loop until termination */ }, 1 << 30);

  // Record an honest exit on termination so the daemon's readiness never
  // false-greens a stopped seat off a stale ready sidecar.
  const recordExit = (code: number | null) => {
    clearInterval(keepAlive);
    try {
      writeSidecar(args.cwd, { ready: false, launchId: args.launchId, exited: { code, at: nowIso() }, updatedAt: nowIso() });
    } catch { /* best-effort on the way out */ }
    // eslint-disable-next-line no-console
    console.log(STUB_RUNNER_EXIT_MARKER);
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => { recordExit(0); process.exit(0); });
  }

  // Idle as the pane's live foreground process (held open by `keepAlive` above).
  // Resolves only on termination.
  await new Promise<void>(() => { /* held open until a signal fires */ });
}

// ── Self-invocation guard (Pi precedent) — run ONLY as the process entry. ──
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runStubRunner(parseStubRunnerArgs(process.argv.slice(2))).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`${STUB_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exit(1);
  });
}
