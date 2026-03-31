import nodePath from "node:path";
import { Command } from "commander";
import fs from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface ImportDeps extends StatusDeps {
  readFile: (path: string) => string;
}

export function importCommand(depsOverride?: ImportDeps): Command {
  const cmd = new Command("import").description("Import a rig spec from YAML");
  const getDeps = (): ImportDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };

  cmd
    .argument("<path>", "Path to YAML rig spec file")
    .option("--instantiate", "Instantiate the rig after import")
    .option("--preflight", "Run preflight checks")
    .option("--rig-root <root>", "Root directory for pod-aware resolution")
    .action(async (filePath: string, opts: { instantiate?: boolean; preflight?: boolean; rigRoot?: string }) => {
      const deps = getDeps();

      // Read local file first (before daemon check — fail fast on missing file)
      let yaml: string;
      try {
        yaml = deps.readFile(filePath);
      } catch {
        console.error(`Cannot read file: ${filePath}`);
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        if (status.state === "running" && status.healthy === false) {
          console.error("Daemon unhealthy — healthz check failed. Restart with: rigged daemon start");
        } else {
          console.error("Daemon not running. Start it with: rigged daemon start");
        }
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(`http://127.0.0.1:${status.port}`);

      // Detect pod-aware specs for X-Rig-Root header
      let podAware = false;
      try { const { parse } = await import("yaml"); const parsed = parse(yaml); podAware = !!parsed && Array.isArray(parsed.pods); } catch { /* not parseable — let daemon validate */ }
      const rigRoot = podAware
        ? (opts.rigRoot ? nodePath.resolve(opts.rigRoot) : nodePath.dirname(nodePath.resolve(filePath)))
        : undefined;
      const extraHeaders = rigRoot ? { "X-Rig-Root": rigRoot } : undefined;

      if (opts.preflight) {
        const res = await client.postText<{ ready?: boolean; warnings?: string[]; errors?: string[] }>("/api/rigs/import/preflight", yaml, "text/yaml", extraHeaders);
        if (res.status >= 400) {
          console.error(`Preflight failed (HTTP ${res.status}). Check your spec syntax and rig-root path.`);
          process.exitCode = 1;
          return;
        }
        const data = res.data;
        if (data.errors && data.errors.length > 0) {
          console.error(`Preflight errors:\n${data.errors.map((e) => `  ${e}`).join("\n")}`);
        }
        if (data.warnings && data.warnings.length > 0) {
          console.log(`Preflight warnings:\n${data.warnings.map((w) => `  ${w}`).join("\n")}`);
        }
        if (data.ready) {
          console.log("Preflight passed");
        } else {
          console.error("Preflight not ready. Fix: resolve the errors above and retry.");
          process.exitCode = 1;
        }
        return;
      }

      if (opts.instantiate) {
        const res = await client.postText<{ rigId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }> } | { ok: false; code: string; errors?: string[]; message?: string }>("/api/rigs/import", yaml, "text/yaml", extraHeaders);
        if (res.status === 409 || res.status === 400) {
          const data = res.data as { ok: false; code: string; errors?: string[]; message?: string };
          const detail = data.errors?.join("\n  ") ?? data.message ?? `status ${res.status}`;
          console.error(`Import failed:\n  ${detail}\nFix: check your rig spec and retry. Validate first with: rigged rig validate <path>`);
          process.exitCode = 1;
        } else if (res.status >= 400) {
          console.error(`Import failed (HTTP ${res.status}). Check spec and daemon logs.`);
          process.exitCode = 1;
        } else {
          const data = res.data as { rigId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }> };
          console.log(`Rig created: ${data.specName} (${data.rigId})`);
          for (const n of data.nodes) {
            console.log(`  ${n.logicalId}: ${n.status}`);
          }
        }
        return;
      }

      // Default: validate only
      const res = await client.postText<{ valid?: boolean; errors?: string[] }>("/api/rigs/import/validate", yaml);
      if (res.status >= 400) {
        console.error(`Validation failed: invalid spec (HTTP ${res.status}). Check your YAML syntax and retry.`);
        process.exitCode = 1;
        return;
      }
      const data = res.data;
      if (data.valid) {
        console.log("Valid");
      } else {
        console.error(`Rig spec invalid:\n${(data.errors ?? []).map((e) => `  ${e}`).join("\n")}\nFix: update your spec and re-validate with: rigged rig validate <path>`);
        process.exitCode = 1;
      }
    });

  return cmd;
}
