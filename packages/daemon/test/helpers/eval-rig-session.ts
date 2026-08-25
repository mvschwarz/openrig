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
 *   capture — the boundary is the seat's APPEND-ONLY transcript, read OUT-OF-BAND
 *             via `rig transcript <seat> --tail N` (reading submits nothing to the
 *             seat). Record the pre-send transcript, poll it until STABLE
 *             (unchanged across consecutive polls), then return the SUFFIX since
 *             the pre-send transcript (its non-LCS lines). Because the transcript
 *             only APPENDS — never scrolls or redraws like a pane — an old
 *             identical command line stays in the matched prefix and is never
 *             mistaken for the current turn, so no in-band marker is needed. The
 *             prompt echo is skipped within the suffix so grading starts at the
 *             response; the leading-echo strip itself stays the PROVIDER's
 *             contract (eval-rig-provider.ts) — this module only bounds
 *             "since the prompt".
 *   retire  — `rig down <rig>` exactly when THIS session spawned the rig;
 *             attaching never destroys someone else's seat.
 *
 * Every rig invocation goes through an injectable exec so the mechanics are
 * unit-pinned without a daemon; the live entry injects nothing and gets the
 * real CLI.
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
  captureLines?: number;
  /** Round-5 custody boundary: how many trailing transcript lines to read as the out-of-band window
   *  (default 100000 — large enough that a short eval seat's whole transcript is a stable prefix, so
   *  the pre-send read is a prefix of the post-send read). The APPEND-ONLY transcript, not the
   *  scrolling pane, is the boundary — reading it submits nothing to the seat. */
  transcriptLines?: number;
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
    transcriptLines = 100_000,
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

      // Round-5 custody: the boundary is the seat's APPEND-ONLY transcript, read out-of-band via
      // `rig transcript` — reading it submits NOTHING to the seat (unlike round-4's eval-sync marker
      // send, which was a forbidden intervening input).
      const readTranscript = () => exec(["transcript", sessionName, "--tail", String(transcriptLines)]);
      // A single transcript read can time out at the CLI's 5s bound when the daemon is briefly
      // lag-slow (measured live). A transient poll failure is NOT a dead seat — return null so the
      // loop waits and retries; the overall deadline still bounds a genuinely stuck seat. Consecutive
      // failures past a bound ARE a dead daemon and surface loud.
      const maxConsecutiveReadFailures = 8;
      const tolerantRead = async (failures: { n: number }): Promise<string | null> => {
        try {
          const out = await readTranscript();
          failures.n = 0;
          return out;
        } catch (err) {
          failures.n += 1;
          if (failures.n >= maxConsecutiveReadFailures) {
            throw new Error(`captureSince: ${failures.n} consecutive transcript-read failures for '${sessionName}' — daemon unresponsive: ${(err as Error).message}`);
          }
          return null;
        }
      };
      let preSendTranscript = "";

      return {
        generation,
        async sendPrompt(prompt: string): Promise<void> {
          // Round-5 custody: record the pre-send APPEND-ONLY transcript as the out-of-band boundary
          // (reading submits nothing to the seat), then submit EXACTLY ONE input — the natural prompt.
          // No eval-sync marker: a second `rig send` is an intervening input the frozen Test-A custody
          // contract forbids (round-4's defect). A failed pre-read is a best-effort empty anchor, never
          // an aborted case. The SEND is the load-bearing action and IS retried.
          preSendTranscript = await withRetry(() => readTranscript()).catch(() => "");
          await withRetry(() => exec(["send", sessionName, prompt]));
        },
        async captureSince(prompt: string): Promise<string> {
          const deadline = Date.now() + timeoutMs;
          let last = "";
          let stable = 0;
          const failures = { n: 0 };
          // Poll the APPEND-ONLY transcript: first wait for ANY growth past the pre-send transcript
          // (the seat consumed the prompt and recorded its turn), then for stability (it stopped
          // appending). The suffix since the pre-send transcript is the current turn.
          for (;;) {
            if (Date.now() > deadline) {
              throw new Error(`captureSince: seat '${sessionName}' did not go stable within ${timeoutMs}ms`);
            }
            await sleep(pollMs);
            const now = await tolerantRead(failures);
            if (now === null) continue;
            if (now === last && now !== preSendTranscript) {
              stable += 1;
              if (stable >= stablePolls) return sliceAfterPrompt(now, prompt, preSendTranscript);
            } else {
              stable = 0;
            }
            last = now;
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
