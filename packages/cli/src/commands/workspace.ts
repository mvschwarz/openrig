// PL-007 Workspace Primitive — `rig workspace` CLI surface.
//
// Verbs:
//   - `rig workspace validate` (slice-01) — walks a workspace root,
//     parses each .md file's YAML frontmatter, emits a structured gap
//     report. Advisory only — never modifies. curate-steward consumes.
//   - `rig workspace doctor` (slice-21 FR-5) — runs the 7-check
//     workspace-readiness diagnostic against the daemon's resolved
//     workspace (or a --workspace override). Reports state + fix-hints.

import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import * as path from "node:path";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface WorkspaceDeps extends StatusDeps {}

interface ValidationGap {
  filePath: string;
  relativePath: string;
  kind: string;
  field: string | null;
  message: string;
  workspaceKind: string | null;
}

interface ValidationReport {
  root: string;
  workspaceKind: string | null;
  totalFiles: number;
  filesWithFrontmatter: number;
  gapCount: number;
  gaps: ValidationGap[];
}

async function withClient<T>(
  deps: WorkspaceDeps,
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

// release-0.3.2 slice 01 BC repair — strict-int validator for
// --max-files. Rejects `12abc`, `abc`, `0`, `-1`, etc. with a 3-part
// fact/consequence/action error; does NOT call the daemon on invalid
// input. Keeps positive cases (`10000`, `12`, etc.) flowing through.
export function parseMaxFilesStrict(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    const err = new Error(
      `--max-files must be a positive integer (got "${raw}").`,
    ) as Error & { fact: string; consequence: string; action: string };
    err.fact = `--max-files must be a positive integer (got "${raw}").`;
    err.consequence = "rig workspace validate did not run; daemon was not contacted.";
    err.action = "Pass a positive integer like --max-files 10000.";
    throw err;
  }
  return Number.parseInt(raw, 10);
}

function emit3PartError(json: boolean, fact: string, consequence: string, action: string): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { fact, consequence, action } }, null, 2));
  } else {
    process.stderr.write(`Error: ${fact}\n${consequence}\n${action}\n`);
  }
  process.exitCode = 1;
}

export function workspaceCommand(depsOverride?: WorkspaceDeps): Command {
  const cmd = new Command("workspace").description(
    "PL-007 Workspace Primitive — typed-kind tooling. `validate` walks a root and reports frontmatter gaps; `doctor` runs the 7-check workspace-readiness diagnostic.",
  );

  const getDeps = (): WorkspaceDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  cmd
    .command("validate [root]")
    .description(
      "Walk a workspace root, parse each .md file's YAML frontmatter, and emit a structured gap report. Advisory only — never modifies files. Default root: cwd.",
    )
    .option("--kind <kind>", "Workspace kind to validate against: user | project | knowledge | lab | delivery")
    .option("--no-recursive", "Do not descend into subdirectories")
    .option("--require-frontmatter", "Report a gap for every .md file without a frontmatter delimiter")
    .option("--max-files <n>", "Hard cap on .md files walked", "10000")
    .option("--json", "JSON output for agents")
    .action(
      async (
        rootArg: string | undefined,
        opts: {
          kind?: string;
          recursive?: boolean;
          requireFrontmatter?: boolean;
          maxFiles: string;
          json?: boolean;
        },
      ) => {
        // HG-6 — CLI-side validation BEFORE the daemon call. Reject
        // malformed --max-files with a 3-part error; never silently
        // coerce `12abc` → 12.
        let maxFiles: number;
        try {
          maxFiles = parseMaxFilesStrict(opts.maxFiles);
        } catch (err) {
          const e = err as Error & { fact?: string; consequence?: string; action?: string };
          emit3PartError(Boolean(opts.json), e.fact ?? e.message, e.consequence ?? "", e.action ?? "");
          return;
        }
        const root = path.resolve(rootArg ?? process.cwd());
        const deps = getDeps();
        await withClient(deps, async (client) => {
          const res = await client.post<ValidationReport>("/api/workspace/validate", {
            root,
            workspaceKind: opts.kind,
            recursive: opts.recursive !== false,
            requireFrontmatter: opts.requireFrontmatter ?? false,
            maxFiles,
          });
          if (res.status >= 400) {
            console.error(JSON.stringify(res.data, null, 2));
            process.exitCode = 1;
            return;
          }
          const report = res.data;
          if (opts.json) {
            console.log(JSON.stringify(report));
          } else {
            renderHumanReport(report);
          }
          // Exit non-zero when gaps found — operators chain into hygiene fix loops.
          if (report.gapCount > 0) process.exitCode = 1;
        });
      },
    );

  // Slice-21 FR-5 — `rig workspace doctor`.
  cmd
    .command("doctor")
    .description(
      "Run the 7-check workspace-readiness diagnostic against the daemon's resolved workspace. Reports state of workspace root, missions folder, file allowlist, daemon alignment, daemon reload, slice docs, and MISSION_NOTES. Read-only.",
    )
    .option(
      "--workspace <path>",
      "Override the workspace under check (default: daemon-resolved configured root)",
    )
    .option("--json", "JSON output for agents")
    .option(
      "--strict",
      "Exit non-zero on warn-or-fail (default: non-zero only on fail)",
    )
    .action(async (opts: { workspace?: string; json?: boolean; strict?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const requestBody: { workspaceRoot?: string; filesAllowlistOverride?: string } = {};
        if (opts.workspace) requestBody.workspaceRoot = path.resolve(opts.workspace);
        // FR-5e A2 — CLI-side env overlay for files.allowlist. The
        // daemon runs in its own process with its own env; an
        // operator who sets OPENRIG_FILES_ALLOWLIST in their CLI
        // shell expects the doctor result to reflect that override
        // even though the daemon's env is unchanged. We mirror the
        // --workspace override pattern: read the env at request
        // time and forward as a per-request overlay; the daemon
        // route applies it to check #3 with source="env".
        const cliAllowlistEnv = process.env.OPENRIG_FILES_ALLOWLIST;
        if (typeof cliAllowlistEnv === "string" && cliAllowlistEnv.length > 0) {
          requestBody.filesAllowlistOverride = cliAllowlistEnv;
        }
        const res = await client.post<DoctorReport>("/api/workspace/doctor", requestBody);
        if (res.status >= 400) {
          console.error(JSON.stringify(res.data, null, 2));
          process.exitCode = 1;
          return;
        }
        const report = res.data;
        if (opts.json) {
          console.log(JSON.stringify(report));
        } else {
          renderHumanDoctorReport(report);
        }
        // Exit-code semantics per FR-5 IMPL-PRD §74:
        //   default: non-zero only on fail
        //   --strict: non-zero on warn-or-fail
        const hasFail = report.summary.fail > 0;
        const hasWarn = report.summary.warn > 0;
        if (hasFail || (opts.strict && hasWarn)) process.exitCode = 1;
      });
    });

  return cmd;
}

function renderHumanReport(r: ValidationReport): void {
  console.log(`workspace root: ${r.root}`);
  console.log(`workspace kind: ${r.workspaceKind ?? "(none — kind-agnostic structural check)"}`);
  console.log(`files walked:   ${r.totalFiles}`);
  console.log(`with frontmatter: ${r.filesWithFrontmatter}`);
  console.log(`gaps:           ${r.gapCount}`);
  if (r.gapCount === 0) {
    console.log("\n  no gaps — canon is clean against v0 contract.");
    return;
  }
  console.log("\n  Gaps:");
  for (const g of r.gaps) {
    const fieldStr = g.field ? ` [${g.field}]` : "";
    console.log(`    [${g.kind}] ${g.relativePath}${fieldStr}`);
    console.log(`        ${g.message}`);
  }
}

// --- slice-21 FR-5 — `rig workspace doctor` types + human formatter ---
//
// DoctorReport shape mirrors the daemon's runWorkspaceDoctor output
// at packages/daemon/src/domain/workspace/workspace-doctor.ts. Type
// is duplicated here (not imported from the daemon package) because
// the CLI does not have a direct daemon-package dependency edge; the
// HTTP boundary already enforces the JSON shape.

interface DoctorCheckResult {
  check: string;
  status: "ok" | "warn" | "fail";
  message: string;
  fixHint?: string;
  evidence?: Record<string, unknown>;
}

interface DoctorReport {
  workspaceRoot: string;
  checks: DoctorCheckResult[];
  summary: { ok: number; warn: number; fail: number };
  daemonResolvedAt: string;
}

const DOCTOR_CHECK_GROUPS: ReadonlyArray<{ category: string; checks: ReadonlyArray<string> }> = [
  { category: "workspace", checks: ["workspace_root_reachable", "file_allowlist_sane"] },
  { category: "missions", checks: ["missions_folder_present", "optional_slice_docs", "mission_notes_presence"] },
  { category: "daemon", checks: ["daemon_points_at_this_workspace", "daemon_reload_needed"] },
];

function statusIcon(status: DoctorCheckResult["status"]): string {
  switch (status) {
    case "ok": return "OK";
    case "warn": return "WARN";
    case "fail": return "FAIL";
  }
}

export function renderHumanDoctorReport(report: DoctorReport): void {
  console.log(`workspace doctor — ${report.workspaceRoot}`);
  console.log(`  summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail`);
  console.log("");

  const byName = new Map(report.checks.map((c) => [c.check, c]));
  const remaining = new Set(report.checks.map((c) => c.check));

  for (const group of DOCTOR_CHECK_GROUPS) {
    console.log(`${group.category}:`);
    for (const checkName of group.checks) {
      const c = byName.get(checkName);
      if (!c) continue;
      remaining.delete(checkName);
      console.log(`  [${statusIcon(c.status)}] ${c.check}: ${c.message}`);
      if (c.fixHint) console.log(`        Fix: ${c.fixHint}`);
    }
    console.log("");
  }

  // Any checks not in the documented groups still get rendered so a
  // future check addition doesn't silently drop from the human view
  // before the group-map is updated.
  if (remaining.size > 0) {
    console.log("other:");
    for (const checkName of remaining) {
      const c = byName.get(checkName);
      if (!c) continue;
      console.log(`  [${statusIcon(c.status)}] ${c.check}: ${c.message}`);
      if (c.fixHint) console.log(`        Fix: ${c.fixHint}`);
    }
  }
}
