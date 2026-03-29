import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function packageCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("package").description("Manage agent packages (legacy)");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      if (status.state === "running" && status.healthy === false) {
        console.error("Daemon unhealthy — healthz failed");
      } else {
        console.error("Daemon not running");
      }
      return null;
    }
    return deps.clientFactory(`http://127.0.0.1:${status.port}`);
  }

  // rigged package validate <path>
  cmd
    .command("validate <path>")
    .description("Validate a package manifest")
    .action(async (sourcePath: string) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<{
        valid: boolean;
        error?: string;
        errors?: string[];
        manifest?: { name: string; version: string; summary: string; runtimes: string[]; exportCounts: Record<string, number> };
      }>("/api/packages/validate", { sourceRef: sourcePath });

      if (res.status >= 400 || !res.data.valid) {
        if (res.data.errors) {
          console.error("Validation errors:");
          for (const e of res.data.errors) {
            console.error(`  - ${e}`);
          }
        } else {
          console.error(res.data.error ?? "Validation failed");
        }
        process.exitCode = 1;
        return;
      }

      const m = res.data.manifest!;
      console.log(`Valid: ${m.name} v${m.version}`);
      console.log(`  ${m.summary}`);
      console.log(`  Runtimes: ${m.runtimes.join(", ")}`);
      const ec = m.exportCounts;
      console.log(`  Exports: skills: ${ec.skills}, guidance: ${ec.guidance}, agents: ${ec.agents}, hooks: ${ec.hooks}, mcp: ${ec.mcp}`);
    });

  // rigged package plan <path>
  cmd
    .command("plan <path>")
    .description("Preview install plan (dry run)")
    .option("--target <dir>", "Target repository root", ".")
    .option("--runtime <runtime>", "Runtime (claude-code or codex)", "claude-code")
    .option("--role <name>", "Role to install")
    .action(async (sourcePath: string, opts: { target: string; runtime: string; role?: string }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<{
        packageName: string;
        packageVersion: string;
        entries: Array<{
          exportType: string;
          exportName: string;
          classification: string;
          targetPath: string;
          deferred: boolean;
          deferReason?: string;
          conflict?: { existingPath: string; reason: string };
        }>;
        actionable: number;
        deferred: number;
        conflicts: number;
        noOps: number;
        error?: string;
        errors?: string[];
      }>("/api/packages/plan", {
        sourceRef: sourcePath,
        targetRoot: opts.target,
        runtime: opts.runtime,
        roleName: opts.role,
      });

      if (res.status >= 400) {
        if (res.data.errors) {
          console.error("Validation errors:");
          for (const e of res.data.errors) {
            console.error(`  - ${e}`);
          }
        } else {
          console.error(res.data.error ?? "Plan failed");
        }
        process.exitCode = 1;
        return;
      }

      console.log(`Plan: ${res.data.packageName} v${res.data.packageVersion}`);
      console.log(`  Actionable: ${res.data.actionable}  Deferred: ${res.data.deferred}  Conflicts: ${res.data.conflicts}  No-ops: ${res.data.noOps}`);

      if (res.data.entries.length > 0) {
        console.log("");
        for (const e of res.data.entries) {
          const suffix = e.conflict ? ` — ${e.conflict.reason}` : e.deferReason ? ` — ${e.deferReason}` : "";
          console.log(`  ${e.exportType.padEnd(12)} ${e.exportName.padEnd(20)} ${e.classification.padEnd(18)} ${e.targetPath || "(deferred)"}${suffix}`);
        }
      }
    });

  // rigged package install <path>
  cmd
    .command("install <path>")
    .description("Install a package")
    .option("--target <dir>", "Target repository root", ".")
    .option("--runtime <runtime>", "Runtime (claude-code or codex)", "claude-code")
    .option("--role <name>", "Role to install")
    .option("--allow-merge", "Allow managed block merges into existing files")
    .action(async (sourcePath: string, opts: { target: string; runtime: string; role?: string; allowMerge?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<{
        installId?: string;
        packageId?: string;
        packageName?: string;
        applied?: Array<{ exportType: string; action: string; targetPath: string; classification: string; status: string }>;
        deferred?: Array<{ exportType: string; exportName: string; deferReason?: string }>;
        conflicts?: Array<{ existingPath: string; reason: string }>;
        verification?: { passed: boolean };
        policyRejected?: Array<{ entry: { exportType: string; exportName: string }; reason: string }>;
        error?: string;
        errors?: string[];
        code?: string;
        rejected?: Array<{ entry: { exportType: string; exportName: string }; reason: string }>;
      }>("/api/packages/install", {
        sourceRef: sourcePath,
        targetRoot: opts.target,
        runtime: opts.runtime,
        roleName: opts.role,
        allowMerge: opts.allowMerge ?? false,
      });

      // 500 → exitCode 2
      if (res.status >= 500) {
        console.error(res.data.error ?? "Install failed");
        process.exitCode = 2;
        return;
      }

      // 400/409/422 → exitCode 1
      if (res.status >= 400) {
        if (res.data.errors) {
          console.error("Validation errors:");
          for (const e of res.data.errors) {
            console.error(`  - ${e}`);
          }
        } else if (res.data.code === "conflict_blocked" && res.data.conflicts) {
          console.error("Unresolved conflicts:");
          for (const c of res.data.conflicts) {
            console.error(`  - ${c.existingPath}: ${c.reason}`);
          }
        } else if (res.data.code === "policy_rejected" && res.data.rejected) {
          console.error("Policy rejected — no entries approved:");
          for (const r of res.data.rejected) {
            console.error(`  - ${r.entry.exportType} ${r.entry.exportName}: ${r.reason}`);
          }
        } else {
          console.error(res.data.error ?? "Install failed");
        }
        process.exitCode = 1;
        return;
      }

      // Success
      console.log(`Installed: ${res.data.packageName} (${res.data.installId})`);

      if (res.data.applied && res.data.applied.length > 0) {
        console.log("Applied:");
        for (const a of res.data.applied) {
          console.log(`  ${a.exportType.padEnd(12)} ${a.action.padEnd(14)} ${a.targetPath}`);
        }
      }

      if (res.data.deferred && res.data.deferred.length > 0) {
        console.log("Deferred:");
        for (const d of res.data.deferred) {
          console.log(`  ${d.exportType.padEnd(12)} ${d.exportName.padEnd(20)} ${d.deferReason ?? ""}`);
        }
      }

      if (res.data.policyRejected && res.data.policyRejected.length > 0) {
        console.log("Policy rejected:");
        for (const r of res.data.policyRejected) {
          console.log(`  ${r.entry.exportType.padEnd(12)} ${r.entry.exportName.padEnd(20)} ${r.reason}`);
        }
      }
    });

  // rigged package rollback <installId>
  cmd
    .command("rollback <installId>")
    .description("Rollback an install")
    .action(async (installId: string) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<{
        installId: string;
        restored: string[];
        deleted: string[];
        error?: string;
      }>(`/api/packages/${encodeURIComponent(installId)}/rollback`);

      if (res.status >= 500) {
        console.error(res.data.error ?? "Rollback failed");
        process.exitCode = 2;
        return;
      }

      if (res.status >= 400) {
        console.error(res.data.error ?? "Rollback failed");
        process.exitCode = 1;
        return;
      }

      console.log(`Rolled back ${res.data.installId}: ${res.data.restored.length} restored, ${res.data.deleted.length} deleted`);
      if (res.data.restored.length > 0) {
        for (const f of res.data.restored) { console.log(`  restored: ${f}`); }
      }
      if (res.data.deleted.length > 0) {
        for (const f of res.data.deleted) { console.log(`  deleted: ${f}`); }
      }
    });

  // rigged package list
  cmd
    .command("list")
    .description("List installed packages")
    .action(async () => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.get<Array<{
        id: string;
        name: string;
        version: string;
        sourceKind: string;
        sourceRef: string;
        summary: string | null;
        createdAt: string;
      }>>("/api/packages");

      if (res.status >= 400) {
        console.error("Failed to list packages");
        process.exitCode = 1;
        return;
      }

      const pkgs = res.data;
      if (pkgs.length === 0) {
        console.log("No packages installed");
        return;
      }

      console.log("Name                 Version    Source                Created");
      for (const p of pkgs) {
        console.log(`${p.name.padEnd(21)} ${p.version.padEnd(11)} ${p.sourceRef.padEnd(22)} ${p.createdAt}`);
      }
    });

  return cmd;
}
