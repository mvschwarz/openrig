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

/** One parsed line of the Claude generation JSONL (the shape
 *  effective-model-readers.readClaudeEffectiveModel traces): each line is
 *  {type, message:{role, model, content:[blocks], stop_reason}}. Lines that do
 *  not parse (a partial trailing write, a non-message record) are skipped —
 *  the capture grades MESSAGES, and a corrupt line is never silently graded. */
interface GenerationRecordLine {
  type?: string;
  message?: {
    role?: string;
    stop_reason?: string | null;
    content?: Array<{ type?: string; text?: string; input?: unknown; command?: unknown }> | string;
  };
}

function parseRecordLines(suffix: string): GenerationRecordLine[] {
  const out: GenerationRecordLine[] = [];
  for (const line of suffix.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as GenerationRecordLine;
      if (parsed !== null && typeof parsed === "object") out.push(parsed);
    } catch {
      // Partial/corrupt line — not a message; skipped, never graded.
    }
  }
  return out;
}

function contentBlocks(rec: GenerationRecordLine): Array<{ type?: string; text?: string; input?: unknown }> {
  const c = rec.message?.content;
  return Array.isArray(c) ? c : [];
}

/** A user-role record that is a genuine INPUT (text), as opposed to the
 *  tool_result continuation records the runtime writes with role "user" as
 *  part of the assistant's own tool cycle. PIN 4 fails a case closed on the
 *  former; the latter is the assistant's turn in progress. */
function isUserTextInput(rec: GenerationRecordLine): boolean {
  if (rec.message?.role !== "user") return false;
  const blocks = contentBlocks(rec);
  if (typeof rec.message?.content === "string") return true;
  if (blocks.some((b) => b.type === "tool_result")) return false;
  return blocks.some((b) => b.type === "text");
}

const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens"]);

/** Assistant OUTPUT text only: text blocks verbatim, tool_use blocks as their
 *  grader-matchable command (the DOOR grader pattern-matches command strings) —
 *  never the JSON message envelope, never a user record. */
function assistantText(records: GenerationRecordLine[]): string {
  const parts: string[] = [];
  for (const rec of records) {
    if (rec.message?.role !== "assistant") continue;
    for (const block of contentBlocks(rec)) {
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "tool_use") {
        const input = block.input as Record<string, unknown> | undefined;
        const command = input?.["command"];
        parts.push(typeof command === "string" ? command : JSON.stringify(input ?? {}));
      }
    }
  }
  return parts.join("\n");
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
          // PIN 5 (envelope neutralization, desk ruling 6fa281f1): the probe goes RAW — exact text,
          // no From/To envelope, no reply hint. The frozen criteria's probes are answered in place;
          // a standard-envelope send hands a blank seat an actionable transport invitation, which is
          // harness leakage (the voided run's contamination arrived exactly that way).
          await withRetry(() => exec(["send", "--raw", sessionName, prompt]));
        },
        async captureSince(_prompt: string): Promise<string> {
          const deadline = Date.now() + timeoutMs;
          const failures = { n: 0 };
          // JSONL-SCHEMA-AWARE capture (harness correction; RED pins b4d8d1797 + desk pins 4-5):
          // poll the append-only record and PARSE the suffix since the pre-send content as message
          // lines. The done-signal is NATIVE-TURN COMPLETION — the suffix's LAST assistant message
          // carries a TERMINAL stop_reason — never content-stability (the 80-byte-footer bug). The
          // graded value is assistant/tool OUTPUT TEXT ONLY — never the user prompt, never the JSON
          // envelope. Custody is enforced per-case: an intervening user input fails the case closed.
          for (;;) {
            if (Date.now() > deadline) {
              throw new Error(`captureSince: seat '${sessionName}' did not complete a native turn within ${timeoutMs}ms (no terminal stop_reason observed; did not go stable is retired as a done-signal)`);
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
            const records = parseRecordLines(content.slice(preSendRecord.length));
            // PIN 4 — INTERVENING-INPUT FAIL-CLOSED (desk ruling 6fa281f1): the FIRST user text record
            // is the prompt's own delivery; ANY further user-role TEXT record entering the generation
            // before the turn completes voids the CASE, loudly. Detection, not prevention — a terminal
            // accepts input by design; the harness refuses to grade a contaminated case so a repeat
            // costs one case, never a run. tool_result records carry role "user" but are the
            // assistant's own tool cycle — they are NOT intervening input (see isUserTextInput).
            const userInputs = records.filter(isUserTextInput);
            if (userInputs.length > 1) {
              throw new Error(`captureSince: CASE INVALID — ${userInputs.length - 1} intervening user input record(s) entered generation '${boundGenerationId}' of '${sessionName}' between prompt delivery and native-turn completion; the frozen no-intervening-input custody rule fails this case closed`);
            }
            // NATIVE-TURN COMPLETION: return only when the suffix's LAST assistant message is TERMINAL
            // ("end_turn"/"stop_sequence"/"max_tokens" — NOT "tool_use", NOT null). Otherwise keep
            // polling to the deadline: a footer-only or stop_reason:null fragment is an OPEN turn.
            const assistants = records.filter((r) => r.message?.role === "assistant");
            const lastAssistant = assistants[assistants.length - 1];
            const stop = lastAssistant?.message?.stop_reason;
            if (typeof stop === "string" && TERMINAL_STOP_REASONS.has(stop)) {
              // OUTPUT-ONLY: assistant text + tool_use command blocks — what the DOOR grader
              // pattern-matches. The user prompt and every JSON envelope byte are excluded by
              // construction (role filter + block extraction), so no echo-strip slicing is needed here;
              // the leading-echo strip remains the PROVIDER's contract on its own boundary.
              return assistantText(records);
            }
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
