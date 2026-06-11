import { Command } from "commander";
import { readFileSync } from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface AddMemberResponse {
  ok: boolean;
  result?: {
    podId: string;
    podNamespace: string;
    node: { logicalId: string; nodeId: string; status: string; error?: string; sessionName?: string };
    edges?: Array<{ from: string; to: string; kind: string }>;
    warnings?: string[];
  };
  code?: string;
  message?: string;
  errors?: string[];
  error?: string;
}

export function addMemberCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("add").description("Add a member to an existing pod in a running rig");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rig-id>", "ID of the target rig")
    .argument("<pod-namespace>", "Namespace of the existing pod to add the member to")
    .argument("<member-fragment-path>", "Path to YAML/JSON member fragment file (spec snake_case fields)")
    .option("--json", "JSON output for agents")
    .option("--rig-root <path>", "Root directory for agent resolution")
    .action(async (rigId: string, podNamespace: string, fragmentPath: string, opts: { json?: boolean; rigRoot?: string }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      let fileContent: string;
      try {
        fileContent = readFileSync(fragmentPath, "utf-8");
      } catch {
        console.error(`Cannot read file: ${fragmentPath}`);
        process.exitCode = 1;
        return;
      }

      let member: Record<string, unknown>;
      let edges: unknown;
      try {
        // Dynamic import to avoid bundling yaml at module load (matches expand).
        const { parse } = await import("yaml");
        const parsed = (parse(fileContent) ?? {}) as Record<string, unknown>;
        if (parsed["member"] && typeof parsed["member"] === "object" && !Array.isArray(parsed["member"])) {
          // Wrapper form: { member: {...}, edges?: [...] }.
          member = parsed["member"] as Record<string, unknown>;
          edges = parsed["edges"];
        } else {
          // Bare member form. Lift any top-level `edges:` out as pod-local edges
          // so they are NOT silently dropped (the schema ignores unknown member
          // fields). The rest is the member.
          const { edges: bareEdges, ...rest } = parsed;
          member = rest;
          edges = bareEdges;
        }
      } catch {
        console.error("Invalid YAML/JSON in member fragment file");
        process.exitCode = 1;
        return;
      }

      // A PRESENT-but-non-array edges field is an honest error, never silently
      // omitted (governance FM2 no-silent-drop).
      if (edges !== undefined && edges !== null && !Array.isArray(edges)) {
        console.error("Invalid member fragment: 'edges' must be an array of { from, to, kind }.");
        process.exitCode = 1;
        return;
      }
      const body: Record<string, unknown> = { member };
      if (Array.isArray(edges)) body["edges"] = edges;
      if (opts.rigRoot) body["rigRoot"] = opts.rigRoot;

      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<AddMemberResponse>(
        `/api/rigs/${encodeURIComponent(rigId)}/pods/${encodeURIComponent(podNamespace)}/members`,
        body,
      );
      const data = res.data;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        // Non-zero if the HTTP failed OR the new node did not fully launch.
        if (res.status >= 400 || (data.ok && data.result !== undefined && data.result.node.status !== "launched")) {
          process.exitCode = 1;
        }
        return;
      }

      if (res.status >= 400 || !data.ok) {
        // Honest 3-part error: the daemon's message already says what failed /
        // why / what to do (pod_not_found lists pods; member_conflict suggests a
        // new id); validation/preflight surface the specific field errors.
        const msg = data.message
          ?? (data.errors && data.errors.length > 0 ? data.errors.join("; ") : data.error)
          ?? `Add member failed (HTTP ${res.status})`;
        console.error(msg);
        process.exitCode = 1;
        return;
      }

      const node = data.result!.node;
      const icon = node.status === "launched" ? "OK" : "FAIL";
      const session = node.sessionName ? ` (${node.sessionName})` : "";
      const error = node.error ? ` - ${node.error}` : "";
      console.log(`Added member to rig ${rigId}`);
      console.log(`  Pod: ${data.result!.podNamespace}`);
      console.log(`  Member: [${icon}] ${node.logicalId}${session}${error}`);

      const persistedEdges = data.result!.edges ?? [];
      if (persistedEdges.length > 0) {
        console.log("  Edges:");
        for (const e of persistedEdges) console.log(`    ${e.from} ${e.kind} ${e.to}`);
      }

      if (data.result!.warnings && data.result!.warnings.length > 0) {
        console.log("");
        for (const w of data.result!.warnings) console.log(`  Warning: ${w}`);
      }

      if (node.status !== "launched") {
        process.exitCode = 1;
      }
    });

  return cmd;
}
