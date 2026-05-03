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
    .requiredOption("--body <text>", "Qitem body")
    .option("--priority <priority>", "Priority: routine | urgent | critical", "routine")
    .option("--tier <tier>", "Tier (e.g. fast, routine, deep, critical) — drives SLA")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--expires-at <iso>", "ISO timestamp at which the qitem expires")
    .option("--id <qitemId>", "Idempotent qitem_id (skip if not provided)")
    .option("--no-nudge", "Suppress the default destination nudge (cold-queue)")
    .option("--json", "JSON output for agents")
    .action(async (opts: {
      source: string;
      destination: string;
      body: string;
      priority: string;
      tier?: string;
      tags?: string;
      expiresAt?: string;
      id?: string;
      nudge?: boolean;
      json?: boolean;
    }) => {
      const deps = getDeps();
      const tags = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      await withClient(deps, async (client) => {
        const res = await client.post<Record<string, unknown>>("/api/queue/create", {
          qitemId: opts.id,
          sourceSession: opts.source,
          destinationSession: opts.destination,
          body: opts.body,
          priority: opts.priority,
          tier: opts.tier,
          tags,
          expiresAt: opts.expiresAt,
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
    .description("Mutate qitem state. state=done REQUIRES --closure-reason (one of: handed_off_to, blocked_on, denied, canceled, no-follow-on, escalation)")
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
    .description("List qitems with filters")
    .option("--destination <session>", "Filter by destination session")
    .option("--source <session>", "Filter by source session")
    .option("--state <state>", "Filter by state (comma-separated for multiple)")
    .option("--limit <n>", "Result limit", "100")
    .option("--json", "JSON output for agents")
    .action(async (opts: {
      destination?: string;
      source?: string;
      state?: string;
      limit: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      if (opts.destination) params.set("destinationSession", opts.destination);
      if (opts.source) params.set("sourceSession", opts.source);
      if (opts.state) params.set("state", opts.state);
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
