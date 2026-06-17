import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

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
    .command("audit")
    .description("Read-only skill provenance and freshness audit")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }
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
