/**
 * Test-A preflight blocker 3, round 6/7 — the LIVE runner wiring behind
 * `run-evals.mjs --provider rig`. review-r2 round-6 HIGH-1: the current-generation record reader must
 * be wired into the SHIPPED entry, not only injected in tests, or the runner refuses before the first
 * Test-A prompt. This module factors the runner's rig-provider construction out of run-evals.mjs so the
 * public seam — reader injection + one-natural-send + current-generation suffix capture — is unit-pinned.
 *
 * The boundary is the seat's CURRENT-generation APPEND-ONLY Claude conversation record (desk ruling
 * Option B). The generation identity + the append-only JSONL path are resolved AUTHORITATIVELY from the
 * seat's status-line sidecar via ContextUsageStore.readAndNormalize (the same record the daemon reads);
 * a rolled generation or a missing record is a loud refusal (the roll/prefix tripwires live in the
 * session helper).
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { ContextUsageStore } from "../../src/domain/context-usage-store.js";
import { createRigCliSession, type RigExec } from "./eval-rig-session.js";
import type { RigSeatSession } from "./eval-rig-provider.js";

export interface GenerationRecord { generationId: string; content: string }
export type GenerationRecordReader = (seat: string) => Promise<GenerationRecord>;

export interface RunnerReaderDeps {
  /** OpenRig state dir (default: $OPENRIG_HOME); the sidecar lives at <stateDir>/context/<seat>.json. */
  stateDir?: string;
  /** Read a transcript file (default: fs.readFileSync utf-8) — injectable for the entry discriminator. */
  readFile?: (path: string) => string;
}

/**
 * The authoritative current-generation record reader for the live runner. Resolves the seat's CURRENT
 * Claude conversation record from the status-line sidecar (ContextUsageStore.readAndNormalize: sessionId
 * is the generation identity, transcriptPath is the append-only JSONL), then reads that JSONL. LOUD
 * REFUSAL when no current-generation record resolves (a Codex or unprimed seat, or a missing sidecar) —
 * never a silent degrade, never a fall-back to the bounded pane. The read path is file-based off
 * stateDir; the db is unused for reads, so a throwaway in-memory handle satisfies the constructor
 * without a live daemon db.
 */
export function defaultRunnerGenerationReader(deps: RunnerReaderDeps = {}): GenerationRecordReader {
  const stateDir = deps.stateDir ?? process.env.OPENRIG_HOME;
  if (!stateDir) {
    return async () => {
      throw new Error("run-evals --provider rig: OPENRIG_HOME is unset — cannot resolve the seat's current-generation conversation record");
    };
  }
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const store = new ContextUsageStore(new Database(":memory:"), { stateDir });
  return async (seat: string): Promise<GenerationRecord> => {
    const usage = store.readAndNormalize(seat);
    if (!usage.sessionId || !usage.transcriptPath) {
      throw new Error(
        `run-evals --provider rig: seat '${seat}' has no current-generation Claude conversation record ` +
          `(sidecar sessionId/transcriptPath unresolved) — observation refused. Round-6 Option B requires an ` +
          `append-only generation JSONL; a Codex seat or an unprimed seat is unsupported.`,
      );
    }
    let content: string;
    try {
      content = readFile(usage.transcriptPath);
    } catch (err) {
      throw new Error(`run-evals --provider rig: cannot read the current-generation transcript for '${seat}' at ${usage.transcriptPath}: ${(err as Error).message}`);
    }
    return { generationId: usage.sessionId, content };
  };
}

/**
 * Build the persistent RigSeatSession the runner drives: one attach (--seat) or spawn (--seat-spec),
 * with the out-of-band boundary bound to the current-generation record reader (real by default;
 * injectable for the entry discriminator). This is the public runner seam r2 HIGH-1 requires wired.
 */
export function buildRigProviderSession(opts: {
  seat?: string | null;
  spec?: string | null;
  exec?: RigExec;
  readGenerationRecord?: GenerationRecordReader;
  stateDir?: string;
  readFile?: (path: string) => string;
  /** Session timing passthrough (production uses the defaults; tests drive it fast). */
  session?: { pollMs?: number; stablePolls?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> };
}): { spawn: () => Promise<RigSeatSession> } {
  const readGenerationRecord = opts.readGenerationRecord ?? defaultRunnerGenerationReader({ stateDir: opts.stateDir, readFile: opts.readFile });
  const base = opts.seat != null ? { seat: opts.seat } : { spec: opts.spec! };
  return createRigCliSession({
    ...base,
    ...(opts.exec ? { exec: opts.exec } : {}),
    ...(opts.session ?? {}),
    readGenerationRecord,
  });
}
