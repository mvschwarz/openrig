/**
 * Test-A preflight blocker 3 (row testa-provider) — the LIVE RigSeatSession
 * wiring behind `run-evals.mjs --provider rig`. Drives ONE persistent real seat
 * through the supported rig CLI surfaces only:
 *
 *   spawn   — attach to a named seat (--seat) or `rig up` a scratch spec
 *             (--seat-spec) and adopt its single launched seat; the seat's
 *             GENERATION comes from `rig whoami --session <seat> --json`.
 *   send    — `rig send <seat> <prompt>` (argv array, never a shell string).
 *             EXACTLY ONE submitted input per case — the natural prompt. Round 5
 *             (custody fix): no eval-sync marker send. Round 4 emitted a unique
 *             nonce as a SECOND `rig send` before the prompt to disambiguate the
 *             pane boundary; on a `claude-code` seat that is an extra user turn,
 *             a forbidden intervening input under Test-A's no-intervening-input
 *             custody contract. Removed.
 *   capture — the boundary is the seat's CURRENT-GENERATION APPEND-ONLY conversation
 *             record (the Claude generation JSONL), read OUT-OF-BAND via the injected
 *             readGenerationRecord (reading submits nothing to the seat). Round 6
 *             (desk ruling Option B): r2 HIGH-1 falsified round-5's `rig transcript`
 *             boundary — that CLI reads a bounded-OVERWRITE pane snapshot, not an
 *             append-only file, so a repeated command could erase current-turn
 *             evidence. sendPrompt binds the current generation identity explicitly
 *             (never path-guessing) and records its content; captureSince polls the
 *             record to stability and returns the SUFFIX since the pre-send content
 *             (an exact slice — append-only within a generation guarantees a prefix).
 *             GENERATION-CHANGE TRIPWIRE: if the generation rolls mid-observation (a
 *             re-prime starts a new JSONL) captureSince FAILS LOUD rather than read
 *             across the swap. LOUD REFUSAL on an unsupported runtime / no record
 *             (never a silent degrade, never a fall-back to the bounded pane). The
 *             leading-echo strip stays the PROVIDER's contract (eval-rig-provider.ts);
 *             this module only bounds "since the prompt".
 *   retire  — `rig down <rig>` exactly when THIS session spawned the rig;
 *             attaching never destroys someone else's seat.
 *
 * Every rig CLI invocation goes through an injectable exec, and the generation-record
 * read through an injectable reader, so the mechanics are unit-pinned without a
 * daemon; the live entry injects the real CLI + the contextUsageStore-backed reader.
 */

import { execFile } from "node:child_process";
import type { RigSeatSession } from "./eval-rig-provider.js";

export type RigExec = (args: string[]) => Promise<string>;

export interface RigCliSessionOptions {
  /** Attach to an existing session (mutually exclusive with spec). */
  seat?: string;
  /** `rig up` this spec and adopt its single launched seat. */
  spec?: string;
  rigBin?: string;
  exec?: RigExec;
  /** Poll interval while waiting for the pane to go stable. */
  pollMs?: number;
  /** Consecutive identical captures that count as "the seat finished". */
  stablePolls?: number;
  /** Hard per-prompt ceiling; expiring is an ERROR, never a silent partial. */
  timeoutMs?: number;
  /**
   * Round-6 boundary (desk ruling qitem-...-1117052f, Option B): read the seat's CURRENT-generation
   * APPEND-ONLY conversation record — the only monotonic, no-input boundary source. r2 HIGH-1
   * falsified `rig transcript` (a bounded-OVERWRITE pane snapshot); the Claude generation JSONL is the
   * measured append-only record. Returns { generationId, content }:
   *   - generationId: the record's generation identity (the Claude session id / rollout id). A re-prime
   *     rolls it — that is the generation-change tripwire signal.
   *   - content: the append-only record content (a prefix of every later read WITHIN a generation).
   * MUST THROW (loud refusal, never a silent degrade) on an unsupported runtime (e.g. a Codex seat with
   * no Claude generation JSONL) or a seat with no resolvable generation record. Required for round-6;
   * the live entry injects the contextUsageStore-backed reader (resolve identity explicitly, never by
   * path-guessing).
   */
  readGenerationRecord?: (seat: string) => Promise<{ generationId: string; content: string }>;
  sleep?: (ms: number) => Promise<void>;
}

function defaultExec(rigBin: string): RigExec {
  return (args: string[]) =>
    new Promise((resolvePromise, reject) => {
      execFile(rigBin, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${rigBin} ${args[0]} failed: ${err.message}${stderr ? ` — ${stderr.slice(0, 400)}` : ""}`));
        else resolvePromise(stdout);
      });
    });
}

/** Whitespace-normalized haystack with a map from normalized index -> raw index. */
function normalized(raw: string): { text: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (/\s/.test(c)) continue;
    chars.push(c);
    map.push(i);
  }
  return { text: chars.join(""), map };
}

/** The lines of `post` that are NOT part of its longest common subsequence with
 *  `pre` — i.e. what the terminal produced SINCE the pre-send snapshot. Line-LCS
 *  is the right boundary because it is robust to all three real terminal shapes:
 *  APPEND (new lines at the end), SCROLL (shared lines shift up, top falls off),
 *  and REDRAW (the input/status footer reappears at the bottom — it is common to
 *  both snapshots, so LCS matches it and it is NOT counted as new). A footer or
 *  prompt that merely repeats can never become the boundary. */
function newLinesSince(pre: string, post: string): string[] {
  const a = pre.split("\n");
  const b = post.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS length DP.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  // Backtrack: mark which `b` (post) lines are matched into the LCS.
  const matched = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      matched[j] = true;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  const out: string[] = [];
  for (let k = 0; k < m; k++) if (!matched[k]) out.push(b[k]!);
  return out;
}

/** Slice of the seat's output SINCE the current prompt was sent, bounded by the APPEND-ONLY
 *  transcript (round-5 custody fix).
 *
 *  BOUNDARY: the transcript SUFFIX — the lines of `post` not in its longest common subsequence with
 *  the pre-send transcript `preSendCapture`. Because the transcript only APPENDS (it never scrolls or
 *  redraws like a pane), an OLD identical command line sits in the matched common prefix and can never
 *  be mistaken for the current turn's re-emission — so no in-band marker need be submitted to the seat
 *  (round-4's eval-sync marker was a second `rig send`, a forbidden intervening input; round-5 removes
 *  it entirely). Within the suffix the prompt echo (wrapped or TUI-truncated) is skipped so grading
 *  starts at the response; a later genuine quotation is kept (it is in the suffix, after the echo). */
export function sliceAfterPrompt(rawCapture: string, prompt: string, preSendCapture: string): string {
  const region = preSendCapture.length > 0 ? newLinesSince(preSendCapture, rawCapture).join("\n") : rawCapture;

  const hay = normalized(region);
  const fullNeedle = normalized(prompt).text;
  for (const needle of [fullNeedle, fullNeedle.slice(0, 16)]) {
    if (needle.length === 0) continue;
    const at = hay.text.indexOf(needle);
    if (at >= 0) {
      const endNorm = at + needle.length - 1;
      let rawEnd = hay.map[endNorm]! + 1;
      // On a PARTIAL (truncated-echo) match, skip the rest of the echo line.
      if (needle !== fullNeedle) {
        const nl = region.indexOf("\n", rawEnd);
        rawEnd = nl >= 0 ? nl + 1 : region.length;
      }
      return region.slice(rawEnd).replace(/^\n/, "");
    }
  }
  // Echo fully truncated/scrolled: the region IS the post-send output.
  return region.replace(/^\n/, "");
}

interface UpNodeDetail {
  stages?: Array<{ detail?: { nodes?: Array<{ logicalId?: string; status?: string }> } }>;
  attachCommand?: string;
  rigId?: string;
  status?: string;
}

export function createRigCliSession(options: RigCliSessionOptions): { spawn: () => Promise<RigSeatSession> } {
  const {
    seat,
    spec,
    rigBin = "rig",
    exec = defaultExec(rigBin),
    pollMs = 5_000,
    stablePolls = 2,
    timeoutMs = 300_000,
    readGenerationRecord,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = options;
  if ((seat === undefined) === (spec === undefined)) {
    throw new Error("createRigCliSession: exactly ONE of seat (attach) or spec (spawn) is required");
  }

  return {
    async spawn(): Promise<RigSeatSession> {
      let sessionName: string;
      let spawnedRig: string | undefined;
      // The live daemon can be briefly unresponsive under load (its CLI probe
      // gives up at 5s and tries to spawn a SECOND daemon, which port-conflicts)
      // — retry with backoff instead of churning rigs.
      const withRetry = async (fn: () => Promise<string>, attempts = 6, backoffMs = 10_000): Promise<string> => {
        let lastErr: unknown;
        for (let i = 0; i < attempts; i++) {
          try {
            return await fn();
          } catch (err) {
            lastErr = err;
            if (i < attempts - 1) await sleep(backoffMs);
          }
        }
        throw lastErr;
      };
      // Once `rig up` returns, it may have CREATED a rig — record ownership
      // IMMEDIATELY (by rigId, which survives even if the attach line can't be
      // parsed) so EVERY later failure path can tear it down (review50-r2 QA
      // finding 2). Attach mode records nothing and tears nothing down.
      // If ANY post-up step fails, retire the rig we created.
      const cleanupOnFailure = async (err: unknown): Promise<never> => {
        if (spawnedRig !== undefined) {
          await withRetry(() => exec(["down", spawnedRig!])).catch(() => {});
        }
        throw err;
      };

      if (spec !== undefined) {
        const up = JSON.parse(await withRetry(() => exec(["up", spec, "--json"]))) as UpNodeDetail;
        spawnedRig = up.rigId ?? undefined; // own it before any validation can throw
        const attach = up.attachCommand ?? "";
        const m = attach.match(/-t\s+(\S+)/);
        if (up.status !== "completed" || !m) {
          await cleanupOnFailure(new Error(`rig up did not launch a seat (status=${up.status ?? "?"}, attach=${JSON.stringify(attach)})`));
        }
        sessionName = m![1]!;
        spawnedRig = spawnedRig ?? sessionName.split("@").pop();
      } else {
        sessionName = seat!;
      }

      // ALL identity validation is inside cleanupOnFailure's reach: a successful
      // whoami with an empty/malformed identity must still retire a spawned rig.
      let generation: string | undefined;
      try {
        const who = JSON.parse(
          await withRetry(() => exec(["whoami", "--session", sessionName, "--json"])),
        ) as Record<string, unknown>;
        // The live shape nests the identity: { resolvedBy, identity: { nodeId, ... }, ... }.
        const identity = (who["identity"] ?? who) as Record<string, unknown>;
        generation =
          (identity["occupantGeneration"] as string | undefined) ??
          (identity["occupant_generation"] as string | undefined) ??
          (identity["generation"] as string | undefined) ??
          (identity["nodeId"] as string | undefined) ??
          (identity["node_id"] as string | undefined);
        if (typeof generation !== "string" || generation.length === 0) {
          throw new Error(`cannot derive a stable seat generation from rig whoami for '${sessionName}' — got identity keys ${Object.keys(identity).join(",")}`);
        }
      } catch (err) {
        await cleanupOnFailure(err);
      }

      // Round-6 boundary (desk ruling Option B): the seat's CURRENT-generation APPEND-ONLY conversation
      // record, read OUT-OF-BAND (reading submits nothing to the seat). The reader is REQUIRED — a
      // missing reader is a loud refusal at first observation (never a silent fall-back to the
      // bounded-overwrite pane, r2 HIGH-1). Checked lazily so a spawn+retire path that never observes
      // does not need it.
      const readRecord = (seat: string): Promise<{ generationId: string; content: string }> => {
        if (!readGenerationRecord) {
          throw new Error("round-6 requires readGenerationRecord (the current-generation append-only record reader); none was injected — refusing rather than falling back to the bounded-overwrite pane transcript");
        }
        return readGenerationRecord(seat);
      };
      // A transient read failure (daemon lag) is tolerated up to a bound; sustained is a dead daemon,
      // surfaced loud. A record read failure is NOT a generation change — do not trip the tripwire on it.
      const maxConsecutiveReadFailures = 8;
      const tolerantRead = async (failures: { n: number }): Promise<{ generationId: string; content: string } | null> => {
        try {
          const out = await readRecord(sessionName);
          failures.n = 0;
          return out;
        } catch (err) {
          failures.n += 1;
          if (failures.n >= maxConsecutiveReadFailures) {
            throw new Error(`captureSince: ${failures.n} consecutive generation-record read failures for '${sessionName}' — daemon unresponsive: ${(err as Error).message}`);
          }
          return null;
        }
      };
      // Bound ONCE for the session's LIFETIME (r2 round-7 HIGH-1): Test-A observes every case
      // (baseline -> WALK -> GET -> post) on ONE seat/session/generation. null until the first case binds it.
      let boundGenerationId: string | null = null;
      let preSendRecord = "";

      return {
        generation,
        async sendPrompt(prompt: string): Promise<void> {
          // Resolve the CURRENT generation record EXPLICITLY (constraint 1: identity from the reader,
          // never path-guessing). An unsupported runtime / no record throws HERE (constraint 2: loud
          // refusal). The FIRST case binds the session generation; every LATER case compares against
          // that lifetime binding and FAILS LOUD before the send if it changed (a re-prime BETWEEN
          // cases crosses the single-generation run) — the binding is NEVER overwritten, so a mid-run
          // generation swap can never be silently accepted (r2 round-7 HIGH-1). Then submit EXACTLY ONE
          // input — the natural prompt (the frozen one-send custody contract; no marker). The SEND is
          // the load-bearing action and IS retried.
          const rec = await withRetry(() => readRecord(sessionName));
          if (boundGenerationId === null) {
            boundGenerationId = rec.generationId;
          } else if (rec.generationId !== boundGenerationId) {
            throw new Error(`sendPrompt: seat '${sessionName}' generation changed BETWEEN cases (session bound to '${boundGenerationId}', now '${rec.generationId}') — a re-prime crossed the single-generation Test-A run; refusing to send another prompt`);
          }
          preSendRecord = rec.content;
          await withRetry(() => exec(["send", sessionName, prompt]));
        },
        async captureSince(prompt: string): Promise<string> {
          const deadline = Date.now() + timeoutMs;
          let last = "";
          let stable = 0;
          const failures = { n: 0 };
          // Poll the append-only record: wait for growth past the pre-send content (the seat recorded
          // its turn), then for stability. The suffix since the pre-send content is the current turn.
          for (;;) {
            if (Date.now() > deadline) {
              throw new Error(`captureSince: seat '${sessionName}' did not go stable within ${timeoutMs}ms`);
            }
            await sleep(pollMs);
            const rec = await tolerantRead(failures);
            if (rec === null) continue;
            // GENERATION-CHANGE TRIPWIRE (constraint 3): a re-prime rolls the record id and starts a NEW
            // append-only file whose offsets are unrelated to the pre-send one. A cursor that survives a
            // generation swap is lying — refuse loud rather than slice the new file.
            if (rec.generationId !== boundGenerationId) {
              throw new Error(`captureSince: seat '${sessionName}' generation changed mid-observation (bound '${boundGenerationId}', now '${rec.generationId}') — the observation window is void; refusing to read across the swap`);
            }
            const content = rec.content;
            // Within one generation the record is APPEND-ONLY, so the pre-send content MUST be a prefix;
            // a non-prefix means the "append-only" contract is violated for this source — refuse loud
            // rather than emit a mis-bounded slice.
            if (!content.startsWith(preSendRecord)) {
              throw new Error(`captureSince: generation '${boundGenerationId}' record is not append-only for '${sessionName}' (pre-send content is not a prefix) — boundary unsound, refusing`);
            }
            if (content === last && content !== preSendRecord) {
              stable += 1;
              if (stable >= stablePolls) return sliceAfterPrompt(content.slice(preSendRecord.length), prompt, "");
            } else {
              stable = 0;
            }
            last = content;
          }
        },
        async retire(): Promise<void> {
          if (spawnedRig !== undefined) {
            await withRetry(() => exec(["down", spawnedRig!]));
          }
        },
      };
    },
  };
}
