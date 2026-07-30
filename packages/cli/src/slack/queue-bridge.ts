// Slice-11 slack-connector — fleet access via the `rig` CLI ONLY.
//
// The connector NEVER imports daemon internals; it shells out to `rig queue`
// exactly like the reference relay (which ssh'd `rig queue` to the box). That
// keeps it transport-agnostic (local daemon via OPENRIG_URL, a registered
// remote via `--host`, or an ssh wrapper) and honors the secret-host axis
// (item 10): connector-host may differ from the queue/alert host.
//
// Productization fix over the reference (proven firsthand): reads use `-A`
// (all-rigs), because bare `rig queue list --json` is CURRENT-RIG only and
// silently misses cross-rig human-destined alerts.
import { execFile } from "node:child_process";
import { isHumanSeatSessionRef } from "../session-name.js";

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/** Injectable: run `rig queue <args>` and return the result. */
export type QueueRunner = (args: string[]) => Promise<RunResult>;

/**
 * Default runner: spawn the configured `rig` binary. `env` carries OPENRIG_URL
 * (or nothing, letting rig resolve the local daemon); `baseArgs` can inject
 * `--host <id>` for a registered remote queue. No shell — argv only.
 */
export function makeExecRunner(opts: {
  rigBin: string;
  baseArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): QueueRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        opts.rigBin,
        [...(opts.baseArgs ?? []), ...args],
        { timeout: opts.timeoutMs ?? 30000, env: opts.env ?? process.env, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            code: err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0,
          });
        },
      );
    });
}

export interface QueueItem {
  qitemId: string;
  destinationSession?: string | null;
  sourceSession?: string | null;
  tags?: string[] | null;
  state?: string | null;
  tier?: string | null;
  summary?: string | null;
  body?: string | null;
}

function parseArray(stdout: string): QueueItem[] {
  let j: unknown;
  try {
    j = JSON.parse(stdout);
  } catch {
    throw new Error("queue list: non-JSON output");
  }
  if (Array.isArray(j)) return j as QueueItem[];
  const o = j as { qitems?: QueueItem[]; items?: QueueItem[] };
  return o.qitems ?? o.items ?? [];
}

export interface AlertFilterOpts {
  alertTag: string; // e.g. "founder-alert"
  /** Optional explicit human-seat allow-list; when empty, any human-seat destination or human-gate tier matches. */
  destinations?: string[];
}

/**
 * PURE: select the qitems that should alert a human. A qitem alerts iff it is
 * active, carries the alert tag, AND targets a human — either an explicit
 * configured destination, a human-seat session name, or tier `human-gate`.
 */
export function filterHumanAlerts(items: QueueItem[], opts: AlertFilterOpts): QueueItem[] {
  const active = new Set(["pending", "in-progress", "blocked"]);
  const allow = new Set(opts.destinations ?? []);
  return items.filter((q) => {
    if (q.state && !active.has(q.state)) return false;
    if (!(q.tags ?? []).includes(opts.alertTag)) return false;
    const dest = q.destinationSession ?? "";
    const isHuman = allow.size > 0 ? allow.has(dest) : isHumanSeatSessionRef(dest) || q.tier === "human-gate";
    return isHuman;
  });
}

// Cross-host queue targeting is via OPENRIG_URL on the runner's env (supported
// by ALL queue verbs), NOT `--host` — `queue list`/`queue show` reject `--host`
// (only write/handoff verbs accept it). See makeExecRunner env / config.queueUrl.

// `queue list` defaults to --limit 100 and ALWAYS sends it, so an unbounded read
// silently truncates a large backlog (the B5 defect). Pass an explicit high
// limit so enable-time seeding + outbound see the COMPLETE matching set.
export const QUEUE_LIST_LIMIT = 100000;

/** Read active human alerts across ALL rigs (the -A scope fix) with a full-backlog limit. */
export async function listHumanAlerts(runner: QueueRunner, opts: AlertFilterOpts): Promise<QueueItem[]> {
  const r = await runner(["queue", "list", "-A", "--limit", String(QUEUE_LIST_LIMIT), "--json"]);
  if (!r.ok) throw new Error(`rig queue list failed (code ${r.code}): ${r.stderr.slice(0, 200)}`);
  return filterHumanAlerts(parseArray(r.stdout), opts);
}

/** Full single-item read (list omits/bounds body — item 9 N+1). */
export async function showFull(runner: QueueRunner, qitemId: string): Promise<QueueItem | null> {
  const r = await runner(["queue", "show", qitemId, "--full", "--json"]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout) as QueueItem;
  } catch {
    return null;
  }
}

export interface CreateQitemInput {
  source: string;
  destination: string;
  summary: string;
  body: string;
  priority?: string; // "routine" (default) — NOTE: "normal" is not a shipped value (field lesson)
  tags?: string[];
}

/** Create a qitem (inbound landing). Returns the created qitem id, or throws. */
export async function createQitem(runner: QueueRunner, input: CreateQitemInput): Promise<string> {
  const args = [
    "queue",
    "create",
    "--source",
    input.source,
    "--destination",
    input.destination,
    "--priority",
    input.priority ?? "routine",
    "--tags",
    (input.tags ?? ["founder-slack", "inbound"]).join(","),
    "--summary",
    input.summary,
    "--body",
    input.body,
  ];
  const r = await runner(args);
  if (!r.ok) throw new Error(`rig queue create failed (code ${r.code}): ${r.stderr.slice(0, 200) || r.stdout.slice(0, 200)}`);
  const id = (r.stdout.match(/qitem-[a-z0-9-]+/) ?? [])[0];
  if (!id) throw new Error("rig queue create: no qitem id in output");
  return id;
}
