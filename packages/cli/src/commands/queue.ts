import fs from "node:fs";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig queue` — coordination primitive L3/inbox/outbox commands (PL-004 Phase A).
 *
 * Backed by `/api/queue`. Operates only via the daemon HTTP API.
 * Does NOT touch the POC `rigx-queue-proto` filesystem state.
 *
 * Hot-potato strict-rejection is enforced at the daemon; `update --state done`
 * without `--closure-reason` returns exit 1 with structured error naming the
 * 6 valid closure reasons.
 */

export interface QueueDeps extends StatusDeps {}

async function withClient<T>(
  deps: QueueDeps,
  fn: (client: DaemonClient) => Promise<T>
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (status.state !== "running" || status.healthy === false) {
    console.error("Daemon not running. Start it with: rig daemon start");
    process.exitCode = 1;
    return undefined;
  }
  const client = deps.clientFactory(getDaemonUrl(status));
  return fn(client);
}

function printResult(json: boolean, body: unknown, status: number): void {
  if (json) {
    console.log(JSON.stringify(body));
  } else {
    console.log(JSON.stringify(body, null, 2));
  }
  if (status >= 400) process.exitCode = status >= 500 ? 2 : 1;
}

// OPR.0.4.3.03 — `rig queue show` body preview.
//
// Default `show` renders a BOUNDED body preview instead of dumping the whole
// qitem body into the agent's context; `--full` opts back into the complete
// body. The bound is a CODE-POINT count (delivery-set, adjustable) per
// IMPL-SPEC §2.3-2.4.
const SHOW_BODY_PREVIEW_MAX_CODEPOINTS = 512;

export interface BodyPreview {
  preview: string;
  bodyBytes: number;
  bodyTruncated: boolean;
}

// Multibyte-SAFE bounded preview (IMPL-SPEC §2.3-2.4). The preview is the first
// N CODE POINTS: `Array.from(body)` splits by code point (never a surrogate
// pair / multibyte char), so the slice is inherently multibyte-safe and never
// emits a partial/invalid UTF-8 sequence. `bodyTruncated` is CODE-POINT-count
// based (codePointCount > N). `bodyBytes` is the honest TRUE total UTF-8 byte
// length of the FULL body (never the truncated size).
export function previewBody(
  body: string,
  maxCodePoints = SHOW_BODY_PREVIEW_MAX_CODEPOINTS
): BodyPreview {
  const bodyBytes = Buffer.byteLength(body, "utf8");
  const codePoints = Array.from(body);
  if (codePoints.length <= maxCodePoints) {
    return { preview: body, bodyBytes, bodyTruncated: false };
  }
  return {
    preview: codePoints.slice(0, maxCodePoints).join(""),
    bodyBytes,
    bodyTruncated: true,
  };
}

function isRecordWithStringBody(v: unknown): v is Record<string, unknown> & { body: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).body === "string"
  );
}

// OPR.0.3.2.21.FR-4(a) — body input resolution. Three accepted shapes:
//   --body "<text>"               inline (legacy; backtick-prone for raw
//                                 multiline content)
//   --body-file <path>            read body content from a file path
//                                 (kills the backtick-corruption class)
//   --body-file -    or  --body - read body from stdin (pipeline-friendly)
//
// Exactly one of --body / --body-file must be provided; the resolver throws
// a 3-part fact/consequence/action error otherwise.
//
// stdinReader is dependency-injected so tests can swap it without touching
// process.stdin. Default reads UTF-8 from process.stdin until EOF.
export interface ResolveBodyOpts {
  body?: string;
  bodyFile?: string;
}

export async function defaultStdinReader(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
    if (process.stdin.isTTY) {
      // No pipe is connected to stdin; resolve immediately to empty
      // rather than blocking forever waiting for data on a TTY. The
      // empty body then flows through to the daemon's content
      // validation (queue-repository owns the body contract); the CLI
      // does not error locally on empty stdin.
      resolve("");
    }
  });
}

export async function resolveQueueBody(
  opts: ResolveBodyOpts,
  stdinReader: () => Promise<string> = defaultStdinReader,
): Promise<string> {
  const hasInline = opts.body !== undefined && opts.body !== "";
  const hasFile = opts.bodyFile !== undefined && opts.bodyFile !== "";
  if (hasInline && hasFile) {
    const err = new Error("--body and --body-file are mutually exclusive.") as Error & { fact?: string; consequence?: string; action?: string };
    err.fact = "Both --body and --body-file were passed; the body source is ambiguous.";
    err.consequence = "rig queue create did not run; daemon was not contacted.";
    err.action = "Pass exactly one of --body or --body-file.";
    throw err;
  }
  if (!hasInline && !hasFile) {
    const err = new Error("Missing required body input.") as Error & { fact?: string; consequence?: string; action?: string };
    err.fact = "Neither --body nor --body-file was provided.";
    err.consequence = "rig queue create did not run; daemon was not contacted.";
    err.action = "Pass the qitem body via --body \"<text>\" or --body-file <path> (use - for stdin).";
    throw err;
  }
  if (hasInline) {
    if (opts.body === "-") return stdinReader();
    return opts.body!;
  }
  // hasFile path
  if (opts.bodyFile === "-") return stdinReader();
  const absPath = opts.bodyFile!;
  if (!fs.existsSync(absPath)) {
    const err = new Error(`--body-file path does not exist: ${absPath}`) as Error & { fact?: string; consequence?: string; action?: string };
    err.fact = `--body-file path does not exist: ${absPath}`;
    err.consequence = "rig queue create did not run; daemon was not contacted.";
    err.action = "Check the path; pass an absolute path; or use --body-file - to read from stdin.";
    throw err;
  }
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) {
    const err = new Error(`--body-file path is not a regular file: ${absPath}`) as Error & { fact?: string; consequence?: string; action?: string };
    err.fact = `--body-file path is not a regular file: ${absPath}`;
    err.consequence = "rig queue create did not run; daemon was not contacted.";
    err.action = "Pass a path to a readable file (not a directory, symlink-to-directory, or block device). Use --body-file - to read from stdin.";
    throw err;
  }
  return fs.readFileSync(absPath, "utf8");
}

function emitBodyResolveError(err: Error & { fact?: string; consequence?: string; action?: string }, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { fact: err.fact ?? err.message, consequence: err.consequence ?? "", action: err.action ?? "" } }, null, 2));
  } else {
    process.stderr.write(`Error: ${err.fact ?? err.message}\n${err.consequence ?? ""}\n${err.action ?? ""}\n`);
  }
  process.exitCode = 1;
}

function resolveCurrentSession(explicit: string | undefined, optionName: string): string | undefined {
  const session = explicit ?? readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
  if (session) return session;

  console.error(`--${optionName} is required when OPENRIG_SESSION_NAME is not set`);
  process.exitCode = 1;
  return undefined;
}

function extractRigName(sessionName: string): string | undefined {
  const atIdx = sessionName.lastIndexOf("@");
  if (atIdx < 0 || atIdx === sessionName.length - 1) return undefined;
  return sessionName.slice(atIdx + 1);
}

export function queueCommand(depsOverride?: QueueDeps): Command {
  const cmd = new Command("queue").description("Coordination L3 — owned-work queue + inbox/outbox");
  const getDeps = (): QueueDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .command("create")
    .description("Create a new qitem")
    .requiredOption("--source <session>", "Source session")
    .requiredOption("--destination <session>", "Destination session (the seat that owns the work)")
    .option("--body <text>", "Qitem body inline (use - to read from stdin; mutually exclusive with --body-file)")
    .option("--body-file <path>", "Read qitem body from a file path (use - for stdin; mutually exclusive with --body). Kills the backtick-shell-corruption class for multiline bodies.")
    .option("--mission <id>", "First-class mission scope; translated to a mission:<id> tag (composes with --tags)")
    .option("--slice <id>", "First-class slice scope; translated to a slice:<id> tag (composes with --tags)")
    .option("--gate <role>", "OPR.0.4.3.16: mark this as a gate qitem; translated to a gate:<role> tag (role e.g. guard | spec-review | pm-lead | qa | human). The idle-gate watchdog reads this predicate. Composes with --tags.")
    .option("--priority <priority>", "Priority: routine | urgent | critical", "routine")
    .option("--tier <tier>", "Tier (e.g. fast, routine, deep, critical) — drives SLA")
    .option("--tags <tags>", "Comma-separated tags (composes with --mission and --slice)")
    .option("--expires-at <iso>", "ISO timestamp at which the qitem expires")
    .option("--id <qitemId>", "Idempotent qitem_id (skip if not provided)")
    .option("--target-repo <name>", "PL-007: typed repo scope (must match a repo in the source rig's RigSpec.workspace.repos[])")
    .option("--summary <text>", "OPR.0.4.1.18: short human-readable 1-2 sentence summary of the work (feeds the Story node label; the agent-speak --body stays the source of truth). Warned-if-missing; pre-18 qitems exempt.")
    .option("--no-nudge", "Suppress the default destination nudge (cold-queue)")
    .option("--json", "JSON output for agents")
    .action(async (opts: {
      source: string;
      destination: string;
      body?: string;
      bodyFile?: string;
      mission?: string;
      slice?: string;
      gate?: string;
      priority: string;
      tier?: string;
      tags?: string;
      expiresAt?: string;
      id?: string;
      targetRepo?: string;
      summary?: string;
      nudge?: boolean;
      json?: boolean;
    }) => {
      // OPR.0.3.2.21.FR-4(a) — resolve body BEFORE contacting the daemon
      // so a missing/ambiguous body fails fast and locally.
      let resolvedBody: string;
      try {
        resolvedBody = await resolveQueueBody({ body: opts.body, bodyFile: opts.bodyFile });
      } catch (err) {
        emitBodyResolveError(err as Error & { fact?: string; consequence?: string; action?: string }, opts.json ?? false);
        return;
      }
      // OPR.0.4.1.18 (FR-7, warn-then-require grace): a summary SHOULD accompany
      // every new qitem (it feeds the Story node + helps humans skim). Warn — to
      // stderr so --json stdout stays clean — but do NOT hard-break existing
      // callers that omit it; hard-require is a future hardening.
      if (!opts.summary) {
        process.stderr.write(
          "warning: rig queue create called without --summary. New qitems should carry a short human-readable summary; the Story node degrades to a body truncation without it. Proceeding (pre-18 callers exempt).\n"
        );
      }
      const deps = getDeps();
      // OPR.0.3.2.21.FR-4(b) — first-class --mission / --slice flags
      // translate to canonical mission:<id> / slice:<id> tags. Composes
      // with --tags (any flag-derived tags prepend; explicit --tags
      // append). De-duplicates so passing both --mission X and
      // --tags mission:X yields one mission:X tag.
      const fromTagsArg = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const fromFlags: string[] = [];
      if (opts.mission) fromFlags.push(`mission:${opts.mission}`);
      if (opts.slice) fromFlags.push(`slice:${opts.slice}`);
      // OPR.0.4.3.16 — first-class --gate <role> stamps a gate:<role> tag
      // (the queue-gate-predicate the idle-gate watchdog reads). Same
      // formalization + de-dup as --mission/--slice.
      if (opts.gate) fromFlags.push(`gate:${opts.gate}`);
      const merged = [...fromFlags, ...fromTagsArg];
      const seen = new Set<string>();
      const dedupedTags = merged.filter((t) => { if (seen.has(t)) return false; seen.add(t); return true; });
      const tags = dedupedTags.length > 0 ? dedupedTags : undefined;
      await withClient(deps, async (client) => {
        const res = await client.post<Record<string, unknown>>("/api/queue/create", {
          qitemId: opts.id,
          sourceSession: opts.source,
          destinationSession: opts.destination,
          body: resolvedBody,
          summary: opts.summary,
          priority: opts.priority,
          tier: opts.tier,
          tags,
          expiresAt: opts.expiresAt,
          targetRepo: opts.targetRepo,
          nudge: opts.nudge,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("claim <qitemId>")
    .description("Claim a qitem (pending → in-progress); computes closure_required_at from tier")
    .option("--destination <session>", "Destination session claiming the qitem (defaults to OPENRIG_SESSION_NAME)")
    .option("--json", "JSON output for agents")
    .action(async (qitemId: string, opts: { destination?: string; json?: boolean }) => {
      const destination = resolveCurrentSession(opts.destination, "destination");
      if (!destination) return;
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/claim`, {
          destinationSession: destination,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("unclaim <qitemId>")
    .description("Release a claimed qitem (in-progress → pending)")
    .option("--destination <session>", "Destination session releasing the qitem (defaults to OPENRIG_SESSION_NAME)")
    .option("--reason <text>", "Reason for unclaim", "manual")
    .option("--json", "JSON output for agents")
    .action(async (qitemId: string, opts: { destination?: string; reason: string; json?: boolean }) => {
      const destination = resolveCurrentSession(opts.destination, "destination");
      if (!destination) return;
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/unclaim`, {
          destinationSession: destination,
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("update <qitemId>")
    .description("Mutate qitem state. state=done REQUIRES --closure-reason (one of: handed_off_to, blocked_on, denied, canceled, no-follow-on, escalation). Closure ≠ acceptance: handed_off_to records delivery to the next stage; acceptance is the next stage's verdict on its own qitem, not this closure.")
    .option("--actor <session>", "Actor session performing the transition (defaults to OPENRIG_SESSION_NAME)")
    .requiredOption("--state <state>", "New state: pending | in-progress | done | blocked | failed | denied | canceled | handed-off")
    .option("--closure-reason <reason>", "Required for state=done")
    .option("--closure-target <target>", "Required for handed_off_to, blocked_on, escalation")
    .option("--note <text>", "Transition note for the audit log")
    .option("--json", "JSON output for agents")
    .action(async (qitemId: string, opts: {
      actor?: string;
      state: string;
      closureReason?: string;
      closureTarget?: string;
      note?: string;
      json?: boolean;
    }) => {
      const actor = resolveCurrentSession(opts.actor, "actor");
      if (!actor) return;
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/update`, {
          actorSession: actor,
          state: opts.state,
          closureReason: opts.closureReason,
          closureTarget: opts.closureTarget,
          transitionNote: opts.note,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("handoff <qitemId>")
    .description("Transactional handoff: closes source as handed-off + creates new qitem owned by --to")
    .option("--from <session>", "Source seat handing off (defaults to OPENRIG_SESSION_NAME)")
    .requiredOption("--to <session>", "Destination seat receiving the new qitem")
    .option("--body <text>", "New qitem body (defaults to source body)")
    .option("--note <text>", "Transition note")
    .option("--priority <priority>", "Override priority for the new qitem")
    .option("--tier <tier>", "Override tier for the new qitem")
    .option("--tags <tags>", "Comma-separated tags for the new qitem")
    .option("--gate <role>", "OPR.0.4.3.16: mark the new qitem as gate work; translated to a gate:<role> tag (e.g. guard | spec-review). The idle-gate watchdog reads this predicate. Composes with --tags.")
    .option("--target-repo <name>", "PL-007: typed repo scope for the new qitem")
    .option("--summary <text>", "OPR.0.4.1.18: short human-readable 1-2 sentence summary for the new qitem (feeds the Story node; --body stays source of truth). Warned-if-missing.")
    .option("--no-nudge", "Suppress the default nudge to the new destination")
    .option("--json", "JSON output for agents")
    .action(async (qitemId: string, opts: {
      from?: string;
      to: string;
      body?: string;
      note?: string;
      priority?: string;
      tier?: string;
      tags?: string;
      gate?: string;
      targetRepo?: string;
      summary?: string;
      nudge?: boolean;
      json?: boolean;
    }) => {
      const from = resolveCurrentSession(opts.from, "from");
      if (!from) return;
      // OPR.0.4.1.18 (FR-7): warn-on-author — a handoff authors a NEW qitem, so
      // it should carry its own summary. Warn to stderr; do not hard-break.
      if (!opts.summary) {
        process.stderr.write(
          "warning: rig queue handoff called without --summary. The new qitem should carry a short human-readable summary; the Story node degrades to a body truncation without it. Proceeding.\n"
        );
      }
      const deps = getDeps();
      // OPR.0.4.3.16 — --gate <role> stamps a gate:<role> tag (composes with
      // --tags, de-duplicated). Guard code-review + spec-review handoffs use
      // this so the idle-gate watchdog's predicate has a producer.
      const explicitTags = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const gateTags = opts.gate ? [`gate:${opts.gate}`] : [];
      const mergedTags = [...gateTags, ...explicitTags];
      const seenTags = new Set<string>();
      const dedupedTags = mergedTags.filter((t) => { if (seenTags.has(t)) return false; seenTags.add(t); return true; });
      const tags = dedupedTags.length > 0 ? dedupedTags : undefined;
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/handoff`, {
          fromSession: from,
          toSession: opts.to,
          body: opts.body,
          summary: opts.summary,
          transitionNote: opts.note,
          priority: opts.priority,
          tier: opts.tier,
          tags,
          targetRepo: opts.targetRepo,
          nudge: opts.nudge,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("handoff-and-complete <qitemId>")
    .description(
      "Atomic close (state=done, closure_reason=handed_off_to) + create new qitem owned by --to. Variant of handoff that fully terminates the source qitem."
    )
    .option("--from <session>", "Source seat handing off (defaults to OPENRIG_SESSION_NAME)")
    .requiredOption("--to <session>", "Destination seat receiving the new qitem")
    .option("--body <text>", "New qitem body (defaults to source body)")
    .option("--note <text>", "Transition note")
    .option("--priority <priority>", "Override priority for the new qitem")
    .option("--tier <tier>", "Override tier for the new qitem")
    .option("--tags <tags>", "Comma-separated tags for the new qitem")
    .option("--gate <role>", "OPR.0.4.3.16: mark the new qitem as gate work; translated to a gate:<role> tag (e.g. guard | spec-review). The idle-gate watchdog reads this predicate. Composes with --tags.")
    .option("--target-repo <name>", "PL-007: typed repo scope for the new qitem")
    .option("--summary <text>", "OPR.0.4.1.18: short human-readable 1-2 sentence summary for the new qitem (feeds the Story node; --body stays source of truth). Warned-if-missing.")
    .option("--no-nudge", "Suppress the default nudge to the new destination")
    .option("--json", "JSON output for agents")
    .action(async (qitemId: string, opts: {
      from?: string;
      to: string;
      body?: string;
      note?: string;
      priority?: string;
      tier?: string;
      tags?: string;
      gate?: string;
      targetRepo?: string;
      summary?: string;
      nudge?: boolean;
      json?: boolean;
    }) => {
      const from = resolveCurrentSession(opts.from, "from");
      if (!from) return;
      // OPR.0.4.1.18 (FR-7): warn-on-author — a handoff authors a NEW qitem, so
      // it should carry its own summary. Warn to stderr; do not hard-break.
      if (!opts.summary) {
        process.stderr.write(
          "warning: rig queue handoff called without --summary. The new qitem should carry a short human-readable summary; the Story node degrades to a body truncation without it. Proceeding.\n"
        );
      }
      const deps = getDeps();
      // OPR.0.4.3.16 — --gate <role> stamps a gate:<role> tag (composes with
      // --tags, de-duplicated). Guard code-review + spec-review handoffs use
      // this so the idle-gate watchdog's predicate has a producer.
      const explicitTags = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const gateTags = opts.gate ? [`gate:${opts.gate}`] : [];
      const mergedTags = [...gateTags, ...explicitTags];
      const seenTags = new Set<string>();
      const dedupedTags = mergedTags.filter((t) => { if (seenTags.has(t)) return false; seenTags.add(t); return true; });
      const tags = dedupedTags.length > 0 ? dedupedTags : undefined;
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/handoff-and-complete`, {
          fromSession: from,
          toSession: opts.to,
          body: opts.body,
          summary: opts.summary,
          transitionNote: opts.note,
          priority: opts.priority,
          tier: opts.tier,
          tags,
          targetRepo: opts.targetRepo,
          nudge: opts.nudge,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("whoami")
    .description("Show the caller's queue position from the daemon's perspective")
    .option("--session <session>", "Caller's session name (defaults to OPENRIG_SESSION_NAME)")
    .option("--recent-limit <n>", "How many recent active qitems to include", "25")
    .option("--json", "JSON output for agents")
    .action(async (opts: { session?: string; recentLimit: string; json?: boolean }) => {
      const session = resolveCurrentSession(opts.session, "session");
      if (!session) return;
      const deps = getDeps();
      const params = new URLSearchParams({
        session,
        recentLimit: opts.recentLimit,
      });
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/whoami?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("fallback <qitemId>")
    .description("Reroute a qitem to a fallback destination (e.g. unreachable seat)")
    .requiredOption("--destination <session>", "Fallback destination seat")
    .option("--reason <text>", "Reason for fallback", "manual")
    .option("--json", "JSON output for agents")
    .action(async (qitemId: string, opts: { destination: string; reason: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/fallback`, {
          fallbackDestination: opts.destination,
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("show <qitemId>")
    .description("Show one qitem (bounded body preview by default; --full for the complete body)")
    .option("--full", "Show the complete body (no preview truncation) + chain fields")
    .option("--json", "JSON output for agents")
    .action(async (qitemId: string, opts: { full?: boolean; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/${encodeURIComponent(qitemId)}`);
        const json = opts.json ?? false;
        const item = res.data;
        // --full is a pure passthrough of today's COMPLETE item shape (the
        // compatibility contract — body byte-identical to pre-0.4.3.03). Also
        // passthrough on error responses / non-object payloads, where there is
        // no string body to preview.
        if (opts.full || res.status >= 400 || !isRecordWithStringBody(item)) {
          printResult(json, item, res.status);
          return;
        }
        const { preview, bodyBytes, bodyTruncated } = previewBody(item.body);
        // Append-only additions: keep `body` in place (now the preview) and add
        // the honest size + truncation flag. Object otherwise unchanged.
        const transformed = { ...item, body: preview, bodyBytes, bodyTruncated };
        printResult(json, transformed, res.status);
        if (!json && bodyTruncated) {
          console.log(`… (truncated — ${bodyBytes} bytes total; --full for complete body)`);
        }
      });
    });

  cmd
    .command("transitions <qitemId>")
    .description("Show the append-only transition log for a qitem")
    .option("--json", "JSON output for agents")
    .action(async (qitemId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/transitions`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("list")
    .description("List qitems (default: active + compact + current-rig; like 'docker ps')")
    .option("-a, --all", "Include closed/done history (like 'docker ps -a')")
    .option("-A, --all-rigs", "Cross-rig breadth (like 'kubectl get --all-namespaces')")
    .option("--full", "Show complete per-item fields (body, chain-of-record)")
    .option("--mine", "Scope to items where you are destination or source")
    .option("-o <format>", "Output format: json")
    .option("--destination <session>", "Filter by destination session")
    .option("--source <session>", "Filter by source session")
    .option("--state <state>", "Filter by state (comma-separated for multiple)")
    .option("--target-repo <name>", "PL-007: filter qitems by target_repo (exact match)")
    .option("--limit <n>", "Result limit", "100")
    .option("--json", "JSON output (compact; use --full --json for complete fields)")
    .addHelpText("after", `
Default: active items in your current rig, compact summary (like 'docker ps').
Current rig is derived from OPENRIG_SESSION_NAME's @<rig> suffix.

Four orthogonal axes (docker/kubectl pattern):
  -a, --all         Include closed/done history (state axis)
  -A, --all-rigs    Cross-rig breadth (scope axis)
  --full            Include body + chain-of-record (field axis)
  -o json            JSON output (compact; --full -o json for complete)

Active states: pending, in-progress, blocked.
History (-a adds): done, canceled, handed-off, failed, denied.
Use --state <states> to select specific states explicitly.

Depth: use 'rig queue show <qitemId>' for a single item in full.
Frontier source: 'rig queue list' is the default status surface.

Examples:
  rig queue list                          Active items in your rig (compact)
  rig queue list -a                       Include closed history in your rig
  rig queue list -A                       Active items across ALL rigs
  rig queue list -a -A                    Everything across all rigs
  rig queue list --full                   Active items with body/chain
  rig queue list -o json                  Compact JSON (same as --json)
  rig queue list --full -o json           Complete JSON (with body/chain)
  rig queue list --mine                   Items where you are source or destination
  rig queue list --state pending          Only pending items in your rig
  rig queue list --full --all --all-rigs  Full firehose (pre-0.4.0 default)`)
    .action(async (opts: {
      all?: boolean;
      allRigs?: boolean;
      full?: boolean;
      mine?: boolean;
      o?: string;
      destination?: string;
      source?: string;
      state?: string;
      targetRepo?: string;
      limit: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      const sessionName = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
      const hasExplicitScope = !!(opts.destination || opts.source);

      if (opts.mine && sessionName) {
        params.set("as", sessionName);
      } else if (!opts.allRigs && !hasExplicitScope) {
        const rigName = sessionName ? extractRigName(sessionName) : undefined;
        if (rigName) {
          params.set("rig", rigName);
        }
      }

      if (!opts.all) {
        params.set("activeOnly", "1");
      }
      if (!opts.full) {
        params.set("compact", "1");
      }
      if (opts.destination) params.set("destinationSession", opts.destination);
      if (opts.source) params.set("sourceSession", opts.source);
      if (opts.state) params.set("state", opts.state);
      if (opts.targetRepo) params.set("targetRepo", opts.targetRepo);
      if (opts.limit) params.set("limit", opts.limit);
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/list?${params.toString()}`);
        const useJson = opts.json || opts.o === "json";
        printResult(useJson, res.data, res.status);
      });
    });

  cmd
    .command("overdue")
    .description("List in-progress qitems past their closure_required_at deadline")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/queue/overdue");
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- Inbox subcommands ----

  cmd
    .command("inbox-drop <destinationSession>")
    .description("Drop a mailbox-style entry into a destination's inbox")
    .requiredOption("--sender <session>", "Sender session")
    .requiredOption("--body <text>", "Inbox body")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--urgency <urgency>", "routine | urgent | critical", "routine")
    .option("--audit <pointer>", "Audit pointer reference")
    .option("--id <inboxId>", "Idempotent inbox_id")
    .option("--json", "JSON output for agents")
    .action(async (destinationSession: string, opts: {
      sender: string;
      body: string;
      tags?: string;
      urgency: string;
      audit?: string;
      id?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      const tags = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/queue/inbox/drop", {
          inboxId: opts.id,
          destinationSession,
          senderSession: opts.sender,
          body: opts.body,
          tags,
          urgency: opts.urgency,
          auditPointer: opts.audit,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("inbox-absorb <inboxId>")
    .description("Absorb a pending inbox entry into the receiver's main queue")
    .requiredOption("--receiver <session>", "Receiver session (must match destination)")
    .option("--json", "JSON output for agents")
    .action(async (inboxId: string, opts: { receiver: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/inbox/${encodeURIComponent(inboxId)}/absorb`, {
          receiverSession: opts.receiver,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("inbox-deny <inboxId>")
    .description("Deny a pending inbox entry with a recorded reason")
    .requiredOption("--receiver <session>", "Receiver session (must match destination)")
    .requiredOption("--reason <text>", "Reason for denial")
    .option("--json", "JSON output for agents")
    .action(async (inboxId: string, opts: { receiver: string; reason: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/inbox/${encodeURIComponent(inboxId)}/deny`, {
          receiverSession: opts.receiver,
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("inbox-pending <destinationSession>")
    .description("List pending inbox entries for a destination seat")
    .option("--json", "JSON output for agents")
    .action(async (destinationSession: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams({ destinationSession });
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/inbox/pending?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- Outbox subcommands ----

  cmd
    .command("outbox-record")
    .description("Record an outbound dispatch in the sender's outbox")
    .requiredOption("--sender <session>", "Sender session")
    .requiredOption("--destination <session>", "Destination session")
    .requiredOption("--body <text>", "Body")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--urgency <urgency>", "routine | urgent | critical", "routine")
    .option("--audit <pointer>", "Audit pointer reference")
    .option("--id <outboxId>", "Idempotent outbox_id")
    .option("--json", "JSON output for agents")
    .action(async (opts: {
      sender: string;
      destination: string;
      body: string;
      tags?: string;
      urgency: string;
      audit?: string;
      id?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      const tags = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/queue/outbox/record", {
          outboxId: opts.id,
          senderSession: opts.sender,
          destinationSession: opts.destination,
          body: opts.body,
          tags,
          urgency: opts.urgency,
          auditPointer: opts.audit,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("outbox-list <senderSession>")
    .description("List outbox entries for a sender seat")
    .option("--limit <n>", "Result limit", "100")
    .option("--json", "JSON output for agents")
    .action(async (senderSession: string, opts: { limit: string; json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams({ senderSession, limit: opts.limit });
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/outbox/list?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
