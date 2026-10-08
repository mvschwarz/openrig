import { Command } from "commander";
import { readFileSync } from "node:fs";
import { DaemonClient } from "../client.js";
import { shellQuote } from "../cross-host-executor.js";
import { readSelectedHost } from "../host-selection.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
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

interface RigSummaryEntry {
  id: string;
  name: string;
}

/**
 * Outcome of resolving a `rig add <rig>` handle (rig name OR id), with the
 * same kinds as `rig down`. Only `resolved`/`passthrough` reach the POST.
 */
type HandleResolution =
  | { kind: "resolved"; id: string; byName: boolean }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "not_found" }
  // Summary unavailable: post the raw handle as today. The members route
  // matches exact ids only, so a name posted this way cannot reach a rig.
  | { kind: "passthrough" };

/**
 * Resolve a `rig add <rig>` handle to the id the add-member route takes.
 * `rig whoami --json` reports the rig by name, so the name must work here too.
 *  - exact id match -> that id;
 *  - exactly one active rig with that name -> its id;
 *  - more than one -> ambiguous: refuse, never pick one;
 *  - no match -> not_found (the raw handle is still posted, so the daemon's
 *    existing rig_not_found answers, or it resolves an id we could not list,
 *    e.g. an archived rig).
 */
async function resolveRigHandle(client: DaemonClient, handle: string): Promise<HandleResolution> {
  let summaries: RigSummaryEntry[];
  try {
    const res = await client.get<RigSummaryEntry[]>("/api/rigs/summary");
    if (res.status !== 200 || !Array.isArray(res.data)) return { kind: "passthrough" };
    summaries = res.data;
  } catch {
    return { kind: "passthrough" };
  }
  if (summaries.some((r) => r.id === handle)) return { kind: "resolved", id: handle, byName: false };
  const nameMatches = summaries.filter((r) => r.name === handle);
  if (nameMatches.length === 1) return { kind: "resolved", id: nameMatches[0]!.id, byName: true };
  if (nameMatches.length > 1) return { kind: "ambiguous", ids: nameMatches.map((r) => r.id) };
  return { kind: "not_found" };
}

/** Quote a shell argument only when it needs it, so plain suggestions stay readable. */
function shellArg(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : shellQuote(s);
}

export function addMemberCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("add").description("Add a member to an existing pod in a running rig")
    .addHelpText("after", `
The rig can be named the way rig whoami --json reports it, or by id. A name that
matches more than one rig is refused; use one of the listed ids instead.

Examples:
  rig add my-rig dev ./reviewer.member.yaml
  rig add 01KXYZ... dev ./reviewer.member.yaml --json`);
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rig>", "Rig name or ID of the target rig")
    .argument("<pod-namespace>", "Namespace of the existing pod to add the member to")
    .argument("<member-fragment-path>", "Path to YAML/JSON member fragment file (spec snake_case fields)")
    .option("--json", "JSON output for agents")
    .option("--rig-root <path>", "Root directory for agent resolution")
    .action(async (rigHandle: string, podNamespace: string, fragmentPath: string, opts: { json?: boolean; rigRoot?: string }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

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

      const refuse = (error: Record<string, unknown> & { message: string }) => {
        if (opts.json) console.log(JSON.stringify({ ok: false, ...error }, null, 2));
        else console.error(error.message);
        process.exitCode = 1;
      };

      // Resolve before the POST: an ambiguous name must stop here, before any
      // mutation, rather than add the member to whichever rig matched first.
      const resolution = await resolveRigHandle(client, rigHandle);

      // rig add has no --host and always targets the local daemon, while a
      // selected remote host makes whoami/ps report THAT host's rigs. A name
      // copied from them must not land on a same-named local rig (every
      // install has a `kernel`). Exact local ids keep working as before.
      const selectedHost = readSelectedHost();
      if (selectedHost !== "local" && (resolution.kind === "ambiguous" || (resolution.kind === "resolved" && resolution.byName))) {
        refuse({
          code: "remote_host_selected",
          message: `Host '${selectedHost}' is selected, but rig add only targets the local daemon, so it does not resolve the rig name '${rigHandle}'. Nothing was added. `
            + "Run rig add on that host, or pass the local rig id (find it with rig ps --json after rig host select local).",
        });
        return;
      }

      if (resolution.kind === "ambiguous") {
        const rigRoot = opts.rigRoot ? ` --rig-root ${shellArg(opts.rigRoot)}` : "";
        const suggestions = resolution.ids.map((id) => `rig add ${id} ${shellArg(podNamespace)} ${shellArg(fragmentPath)}${rigRoot}`);
        refuse({
          code: "rig_ambiguous",
          message: `'${rigHandle}' matches ${resolution.ids.length} rigs. Nothing was added. Re-run with the specific id, e.g. ${suggestions.join("  |  ")}`,
          candidates: resolution.ids,
        });
        return;
      }
      const rigId = resolution.kind === "resolved" ? resolution.id : rigHandle;

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
        if (resolution.kind === "passthrough" && data.code === "rig_not_found") {
          console.error("Could not list rigs to resolve a name. If this is a rig name, pass the rig id instead (rig ps --json).");
        }
        process.exitCode = 1;
        return;
      }

      const node = data.result!.node;
      const icon = node.status === "launched" ? "OK" : "FAIL";
      const session = node.sessionName ? ` (${node.sessionName})` : "";
      const error = node.error ? ` - ${node.error}` : "";
      console.log(`Added member to rig ${rigId === rigHandle ? rigId : `${rigHandle} (${rigId})`}`);
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
