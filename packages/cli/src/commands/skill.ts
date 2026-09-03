import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import nodePath from "node:path";
import { ConfigStore } from "../config-store.js";
import {
  reconcileSkillLoadout,
  resolveSkillLoadout,
  type SkillRuntime,
} from "@openrig/daemon/skill-loadout";

interface AuditFinding {
  class: string;
  file: string;
  reason: string;
  remediation: string;
}

interface AuditEntry {
  id: string;
  path: string;
  sourceKind: string;
  shadowed: boolean;
  stage: string | null;
  verified: { status: string; date?: string; source?: string };
  contentHash: string;
  state: string;
  owner: string | null;
  sourceRef: string | null;
  findings: AuditFinding[];
}

interface AuditResponse {
  ok: boolean;
  entries: AuditEntry[];
  totalFindings: number;
  mirrorDriftError?: string;
  error?: string;
}

export function skillCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("skill").description("Skill management and audit");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .command("loadout")
    .description("Inspect or reconcile the composed managed skill loadout for one Claude/Codex working directory")
    .requiredOption("--runtime <runtime>", "Target runtime: claude-code or codex")
    .option("--cwd <path>", "Target working directory (default: current directory)")
    .option("--project-root <path>", "Project root whose project.yaml supplies install.skills (default: cwd)")
    .option("--topology <ids>", "Comma-separated topology/profile skill identities")
    .option("--apply", "Apply the reconciled loadout; default is read-only inspection")
    .option("--json", "JSON output")
    .action((opts: {
      runtime: string;
      cwd?: string;
      projectRoot?: string;
      topology?: string;
      apply?: boolean;
      json?: boolean;
    }) => {
      if (opts.runtime !== "claude-code" && opts.runtime !== "codex") {
        console.error("invalid_runtime: --runtime must be claude-code or codex");
        process.exitCode = 1;
        return;
      }
      const runtime = opts.runtime as SkillRuntime;
      const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
      const projectRoot = nodePath.resolve(opts.projectRoot ?? cwd);
      const topologySkills = (opts.topology ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const catalogRoot = String(new ConfigStore().resolveWithSource("skills.root").value);
      const resolved = resolveSkillLoadout({ catalogRoot, topologySkills, projectRoot });
      if (!resolved.ok) {
        if (opts.json) console.log(JSON.stringify(resolved, null, 2));
        else for (const error of resolved.errors) console.error(`${error.code}: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      const projection = reconcileSkillLoadout({ loadout: resolved.loadout, runtime, cwd, apply: opts.apply === true });
      if (opts.json) {
        console.log(JSON.stringify({ ...resolved, projection }, null, 2));
      } else {
        console.log(`catalog ${resolved.loadout.catalogRoot} @ ${resolved.loadout.catalogRevision ?? "unused"}`);
        for (const receipt of projection.receipts) {
          console.log(`${receipt.status.padEnd(11)} ${receipt.id} <- ${receipt.selectedBy.join("+")} -> ${receipt.target}`);
          console.log(`  ${receipt.revision} ${receipt.digest} ${receipt.detail}`);
        }
        for (const id of projection.removed) console.log(`removed     ${id} (deselected, owned, unchanged)`);
        if (projection.freshLaunchRequired) {
          console.log("restart     start a fresh seat process before expecting the changed ambient skill set");
        }
        if (resolved.loadout.entries.length === 0 && projection.removed.length === 0) console.log("empty       no managed skills selected");
        if (!opts.apply) console.log("read-only   re-run with --apply to reconcile");
        for (const error of projection.errors) console.error(`${error.code}: ${error.message}`);
      }
      if (!projection.ok) process.exitCode = 1;
    });

  cmd
    .command("audit")
    .description("Read-only skill provenance and freshness audit")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));

      const res = await client.get<AuditResponse>("/api/skills/audit");
      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `Audit failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      const { entries, totalFindings, mirrorDriftError } = res.data;
      const hasFail = totalFindings > 0 || !!mirrorDriftError;

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (hasFail) process.exitCode = 1;
        return;
      }

      const active = entries.filter((e) => !e.shadowed);
      const shadowed = entries.filter((e) => e.shadowed);
      const withFindings = active.filter((e) => e.findings.length > 0);

      console.log(`Skill audit: ${active.length} active, ${shadowed.length} shadowed, ${totalFindings} findings\n`);

      if (withFindings.length > 0) {
        console.log("FINDINGS:");
        for (const entry of withFindings) {
          for (const f of entry.findings) {
            console.log(`  [${f.class}] ${entry.id}`);
            console.log(`    file: ${f.file}`);
            console.log(`    reason: ${f.reason}`);
            console.log(`    fix: ${f.remediation}`);
          }
        }
        console.log("");
      }

      if (mirrorDriftError) {
        console.log(`MIRROR DRIFT CHECK UNAVAILABLE: ${mirrorDriftError}`);
        console.log("");
      }

      if (shadowed.length > 0) {
        console.log("SHADOWED:");
        for (const s of shadowed) {
          console.log(`  ${s.id} at ${s.path} (${s.sourceKind}) -- shadowed by precedence winner`);
        }
        console.log("");
      }

      if (hasFail) {
        const parts: string[] = [];
        if (totalFindings > 0) parts.push(`${totalFindings} finding(s) on active skills`);
        if (mirrorDriftError) parts.push("mirror drift check unavailable");
        console.log(`FAIL: ${parts.join("; ")}`);
        process.exitCode = 1;
      } else {
        console.log("PASS: all active skills have provenance and verified freshness");
      }
    });

  return cmd;
}
