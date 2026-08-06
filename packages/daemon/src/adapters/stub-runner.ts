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
  stubSeatScriptPath,
  STUB_RUNNER_READY_MARKER,
  STUB_RUNNER_EXIT_MARKER,
  STUB_RUNNER_ERROR_MARKER,
  type StubRunnerState,
} from "./stub-runner-protocol.js";
import { parseStubScript, DEFAULT_STUB_SCRIPT, type StubScript } from "./stub-script.js";
import { fireCompaction, type CompactionResult } from "./stub-compaction.js";

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

// ── Script-execution seam (mirror pi-runner's RunnerIo) ─────────────────────
// The runner drives a script against injected effects so the dispatch loop unit-
// tests hermetically. R1 wires the compaction behavior; postActivity (the event
// POST) is a later increment (R2). now() honors the same injected clock (PRD §5).

export interface StubRunnerIO {
  /** Print one line to the seat's pane. */
  mirrorLine(line: string): void;
  /** Fire the REAL precompact seam (arch R3: TRIGGER, never fabricate) and return
   *  the seat-keyed restore-pending marker it wrote. */
  fireCompaction(): CompactionResult;
  /** Injectable clock (OPENRIG_TEST_CLOCK_NOW when set, real wall-clock otherwise). */
  now(): string;
}

/** Execute a stub behavior script step-by-step against the injected IO seam. Pure
 *  dispatch — no filesystem/clock of its own — so a fake IO drives it hermetically.
 *  `say` mirrors its text; `emit compaction` fires the real seam; a not-yet-wired
 *  behavior mirrors an HONEST deferral (never a silent no-op, never a fabrication). */
export function executeStubScript(script: StubScript, io: StubRunnerIO): void {
  for (const step of script.steps) {
    if (step.kind === "say") {
      io.mirrorLine(step.text);
      continue;
    }
    // step.kind === "emit"
    if (step.behavior === "compaction") {
      const { markerPath } = io.fireCompaction();
      io.mirrorLine(`[stub] compaction fired — restore-pending marker ${markerPath}`);
      continue;
    }
    // slow_output / mid_turn_death / restore are seeded but not yet simulated —
    // surface that loudly rather than silently drop the step (honest labeling).
    io.mirrorLine(`[stub] behavior '${step.behavior}' not yet simulated (deferred increment)`);
  }
}

/** Resolve the seat's behavior script: the scenario-resolved script at
 *  <cwd>/.openrig/stub/script.json when present, else the built-in default. A
 *  malformed scenario script fails LOUDLY (parseStubScript throws) — never a silent
 *  fallback to the default that would mask a broken scenario. */
export function resolveStubScript(
  cwd: string,
  fsLike: { readFile(p: string): string; exists(p: string): boolean },
): StubScript {
  const scriptPath = stubSeatScriptPath(cwd);
  if (!fsLike.exists(scriptPath)) return DEFAULT_STUB_SCRIPT;
  return parseStubScript(fsLike.readFile(scriptPath));
}

/** Build the stub seat's OWN session transcript (a real JSONL) from its script. The
 *  compaction seam MUST compact this, never a foreign transcript: restore-from-jsonl's
 *  findLatestJsonl falls back to ~/.claude/projects, so without an explicit own
 *  transcript the stub would non-deterministically compact whatever latest transcript
 *  exists on the box. Authoring + passing this is what makes the compaction honest
 *  (the stub compacts its scripted conversation) and deterministic. */
export function buildStubTranscript(
  script: StubScript,
  ctx: { sessionName: string; cwd: string; sessionId: string },
): string {
  const lines: string[] = [];
  const push = (role: "user" | "assistant", content: string) =>
    lines.push(JSON.stringify({
      sessionId: ctx.sessionId, sessionName: ctx.sessionName, cwd: ctx.cwd, message: { role, content },
    }));
  push("user", `[stub] scenario prompt for ${ctx.sessionName}`);
  for (const step of script.steps) {
    if (step.kind === "say") push("assistant", step.text);
  }
  // Guarantee ≥1 assistant turn (analyze needs content) even for an emit-only script.
  if (lines.length <= 1) push("assistant", "[stub] scripted reply");
  return `${lines.join("\n")}\n`;
}

/** Resolve the shipped precompact-hook.mjs the compaction behavior fires. An env
 *  override (OPENRIG_STUB_PRECOMPACT_HOOK) wins for hermetic tests; otherwise the
 *  packaged asset relative to this entry — the SAME relative path from src/adapters
 *  (tsx) and dist/adapters (compiled), matching the daemon's asset-resolution idiom. */
export function resolveStubHookScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENRIG_STUB_PRECOMPACT_HOOK;
  if (typeof override === "string" && override.trim().length > 0) return override;
  return nodePath.resolve(
    import.meta.dirname,
    "../../assets/plugins/openrig-core/skills/claude-compaction-restore/scripts/precompact-hook.mjs",
  );
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

  // R1: LOAD the seat's behavior script (scenario-resolved in cwd, else the built-in
  // default) and EXECUTE its steps against the real IO seam. `emit compaction` fires
  // the exact shipped precompact seam (arch R3: TRIGGER, never fabricate). A broken
  // scenario script fails LOUDLY on the pane rather than silently no-opping.
  const openrigHome = process.env.OPENRIG_HOME?.trim() || nodePath.join(process.env.HOME ?? "", ".openrig");
  // The stub compacts its OWN authored transcript (never a foreign one discovered
  // under ~/.claude/projects) — authored below from the resolved script.
  const transcriptPath = nodePath.join(args.cwd, ".openrig", "stub", "transcript.jsonl");
  const io: StubRunnerIO = {
    // eslint-disable-next-line no-console
    mirrorLine: (line) => console.log(line),
    fireCompaction: () => fireCompaction({
      hookScriptPath: resolveStubHookScriptPath(),
      sessionName: args.sessionName,
      openrigHome,
      cwd: args.cwd,
      transcriptPath,
      injectClockNow: process.env.OPENRIG_TEST_CLOCK_NOW,
    }),
    now: nowIso,
  };
  try {
    const script = resolveStubScript(args.cwd, {
      readFile: (p) => nodeFs.readFileSync(p, "utf-8"),
      exists: (p) => nodeFs.existsSync(p),
    });
    // Author the seat's own transcript BEFORE executing, so `emit compaction`
    // fires the real seam over the stub's scripted conversation, not a foreign one.
    nodeFs.mkdirSync(nodePath.dirname(transcriptPath), { recursive: true });
    nodeFs.writeFileSync(
      transcriptPath,
      buildStubTranscript(script, { sessionName: args.sessionName, cwd: args.cwd, sessionId: args.launchId }),
      "utf-8",
    );
    executeStubScript(script, io);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`${STUB_RUNNER_ERROR_MARKER} script execution failed: ${(err as Error).message}`);
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
