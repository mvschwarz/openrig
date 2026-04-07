import nodePath from "node:path";
import fs from "node:fs";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { ImportDeps } from "./import.js";

interface DiscoveredSessionLike {
  id: string;
  tmuxSession: string;
}

interface BindingMapping {
  logicalId: string;
  selector: string;
}

interface AdoptBindingResult {
  logicalId: string;
  selector: string;
  sessionName?: string;
  discoveredId?: string;
  ok: boolean;
  error?: string;
}

export interface AdoptDeps extends ImportDeps {}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseBinding(value: string): BindingMapping {
  const splitIndex = value.indexOf("=");
  if (splitIndex <= 0 || splitIndex === value.length - 1) {
    throw new Error(`Invalid --bind mapping "${value}". Use logicalId=tmuxSessionOrDiscoveryId`);
  }
  return {
    logicalId: value.slice(0, splitIndex).trim(),
    selector: value.slice(splitIndex + 1).trim(),
  };
}

function findDiscoveredSession(sessions: DiscoveredSessionLike[], selector: string): DiscoveredSessionLike | undefined {
  return sessions.find((session) => session.id === selector || session.tmuxSession === selector);
}

export function adoptCommand(depsOverride?: AdoptDeps): Command {
  const cmd = new Command("adopt").description("Materialize topology and bind discovered live sessions");
  const getDeps = (): AdoptDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
  };

  cmd
    .argument("<path>", "Path to pod-aware RigSpec or fragment")
    .requiredOption("--bind <logicalId=tmuxSessionOrDiscoveryId>", "Bind a logical node to a discovered tmux session or discovery ID", collectOption, [])
    .option("--target-rig <rigId>", "Target existing rig for additive materialization")
    .option("--rig-root <root>", "Root directory for pod-aware resolution")
    .option("--json", "Output machine-readable JSON")
    .action(async (filePath: string, opts: { bind: string[]; targetRig?: string; rigRoot?: string; json?: boolean }) => {
      const deps = getDeps();

      let yaml: string;
      try {
        yaml = deps.readFile(filePath);
      } catch {
        console.error(`Cannot read file: ${filePath}`);
        process.exitCode = 1;
        return;
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(yaml);
      } catch {
        console.error("Adopt requires a valid pod-aware RigSpec. Fix: validate the YAML and retry.");
        process.exitCode = 1;
        return;
      }
      const podAware = !!parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["pods"]);
      if (!podAware) {
        console.error("Adopt requires a pod-aware RigSpec with pods.");
        process.exitCode = 1;
        return;
      }

      let bindings: BindingMapping[];
      try {
        bindings = opts.bind.map(parseBinding);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error(status.state === "running" ? "Daemon unhealthy — healthz check failed. Restart with: rig daemon start" : "Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));
      const rigRoot = opts.rigRoot ? nodePath.resolve(opts.rigRoot) : nodePath.dirname(nodePath.resolve(filePath));

      const materializeHeaders: Record<string, string> = {
        "X-Rig-Root": rigRoot,
        ...(opts.targetRig ? { "X-Target-Rig-Id": opts.targetRig } : {}),
      };

      const materializeRes = await client.postText<{
        rigId: string;
        specName: string;
        specVersion: string;
        nodes: Array<{ logicalId: string; status: string }>;
      } | { error?: string; message?: string; errors?: string[] }>(
        "/api/rigs/import/materialize",
        yaml,
        "text/yaml",
        materializeHeaders,
      );

      if (materializeRes.status >= 400) {
        const data = materializeRes.data as { error?: string; message?: string; errors?: string[] };
        console.error(data.errors?.join("\n") ?? data.message ?? data.error ?? `Materialize failed (HTTP ${materializeRes.status})`);
        process.exitCode = 1;
        return;
      }

      const materialized = materializeRes.data as {
        rigId: string;
        specName: string;
        specVersion: string;
        nodes: Array<{ logicalId: string; status: string }>;
      };

      const scanRes = await client.post<{ sessions?: Array<Record<string, unknown>>; error?: string }>("/api/discovery/scan", {});
      if (scanRes.status >= 400) {
        console.error(scanRes.data["error"] ?? `Discovery scan failed (HTTP ${scanRes.status})`);
        process.exitCode = 1;
        return;
      }

      const discoveryRes = await client.get<DiscoveredSessionLike[]>("/api/discovery?status=active");
      if (discoveryRes.status >= 400) {
        console.error(`Failed to read discovery inventory (HTTP ${discoveryRes.status}). Run rig discover and retry.`);
        process.exitCode = 1;
        return;
      }

      const activeSessions = Array.isArray(discoveryRes.data) ? discoveryRes.data : [];
      const results: AdoptBindingResult[] = [];

      for (const binding of bindings) {
        const session = findDiscoveredSession(activeSessions, binding.selector);
        if (!session) {
          results.push({
            logicalId: binding.logicalId,
            selector: binding.selector,
            ok: false,
            error: `Session "${binding.selector}" not found in active discovery`,
          });
          continue;
        }

        const bindRes = await client.post<Record<string, unknown>>(`/api/discovery/${encodeURIComponent(session.id)}/bind`, {
          rigId: materialized.rigId,
          logicalId: binding.logicalId,
        });

        if (bindRes.status >= 400) {
          results.push({
            logicalId: binding.logicalId,
            selector: binding.selector,
            sessionName: session.tmuxSession,
            discoveredId: session.id,
            ok: false,
            error: String(bindRes.data["error"] ?? `Bind failed (HTTP ${bindRes.status})`),
          });
          continue;
        }

        results.push({
          logicalId: binding.logicalId,
          selector: binding.selector,
          sessionName: session.tmuxSession,
          discoveredId: session.id,
          ok: true,
        });
      }

      const payload = {
        rigId: materialized.rigId,
        specName: materialized.specName,
        specVersion: materialized.specVersion,
        materializedNodes: materialized.nodes,
        bindings: results,
      };

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Rig adopted: ${materialized.specName} (${materialized.rigId})`);
        for (const node of materialized.nodes) {
          console.log(`  ${node.logicalId}: ${node.status}`);
        }
        for (const result of results) {
          if (result.ok) {
            console.log(`  bind ${result.logicalId} <- ${result.sessionName ?? result.selector}: bound`);
          } else {
            console.error(`  bind ${result.logicalId} <- ${result.selector}: ${result.error}`);
          }
        }
      }

      if (results.some((result) => !result.ok)) {
        if (!opts.json) {
          console.error("Adopt completed with errors. Fix: run rig discover --json, correct the mappings, and retry failed bindings.");
        }
        process.exitCode = 1;
      }
    });

  return cmd;
}
