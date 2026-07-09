// OPR.0.4.6.02 C3 — the `rig terminal` command family (the TUI-1 opaque verb +
// the operator's terminal-provider-ride entry). Three subcommands, all hitting
// the ONE canonical daemon composer (`/api/terminal/...`):
//
//   rig terminal open <view> [--provider herdr|cmux] [--json]
//   rig terminal views [--json]
//   rig terminal status [--provider herdr|cmux] [--json]
//
// `<view>` resolves daemon-side: a rig name (per-rig derived) | `mission:<id>` |
// `slice:<id>` (derived) | a saved-view id. The result is the ONE shared
// `{ opened, absent, degraded }` partition, carried byte-identically here and
// in the route JSON (arch Q3).
//
// Exit semantics (PRD / arch Q3): a partial open WITH NAMES is a SUCCESS with
// disclosure → exit 0; a ZERO-pane open (nothing tiled: unknown view, provider
// down, every seat absent/degraded) → non-zero. `views`/`status` are always
// exit 0 unless the daemon is unreachable.

import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TerminalDeps extends StatusDeps {}

/** The one shared open-result shape (mirrors the daemon `OpenViewResult`). */
interface OpenViewResult {
  provider: string;
  ok: boolean;
  opened: string[];
  absent: { seat: string; host: string | null; reason: string }[];
  degraded: { seat: string; host: string; reason: string }[];
  pages: number;
  error?: string;
  code?: string;
}

async function withClient<T>(
  deps: TerminalDeps,
  fn: (client: DaemonClient) => Promise<T>,
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

/** Print a plain daemon response (views/status). JSON = compact; human = pretty. */
function printResult(json: boolean, body: unknown, status: number): void {
  console.log(json ? JSON.stringify(body) : JSON.stringify(body, null, 2));
  if (status >= 400) process.exitCode = status >= 500 ? 2 : 1;
}

/** Human-format the honest-partial open result (opened/absent/degraded, each named). */
function humanOpen(r: OpenViewResult): string {
  const lines: string[] = [];
  const tiled = r.opened.length;
  lines.push(
    tiled > 0
      ? `Opened ${tiled} tile(s) in ${r.provider}${r.pages > 1 ? ` across ${r.pages} page(s)` : ""}.`
      : `No tiles opened in ${r.provider}.`,
  );
  if (r.error) lines.push(`  provider: ${r.error}${r.code ? ` (${r.code})` : ""}`);
  for (const seat of r.opened) lines.push(`  ● ${seat}`);
  for (const a of r.absent) lines.push(`  ○ ${a.seat} — absent: ${a.reason}`);
  for (const d of r.degraded) lines.push(`  ▲ ${d.seat} — skipped (${d.host}): ${d.reason}`);
  return lines.join("\n");
}

/** Open exit rule: exit 0 iff at least one pane was tiled (partial-with-names is success). */
function printOpen(json: boolean, r: OpenViewResult, status: number): void {
  if (json) {
    console.log(JSON.stringify(r));
  } else {
    console.log(humanOpen(r));
  }
  // A 4xx/5xx (bad input / unknown view / service down) OR a zero-pane open is a failure.
  if (status >= 400 || r.opened.length === 0) {
    process.exitCode = status >= 500 ? 2 : 1;
  }
}

export function terminalCommand(depsOverride?: TerminalDeps): Command {
  const cmd = new Command("terminal").description(
    "Open OpenRig views (agent terminals) as tiles in a terminal provider (herdr / cmux)",
  );

  const getDeps = (): TerminalDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  cmd
    .command("open")
    .argument("<view>", "a rig name, mission:<id>, slice:<id>, or a saved-view id")
    .description("Open every live agent in the view as an interactive terminal tile")
    .option("--provider <name>", "terminal provider: herdr (default) or cmux (best-effort)")
    .option("--json", "JSON output for agents")
    .action(async (view: string, opts: { provider?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const body = { view, ...(opts.provider ? { provider: opts.provider } : {}) };
        const res = await client.post<OpenViewResult>("/api/terminal/open", body);
        printOpen(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("views")
    .description("List saved views + the rigs openable as derived views")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/terminal/views");
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("status")
    .description("Show terminal provider availability + liveness (doctor)")
    .option("--provider <name>", "restrict to one provider (herdr / cmux)")
    .option("--json", "JSON output for agents")
    .action(async (opts: { provider?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const path = opts.provider
          ? `/api/terminal/status?provider=${encodeURIComponent(opts.provider)}`
          : "/api/terminal/status";
        const res = await client.get<unknown>(path);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
