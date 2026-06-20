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
    .option("--priority <priority>", "Priority: routine | urgent | critical", "routine")
    .option("--tier <tier>", "Tier (e.g. fast, routine, deep, critical) — drives SLA")
    .option("--tags <tags>", "Comma-separated tags (composes with --mission and --slice)")
    .option("--expires-at <iso>", "ISO timestamp at which the qitem expires")
    .option("--id <qitemId>", "Idempotent qitem_id (skip if not provided)")
    .option("--target-repo <name>", "PL-007: typed repo scope (must match a repo in the source rig's RigSpec.workspace.repos[])")
    .option("--no-nudge", "Suppress the default destination nudge (cold-queue)")
    .option("--json", "JSON output for agents")
    .action(async (opts: {
      source: string;
      destination: string;
      body?: string;
      bodyFile?: string;
      mission?: string;
      slice?: string;
      priority: string;
      tier?: string;
      tags?: string;
      expiresAt?: string;
      id?: string;
      targetRepo?: string;
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
    .option("--target-repo <name>", "PL-007: typed repo scope for the new qitem")
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
      targetRepo?: string;
      nudge?: boolean;
      json?: boolean;
    }) => {
      const from = resolveCurrentSession(opts.from, "from");
      if (!from) return;
      const deps = getDeps();
      const tags = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/handoff`, {
          fromSession: from,
          toSession: opts.to,
          body: opts.body,
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
    .option("--target-repo <name>", "PL-007: typed repo scope for the new qitem")
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
      targetRepo?: string;
      nudge?: boolean;
      json?: boolean;
    }) => {
      const from = resolveCurrentSession(opts.from, "from");
      if (!from) return;
      const deps = getDeps();
      const tags = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/handoff-and-complete`, {
          fromSession: from,
          toSession: opts.to,
          body: opts.body,
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
    .description("Show one qitem")
    .option("--json", "JSON output for agents")
    .action(async (qitemId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/${encodeURIComponent(qitemId)}`);
        printResult(opts.json ?? false, res.data, res.status);
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
    .description("List qitems (default: caller-scoped compact summary; --all for full fleet)")
    .option("--as <session>", "Scope to items where you are destination or source (default: OPENRIG_SESSION_NAME)")
    .option("--all", "Show all items across all rigs (today's unscoped default)")
    .option("--all-rigs", "Alias for --all")
    .option("--full", "Show complete per-item fields (body, chain-of-record)")
    .option("--destination <session>", "Filter by destination session")
    .option("--source <session>", "Filter by source session")
    .option("--state <state>", "Filter by state (comma-separated for multiple)")
    .option("--target-repo <name>", "PL-007: filter qitems by target_repo (exact match)")
    .option("--limit <n>", "Result limit", "100")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Default: caller-scoped compact summary (items where you are destination or source).
Uses OPENRIG_SESSION_NAME for the caller scope. Use --all for the full fleet view.

Compact fields: qitemId, state, sourceSession, destinationSession, priority, tier,
tags, tsCreated, tsUpdated. Use --full for body, chainOfRecord, and all timestamps.

Use 'rig queue show <qitemId>' to read a single item in full.
Status lives in the queue scoped to you, not fleet-wide dumps.

Examples:
  rig queue list                          Compact summary of your items
  rig queue list --all                    Full fleet view (today's default)
  rig queue list --full                   Your items with complete fields
  rig queue list --all --full             Full fleet, complete fields
  rig queue list --state pending          Your pending items
  rig queue list --as dev1-qa@my-rig      Scope to a different seat`)
    .action(async (opts: {
      as?: string;
      all?: boolean;
      allRigs?: boolean;
      full?: boolean;
      destination?: string;
      source?: string;
      state?: string;
      targetRepo?: string;
      limit: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      const isAll = opts.all || opts.allRigs;
      const hasExplicitScope = !!(opts.as || opts.destination || opts.source);
      const params = new URLSearchParams();

      if (!isAll && !hasExplicitScope) {
        const callerScope = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
        if (callerScope) {
          params.set("as", callerScope);
        }
      }
      if (opts.as) {
        params.set("as", opts.as);
      }
      if (!opts.full && !isAll) {
        params.set("compact", "1");
      }
      if (opts.destination) params.set("destinationSession", opts.destination);
      if (opts.source) params.set("sourceSession", opts.source);
      if (opts.state) params.set("state", opts.state);
      if (opts.targetRepo) params.set("targetRepo", opts.targetRepo);
      if (opts.limit) params.set("limit", opts.limit);
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/list?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
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
