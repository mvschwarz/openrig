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
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { openTerminalWindow, type WindowDeps } from "../terminal-window.js";

export interface TerminalDeps extends StatusDeps { windowDeps?: WindowDeps }

/** The one shared open-result shape (mirrors the daemon `OpenViewResult`). */
export interface OpenViewResult {
  provider: string;
  ok: boolean;
  opened: string[];
  absent: { seat: string; host: string | null; reason: string }[];
  degraded: { seat: string; host: string; reason: string }[];
  pages: number;
  error?: string;
  code?: string;
  notes?: string[];
  window?: { app: string; surface: string };
  reusedWorkspace?: { id: string; tabId: string; view: string };
  /** On window failures, false means no desktop launch was attempted. */
  windowAttempted?: boolean;
}

// Opening applies pages through several bounded provider round trips; it is
// an operation, not a read that can share the client's five-second default.
const TERMINAL_OPEN_TIMEOUT_MS = 45_000;

async function withClient<T>(
  deps: TerminalDeps,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (!daemonStatusGuard(status)) return undefined;
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
    r.code === "terminal_window_failed" && r.error
      ? r.error
      : r.ok && r.reusedWorkspace
        ? `Terminal window requested. Reused herdr workspace ${r.reusedWorkspace.id} for view ${JSON.stringify(r.reusedWorkspace.view)}.`
        : tiled > 0
          ? `${r.window ? "Terminal window requested. " : ""}Prepared ${tiled} tile(s) in ${r.provider}${r.pages > 1 ? ` across ${r.pages} page(s)` : ""}.`
          : `No tiles opened in ${r.provider}.`,
  );
  if (r.window) lines.push(`  Terminal: ${r.window.app} (${r.window.surface}).`);
  if (r.error && r.code !== "terminal_window_failed") lines.push(`  provider: ${r.error}${r.code ? ` (${r.code})` : ""}`);
  for (const seat of r.opened) lines.push(`  ● ${seat}`);
  for (const a of r.absent) lines.push(`  ○ ${a.seat} — absent: ${a.reason}`);
  for (const d of r.degraded) lines.push(`  ▲ ${d.seat} — skipped (${d.host}): ${d.reason}`);
  for (const n of r.notes ?? []) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

/** A successful existing-workspace selection also needs no new panes. */
function printOpen(json: boolean, r: OpenViewResult, status: number): void {
  if (json) {
    console.log(JSON.stringify(r));
  } else {
    console.log(humanOpen(r));
  }
  if (status >= 400 || (r.opened.length === 0 && !(r.ok && r.reusedWorkspace))) {
    process.exitCode = status >= 500 ? 2 : 1;
  }
}

export function terminalCommand(depsOverride?: TerminalDeps): Command {
  const cmd = new Command("terminal").description(
    "Open the OpenRig view and agent conversations in terminal tiles",
  ).addHelpText("after", "\nOpenRig view / show me my agents / show me the terminals / see my agents:\n  rig terminal open saved:kernel --window\n  Opens the window itself on the daemon's desktop; an agent can run it from its shell.\n  Uses herdr when installed, otherwise the same layout in plain tmux.\n  Herdr needs a terminal the person can see; TUI navigation does not open one.\n  Over headless SSH, give the exact connection/attach command for a new terminal/tab.\n  Only if the window cannot open: rig tui --shared is the dashboard-only fallback.\n  On a desktop, the agent opens the view; it does not finish by printing a command to copy.\n");

  const getDeps = (): TerminalDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  cmd
    .command("open")
    .argument("<view>", "a rig name, mission:<id>, slice:<id>, or a saved-view id")
    .description("Open a desktop terminal showing the view's live agents as interactive tiles")
    .option("--provider <name>", "herdr or cmux: use an existing workspace without opening a window; tmux requires --window")
    .option("--window", "Open a new desktop terminal tab/window (the default when --provider is omitted)")
    .option("--expected-plan <id>", "Open only if the view still matches this preview")
    .option("--json", "JSON output for agents")
    .action(async (view: string, opts: { provider?: string; json?: boolean; window?: boolean; expectedPlan?: string }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        // Herdr's control socket can answer with no desktop client attached.
        // The default requests a desktop; an explicit provider reuses its workspace.
        if (opts.window || !opts.provider) {
          const result = await openTerminalWindow(client, view, opts.provider, deps.windowDeps, opts.expectedPlan);
          printOpen(opts.json ?? false, result, 200);
          return;
        }
        const body = { view, ...(opts.provider ? { provider: opts.provider } : {}), ...(opts.expectedPlan !== undefined ? { expectedPlan: opts.expectedPlan } : {}) };
        const res = await client.post<OpenViewResult>("/api/terminal/open", body, { timeoutMs: TERMINAL_OPEN_TIMEOUT_MS });
        if (!Array.isArray(res.data?.opened)) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
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
