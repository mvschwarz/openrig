import { Command } from "commander";
import fs from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface AgentDeps extends StatusDeps {
  readFile: (path: string) => string;
}

/** Extract a top-level scalar value from YAML text (simple line-based). */
function yamlScalar(text: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = text.match(re);
  return m?.[1]?.replace(/^["']|["']$/g, "").trim();
}

export function agentCommand(depsOverride?: AgentDeps): Command {
  const cmd = new Command("agent").description("Manage agent specs");
  const getDeps = (): AgentDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };

  cmd
    .command("validate <path>")
    .description("Validate an agent spec (agent.yaml)")
    .option("--json", "JSON output")
    .action(async (filePath: string, opts: { json?: boolean }) => {
      const deps = getDeps();

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

      const res = await client.postText<{ valid?: boolean; errors?: string[] }>("/api/agents/validate", yaml);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400 || !res.data.valid) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const data = res.data;
        if (data.errors && data.errors.length > 0) {
          console.error(`Agent spec invalid:\n${data.errors.map((e) => `  ${e}`).join("\n")}\nFix: update ${filePath} and re-validate.`);
        } else {
          console.error(`Validation failed (HTTP ${res.status}). Check agent.yaml syntax.`);
        }
        process.exitCode = 1;
        return;
      }

      const data = res.data;
      if (data.valid) {
        const name = yamlScalar(yaml, "name") ?? "unknown";
        const version = yamlScalar(yaml, "version") ?? "unknown";
        console.log(`Agent spec valid: ${name} v${version}`);
      } else {
        if (data.errors && data.errors.length > 0) {
          console.error(`Agent spec invalid:\n${data.errors.map((e) => `  ${e}`).join("\n")}\nFix: update ${filePath} and re-validate.`);
        }
        process.exitCode = 1;
      }
    });

  return cmd;
}
