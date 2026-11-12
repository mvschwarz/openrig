import nodePath from "node:path";
import { Command } from "commander";
import fs from "node:fs";
import { z } from "zod";
import { DaemonClient, DaemonResponseError, type DaemonResponse } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface ImportDeps extends StatusDeps {
  readFile: (path: string) => string;
}

const LONG_RUNNING_IMPORT_TIMEOUT_MS = 120_000;

const materializeOperation = z.object({
  operationId: z.uuid(), rigId: z.string().nullable(), nodeIds: z.array(z.string().min(1)),
  current: z.object({
    rig: z.object({ id: z.string(), exists: z.boolean(), archivedAt: z.string().nullable() }).nullable(),
    nodes: z.array(z.object({ id: z.string(), exists: z.boolean() })),
  }),
});
const materializeReplay = z.object({ replayed: z.literal(true), operation: materializeOperation });
const materializeResult = z.object({
  rigId: z.string(), specName: z.string(), nodes: z.array(z.object({ logicalId: z.string(), status: z.string() })),
});

function recordedMaterializationMatches(operation: z.infer<typeof materializeOperation>): boolean {
  // Reservations have no rig id; a committed empty pod has a rig id and zero nodes.
  return operation.rigId !== null && operation.rigId.length > 0 && operation.current.rig?.id === operation.rigId &&
    new Set(operation.nodeIds).size === operation.nodeIds.length && operation.current.nodes.length === operation.nodeIds.length &&
    operation.nodeIds.every(id => operation.current.nodes.some(node => node.id === id));
}

function materializationCurrentlyAvailable(operation: z.infer<typeof materializeOperation>): boolean {
  return operation.current.rig?.exists === true && operation.current.rig.archivedAt === null &&
    operation.current.nodes.every(node => node.exists);
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
    .option("--materialize-only", "Create rig topology without launching sessions")
    .option("--operation-id <uuid>", "With --materialize-only: keep this UUID for exact retries")
    .option("--json", "With --materialize-only: print the native JSON receipt")
    .option("--workspace-only", "Apply only the workspace declaration to an existing rig")
    .option("--preflight", "Run preflight checks")
    .option("--target-rig <rigId>", "Target existing rig for materialization or workspace apply")
    .option("--rig-root <root>", "Root directory for pod-aware resolution")
    .option("--cwd <path>", "Override launch/materialization working directory for all members")
    .action(async (filePath: string, opts: { instantiate?: boolean; materializeOnly?: boolean; operationId?: string; json?: boolean; workspaceOnly?: boolean; preflight?: boolean; targetRig?: string; rigRoot?: string; cwd?: string }) => {
      const deps = getDeps();
      if ((opts.operationId !== undefined || opts.json) && (!opts.materializeOnly || opts.instantiate || opts.workspaceOnly || opts.preflight)) {
        console.error("--operation-id and --json require --materialize-only without other import modes.");
        process.exitCode = 1;
        return;
      }
      if (opts.operationId !== undefined && !z.uuid().safeParse(opts.operationId).success) {
        console.error("--operation-id must be an RFC UUID.");
        process.exitCode = 1;
        return;
      }

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
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      // Detect pod-aware specs for X-Rig-Root header
      let podAware = false;
      try { const { parse } = await import("yaml"); const parsed = parse(yaml); podAware = !!parsed && Array.isArray(parsed.pods); } catch { /* not parseable — let daemon validate */ }
      const rigRoot = podAware
        ? (opts.rigRoot ? nodePath.resolve(opts.rigRoot) : nodePath.dirname(nodePath.resolve(filePath)))
        : undefined;
      const cwdOverride = opts.cwd ? nodePath.resolve(opts.cwd) : undefined;
      const extraHeaders = {
        ...(rigRoot ? { "X-Rig-Root": rigRoot } : {}),
        ...(cwdOverride ? { "X-Cwd-Override": cwdOverride } : {}),
      };

      if (opts.instantiate && opts.materializeOnly) {
        console.error("Choose either --instantiate or --materialize-only, not both.");
        process.exitCode = 1;
        return;
      }
      if (opts.workspaceOnly && (opts.instantiate || opts.materializeOnly || opts.preflight)) {
        console.error("--workspace-only cannot be combined with --instantiate, --materialize-only, or --preflight.");
        process.exitCode = 1;
        return;
      }

      if (opts.workspaceOnly) {
        if (!opts.targetRig) {
          console.error("--workspace-only requires --target-rig <rigId>.");
          process.exitCode = 1;
          return;
        }
        const res = await client.postText<
          { rigId: string; changed: boolean; workspace: unknown }
          | { ok: false; code: string; errors?: string[]; message?: string; error?: string }
        >("/api/rigs/import/workspace", yaml, "text/yaml", { "X-Target-Rig-Id": opts.targetRig });
        if (res.status >= 400) {
          const data = res.data as { errors?: string[]; message?: string; error?: string };
          const detail = data.errors?.join("\n  ") ?? data.message ?? data.error ?? `status ${res.status}`;
          console.error(`Workspace apply failed:\n  ${detail}\nFix: update the RigSpec workspace or target rig and retry.`);
          process.exitCode = 1;
          return;
        }
        const data = res.data as { rigId: string; changed: boolean };
        console.log(data.changed
          ? `Workspace applied to rig ${data.rigId}`
          : `Workspace already matches rig ${data.rigId}`);
        return;
      }

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

      if (opts.materializeOnly) {
        if (!podAware) {
          console.error("Materialize-only requires a pod-aware RigSpec with pods.");
          process.exitCode = 1;
          return;
        }
        const headers = {
          ...extraHeaders,
          ...(opts.targetRig ? { "X-Target-Rig-Id": opts.targetRig } : {}),
          ...(opts.operationId !== undefined ? { "X-OpenRig-Operation-Id": opts.operationId } : {}),
        };
        if (opts.operationId !== undefined) {
          let capabilities: DaemonResponse<unknown>;
          try {
            capabilities = await client.get<unknown>("/api/operations/capabilities");
          } catch (error) {
            if (!(error instanceof DaemonResponseError)) throw error;
            console.error("This daemon did not return a readable operation capability response. Nothing was materialized; upgrade the daemon before using --operation-id.");
            process.exitCode = 1;
            return;
          }
          const parsed = z.object({ contract: z.literal("operation-correlation.v1"), kinds: z.array(z.string()) }).safeParse(capabilities.data);
          if (capabilities.status >= 400 || !parsed.success || !parsed.data.kinds.includes("rig.materialize")) {
            console.error("This daemon does not advertise retry-safe materialization. Nothing was materialized; upgrade the daemon before using --operation-id.");
            process.exitCode = 1;
            return;
          }
        }
        const res = await client.postText<unknown>("/api/rigs/import/materialize", yaml, "text/yaml", headers);
        const replay = materializeReplay.safeParse(res.data);
        const fresh = materializeResult.safeParse(res.data);
        const receipt = z.object({ operation: materializeOperation }).safeParse(res.data);
        const confirmed = replay.success ? recordedMaterializationMatches(replay.data.operation) : fresh.success;
        // Fresh results expose logical ids, not native node ids: compare the available count,
        // and require distinct recorded ids with matching current-node evidence, without inventing a mapping.
        const correlated = opts.operationId === undefined || receipt.success && receipt.data.operation.operationId === opts.operationId.toLowerCase() &&
          recordedMaterializationMatches(receipt.data.operation) && (replay.success || fresh.success &&
            receipt.data.operation.rigId === fresh.data.rigId && receipt.data.operation.nodeIds.length === fresh.data.nodes.length);
        const available = !receipt.success || materializationCurrentlyAvailable(receipt.data.operation);
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          if (res.status >= 400 || !confirmed || !correlated || !available) process.exitCode = 1;
          return;
        }
        if (res.status === 409 || res.status === 400 || res.status === 404) {
          const error = z.object({ code: z.string().optional(), errors: z.array(z.string()).optional(), message: z.string().optional(), error: z.string().optional() }).safeParse(res.data);
          const data = error.success ? error.data : {};
          if (data.code === "operation_id_conflict") {
            console.error("Materialize failed: operation_id_conflict.\nReuse this operation ID with the exact original request and options, or use a new operation ID to deliberately start a new operation.");
            process.exitCode = 1;
            return;
          }
          if (data.code === "rig_name_running") {
            console.error(data.error ?? data.message ?? "A rig with this name is already running.");
            process.exitCode = 1;
            return;
          }
          const detail = data.errors?.join("\n  ") ?? data.message ?? data.error ?? `status ${res.status}`;
          console.error(`Materialize failed:\n  ${detail}\nFix: update your spec or target rig and retry.`);
          process.exitCode = 1;
          return;
        }
        if (res.status >= 400) {
          console.error(`Materialize failed (HTTP ${res.status}). Check spec and daemon logs.`);
          process.exitCode = 1;
          return;
        }
        if (!confirmed || !correlated) {
          console.error("Materialization is not confirmed. Inspect the operation receipt; an empty receipt can mean it is still running or failed before creation. Keep the same operation id to inspect it again.");
          process.exitCode = 1;
          return;
        }
        if (!available) {
          console.error("Warning: the recorded rig is archived or resources are missing. The receipt IDs are preserved, but the topology is not currently available.");
          process.exitCode = 1;
        }
        if (replay.success) {
          console.log(`Materialization replay: ${replay.data.operation.rigId}`);
          for (const id of replay.data.operation.nodeIds) console.log(`  Node: ${id}`);
          return;
        }
        if (!fresh.success) return;
        const data = fresh.data;
        console.log(`Rig materialized: ${data.specName} (${data.rigId})`);
        for (const n of data.nodes) {
          console.log(`  ${n.logicalId}: ${n.status}`);
        }
        return;
      }

      if (opts.instantiate) {
        const res = await client.postText<{ rigId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }> } | { ok: false; code: string; errors?: string[]; message?: string; error?: string }>(
          "/api/rigs/import",
          yaml,
          "text/yaml",
          extraHeaders,
          { timeoutMs: LONG_RUNNING_IMPORT_TIMEOUT_MS },
        );
        if (res.status === 409 || res.status === 400) {
          const data = res.data as { ok: false; code: string; errors?: string[]; message?: string; error?: string };
          if (data.code === "rig_name_running") {
            console.error(data.error ?? data.message ?? "A rig with this name is already running.");
            process.exitCode = 1;
            return;
          }
          const detail = data.errors?.join("\n  ") ?? data.message ?? `status ${res.status}`;
          console.error(`Import failed:\n  ${detail}\nFix: check your rig spec and retry. Validate first with: rig spec validate <path>`);
          process.exitCode = 1;
        } else if (res.status >= 400) {
          console.error(`Import failed (HTTP ${res.status}). Check spec and daemon logs.`);
          process.exitCode = 1;
        } else {
          const data = res.data as { rigId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }>; attachCommand?: string; warnings?: string[] };
          console.log(`Rig created: ${data.specName} (${data.rigId})`);
          for (const warning of data.warnings ?? []) console.warn(`Warning: ${warning}`);
          for (const n of data.nodes) {
            console.log(`  ${n.logicalId}: ${n.status}`);
          }
          if (data.attachCommand) {
            console.log(`Attach: ${data.attachCommand}`);
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
        console.error(`Rig spec invalid:\n${(data.errors ?? []).map((e) => `  ${e}`).join("\n")}\nFix: update your spec and re-validate with: rig spec validate <path>`);
        process.exitCode = 1;
      }
    });

  return cmd;
}
