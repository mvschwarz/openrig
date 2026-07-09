import { Command } from "commander";
import { readOwnHostName, resolveEffectiveHost } from "../host-selection.js";
import { execSync } from "node:child_process";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget, resolveRemoteBearer, classifyHttpFailedStep, classifyHttpError, type HttpHostEntry } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure } from "../cross-host-cli-helpers.js";

interface WhoamiCliOptions {
  nodeId?: string;
  session?: string;
  host?: string;
  allHosts?: boolean;
  hosts?: string;
  json?: boolean;
  full?: boolean;
  verbose?: boolean;
}

export interface WhoamiDeps extends StatusDeps {
  /** Cross-host hooks; mirrors PsDeps/SendDeps shape. Tests inject mocks. */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  crossHostRun?: (
    host: Parameters<typeof runCrossHostCommand>[0],
    argv: readonly string[],
    opts?: RunCrossHostCommandOpts,
  ) => ReturnType<typeof runCrossHostCommand>;
}

interface WhoamiIdentity {
  rigName: string;
  logicalId: string;
  attachmentType: string | null;
  podId: string | null;
  podNamespace?: string | null;
  memberId: string;
  sessionName: string | null;
  runtime: string;
}

interface WhoamiPeer {
  logicalId: string;
  sessionName: string | null;
  runtime: string;
  podNamespace?: string | null;
}

interface WhoamiEdge {
  kind: string;
  to?: { logicalId: string; sessionName: string | null };
  from?: { logicalId: string; sessionName: string | null };
}

interface WhoamiResult {
  resolvedBy: string;
  identity: WhoamiIdentity & Record<string, unknown>;
  peers: WhoamiPeer[];
  edges: { outgoing: WhoamiEdge[]; incoming: WhoamiEdge[] };
  transcript: { enabled: boolean; path: string | null; tailCommand: string | null };
  contextUsage?: {
    availability: string;
    usedPercentage?: number | null;
    remainingPercentage?: number | null;
    contextWindowSize?: number | null;
  };
}

/**
 * OPR.0.4.0.27 — project the full whoami payload to the identity-recovery
 * ALLOWLIST (not a denylist: a future payload field defaults to --full and
 * cannot silently re-bloat the every-boot path). Carries exactly the fields the
 * boot + compaction-restore recovery contract treats as ground truth.
 */
function projectCompactWhoami(data: Record<string, unknown>): Record<string, unknown> {
  const id = (data["identity"] ?? {}) as Record<string, unknown>;
  const peers = Array.isArray(data["peers"]) ? (data["peers"] as unknown[]) : [];
  const transcript = (data["transcript"] ?? {}) as Record<string, unknown>;
  return {
    resolvedBy: data["resolvedBy"],
    identity: {
      rigName: id["rigName"],
      nodeId: id["nodeId"],
      logicalId: id["logicalId"],
      podId: id["podId"],
      podNamespace: id["podNamespace"],
      memberId: id["memberId"],
      sessionName: id["sessionName"],
      runtime: id["runtime"],
    },
    peers: peers.map((p) => {
      const peer = (p ?? {}) as Record<string, unknown>;
      return { logicalId: peer["logicalId"], sessionName: peer["sessionName"], runtime: peer["runtime"] };
    }),
    // KEEP: openrig-user SKILL.md documents peersNote as a required recovery field.
    peersNote: data["peersNote"],
    // edges already carry only kind + to/from {logicalId, sessionName}.
    edges: data["edges"],
    transcript: { path: transcript["path"], tailCommand: transcript["tailCommand"] },
  };
}

type TmuxExecFn = (cmd: string) => string;

const defaultTmuxExec: TmuxExecFn = (cmd: string) => execSync(cmd, { encoding: "utf-8" }).trim();

function buildPartialWhoamiResult(source: { nodeId?: string; sessionName?: string }): Record<string, unknown> {
  return {
    resolvedBy: source.nodeId ? "node_id" : "session_name",
    partial: true,
    daemonReachable: false,
    identity: {
      rigId: null,
      rigName: null,
      nodeId: source.nodeId ?? null,
      logicalId: null,
      attachmentType: null,
      podId: null,
      podNamespace: null,
      podLabel: null,
      memberId: null,
      memberLabel: null,
      sessionName: source.sessionName ?? null,
      runtime: null,
      cwd: null,
      agentRef: null,
      profile: null,
      resolvedSpecName: null,
      resolvedSpecVersion: null,
    },
    peers: [],
    edges: { outgoing: [], incoming: [] },
    transcript: { enabled: false, path: null, tailCommand: null },
  };
}

/**
 * Resolve the current session identity using the approved resolution chain:
 * 1. --node-id flag
 * 2. --session flag
 * 3. OPENRIG_NODE_ID env
 * 4. OPENRIG_SESSION_NAME env
 * 5. TMUX_PANE → @rigged_node_id tmux metadata
 * 6. TMUX_PANE → @rigged_session_name tmux metadata
 * 7. TMUX_PANE → tmux display-message (raw session name)
 * 8. fail
 */
export function resolveIdentitySource(
  opts: { nodeId?: string; session?: string },
  tmuxExec: TmuxExecFn = defaultTmuxExec,
): { nodeId?: string; sessionName?: string } | null {
  if (opts.nodeId) return { nodeId: opts.nodeId };
  if (opts.session) return { sessionName: opts.session };

  const envNodeId = readOpenRigEnv("OPENRIG_NODE_ID", "RIGGED_NODE_ID");
  const envSessionName = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
  if (envNodeId) {
    return {
      nodeId: envNodeId,
      ...(envSessionName ? { sessionName: envSessionName } : {}),
    };
  }
  if (envSessionName) return { sessionName: envSessionName };

  // TMUX_PANE fallback — try OpenRig metadata first, then raw session name
  const tmuxPane = process.env["TMUX_PANE"];
  if (tmuxPane) {
    // Step 5: @rigged_node_id metadata (strongest adopted-session anchor)
    try {
      const nodeId = tmuxExec(`tmux show-option -v -t ${JSON.stringify(tmuxPane)} @rigged_node_id`);
      if (nodeId) return { nodeId };
    } catch { /* metadata not set — continue */ }

    // Step 6: @rigged_session_name metadata
    try {
      const sessionName = tmuxExec(`tmux show-option -v -t ${JSON.stringify(tmuxPane)} @rigged_session_name`);
      if (sessionName) return { sessionName };
    } catch { /* metadata not set — continue */ }

    // Step 7: raw tmux session name (weakest fallback)
    try {
      const sessionName = tmuxExec(`tmux display-message -p -t ${JSON.stringify(tmuxPane)} "#{session_name}"`);
      if (sessionName) return { sessionName };
    } catch {
      // tmux not available or pane not found — skip
    }
  }

  return null;
}

export function whoamiCommand(depsOverride?: WhoamiDeps): Command {
  const cmd = new Command("whoami").description("Show current managed identity in an OpenRig topology");
  const getDeps = (): WhoamiDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .option("--node-id <id>", "Resolve by node ID")
    .option("--session <name>", "Resolve by session name")
    .option("--host <id>", "Run on a remote host declared in ~/.openrig/hosts.yaml")
    .option("--all-hosts", "Fan out to all registered HTTP hosts")
    .option("--hosts <ids>", "Fan out to specific hosts (comma-separated)")
    .option("--json", "JSON output for agents (compact identity-recovery projection by default)")
    .option("--full", "Show the complete whoami payload (contextUsage, commands, runtimeContext, workspace, all sub-fields)")
    .option("--verbose", "Alias for --full")
    .addHelpText("after", `
By default rig whoami is COMPACT: identity (rig/pod/member/session/runtime),
peers (with sessionName for 'rig send'), edges, and the transcript path — the
boot + compaction-restore recovery essentials. Use --full / --verbose for the
complete payload (contextUsage, command examples, runtime token detail,
workspace block). The compact form omits the Context line; use 'rig context' or
'rig whoami --full' for usage.`)
    .action(async (opts: WhoamiCliOptions) => {
      // OPR.0.4.6.MH1 FR-2: selected-host routing — explicit --host wins;
      // else the persisted selection feeds the SHIPPED --host path; no
      // selection = today exactly.
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDeps();
      const full = Boolean(opts.full || opts.verbose);

      if (opts.allHosts || opts.hosts) {
        await runFanOutWhoami(opts, deps);
        return;
      }

      if (opts.host) {
        await runCrossHostWhoami(opts.host, opts, deps);
        return;
      }

      const source = resolveIdentitySource(opts);
      if (!source) {
        console.error("Cannot determine identity. Run inside an OpenRig-managed session, or use --session or --node-id.");
        process.exitCode = 1;
        return;
      }
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        const partial = buildPartialWhoamiResult(source);
        if (opts.json) {
          console.log(JSON.stringify(partial, null, 2));
          return;
        }
        const identity = partial.identity as Record<string, string | null>;
        console.log("daemon unreachable — topology and peer info unavailable.");
        console.log(`Node ID:    ${identity.nodeId ?? "—"}`);
        console.log(`Session:    ${identity.sessionName ?? "—"}`);
        console.log(`Resolved:   partial via ${String(partial.resolvedBy).replace(/_/g, " ")}`);
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));
      const params = new URLSearchParams();
      if (source.nodeId) params.set("nodeId", source.nodeId);
      else params.set("sessionName", source.sessionName!);
      const targetRepo = readOpenRigEnv("OPENRIG_TARGET_REPO", "RIGGED_TARGET_REPO");
      if (targetRepo) params.set("targetRepo", targetRepo);
      // Compact by default (the every-boot recovery call); --full opts out so
      // the daemon also skips the contextUsage/runtimeContext compute.
      if (!full) params.set("compact", "1");

      const res = await client.get<Record<string, unknown>>(`/api/whoami?${params.toString()}`);

      if (opts.json) {
        if (full || res.status >= 400) {
          // --full: today's complete payload (parity). Errors: pass through.
          console.log(JSON.stringify(res.data, null, 2));
        } else {
          // Compact default: the identity-recovery ALLOWLIST projection.
          console.log(JSON.stringify(projectCompactWhoami(res.data)));
        }
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status === 404) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? "Session not found in any managed rig. Check: rig ps --nodes");
        process.exitCode = 1;
        return;
      }

      if (res.status === 409) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? "Session is ambiguous. Use --node-id instead.");
        process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `Whoami failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      // Human-readable output
      const data = res.data as unknown as WhoamiResult;
      const id = data.identity;
      // OPR.0.4.6.MH1 FR-4: the own-host name renders here when RENAMED;
      // unnamed (default "localhost") keeps today's output byte-identical.
      const ownHostName = readOwnHostName();
      if (ownHostName !== "localhost") {
        console.log(`Host:       ${ownHostName}`);
      }
      console.log(`Rig:        ${id.rigName}`);
      console.log(`Logical ID: ${id.logicalId}`);
      console.log(`Pod:        ${(id.podNamespace ?? id.podId) ?? "—"} / ${id.memberId}`);
      console.log(`Session:    ${id.sessionName ?? "—"}`);
      console.log(`Runtime:    ${id.runtime}`);
      console.log(`Transport:  ${id.attachmentType === "external_cli" ? "external_cli (outbound only)" : id.attachmentType}`);
      console.log(`Resolved:   via ${data.resolvedBy.replace(/_/g, " ")}`);

      if (data.peers.length > 0) {
        console.log("");
        // OPR.99.0.6.1: name the contract on the header so peers cannot be
        // misread as the edge-subset or as host inventory. Keeps the literal
        // `Peers:` prefix (existing output greps key on it).
        console.log("Peers: (this rig's roster, excluding self — directional edges below; `rig ps --nodes` for inventory incl. self + live state)");
        for (const peer of data.peers) {
          console.log(`  ${peer.logicalId.padEnd(20)} ${(peer.sessionName ?? "—").padEnd(30)} ${peer.runtime}`);
        }
      }

      if (data.edges.outgoing.length > 0 || data.edges.incoming.length > 0) {
        console.log("");
        console.log("Edges:");
        for (const edge of data.edges.outgoing) {
          console.log(`  → ${edge.kind}  ${edge.to?.logicalId ?? "?"}`);
        }
        for (const edge of data.edges.incoming) {
          console.log(`  ← ${edge.kind}  ${edge.from?.logicalId ?? "?"}`);
        }
      }

      if (data.transcript.enabled && data.transcript.tailCommand) {
        console.log("");
        console.log(`Transcript: ${data.transcript.path ?? "enabled"}`);
        console.log(`  ${data.transcript.tailCommand}`);
      }

      // Context usage — OPR.0.4.0.27: shown only in --full (compact omits the
      // contextUsage payload entirely; use 'rig context' or 'rig whoami --full').
      if (full) {
        const ctx = data.contextUsage;
        if (ctx && ctx.availability === "known") {
          console.log(`Context:    ${ctx.usedPercentage}% used (${ctx.remainingPercentage}% remaining, ${ctx.contextWindowSize} window)`);
        } else {
          console.log("Context:    unknown");
        }
      }
    });

  return cmd;
}

async function runCrossHostWhoami(
  hostId: string,
  opts: WhoamiCliOptions,
  deps: WhoamiDeps,
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const runner = deps.crossHostRun ?? runCrossHostCommand;

  const registry = loader();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error, opts.json);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

  if (host.transport === "http") {
    await runHttpWhoami(host as import("../host-registry.js").HttpHostEntry, opts, deps);
    return;
  }

  // SSH path: reconstruct argv.
  const argv: string[] = ["rig", "whoami"];
  if (opts.nodeId !== undefined) argv.push("--node-id", opts.nodeId);
  if (opts.session !== undefined) argv.push("--session", opts.session);
  if (opts.json) argv.push("--json");

  const result = await runner(host, argv);

  if (opts.json) {
    if (result.ok) {
      // Verbatim remote stdout passthrough — the remote `rig whoami --json`
      // already produced the correct JSON envelope; we do NOT double-wrap.
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return;
    }
    emitCrossHostFailure(host.id, hostDisplayTarget(host), result, true);
    return;
  }

  console.log(`[via host=${host.id} (${hostDisplayTarget(host)})]`);
  if (result.ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }
  emitCrossHostFailure(host.id, hostDisplayTarget(host), result, false);
}

async function runHttpWhoami(
  host: HttpHostEntry,
  opts: WhoamiCliOptions,
  deps: WhoamiDeps,
): Promise<void> {
  const bearerResult = resolveRemoteBearer(host);
  if (!bearerResult.ok) {
    emitCrossHostError(host.id, bearerResult.failedStep, bearerResult.error, opts.json);
    process.exitCode = 1;
    return;
  }

  const { classifyHttpFailedStep: classifyStatus } = await import("../host-registry.js");
  const client = deps.clientFactory(host.url);
  const headers = { Authorization: `Bearer ${bearerResult.token}` };

  try {
    const infoRes = await client.get<{ installRoot?: string }>("/api/info", { headers });
    const infoStep = classifyStatus(infoRes.status);
    if (infoStep !== "none") {
      emitCrossHostError(host.id, infoStep, `Remote /api/info returned HTTP ${infoRes.status}`, opts.json);
      process.exitCode = 1;
      return;
    }

    const psRes = await client.get<Array<{ rigId: string; name: string }>>("/api/ps", { headers });
    const psStep = classifyStatus(psRes.status);
    if (psStep !== "none") {
      emitCrossHostError(host.id, psStep, `Remote /api/ps returned HTTP ${psRes.status}`, opts.json);
      process.exitCode = 1;
      return;
    }

    const identity = {
      host: host.id,
      url: host.url,
      installRoot: infoRes.data?.installRoot ?? "unknown",
      rigs: Array.isArray(psRes.data) ? psRes.data.map((r) => ({ id: r.rigId, name: r.name })) : [],
    };

    if (opts.json) {
      console.log(JSON.stringify(identity));
    } else {
      console.log(`Host:     ${identity.host} (${identity.url})`);
      console.log(`Install:  ${identity.installRoot}`);
      console.log(`Rigs:     ${identity.rigs.length > 0 ? identity.rigs.map((r) => r.name).join(", ") : "(none)"}`);
    }
  } catch (err) {
    const failedStep = classifyHttpError(err);
    emitCrossHostError(host.id, failedStep, (err as Error).message, opts.json);
    process.exitCode = 1;
  }
}

async function runFanOutWhoami(opts: WhoamiCliOptions, deps: WhoamiDeps): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    console.error(`Error: ${registry.error}`);
    process.exitCode = 1;
    return;
  }

  const allHosts = registry.registry.hosts;
  let targetIds: string[];
  if (opts.hosts) {
    targetIds = opts.hosts.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = targetIds.filter((id) => !allHosts.some((h) => h.id === id));
    if (unknown.length > 0) {
      console.error(`Error: unknown host ids: ${unknown.join(", ")}`);
      process.exitCode = 1;
      return;
    }
  } else {
    targetIds = allHosts.filter((h) => h.transport === "http").map((h) => h.id);
  }

  interface HostIdentityResult {
    host: string;
    ok: boolean;
    failedStep: string;
    identity?: { url: string; installRoot: string; rigs: Array<{ id: string; name: string }> };
    error?: string;
  }

  const results: HostIdentityResult[] = await Promise.all(
    targetIds.map(async (id): Promise<HostIdentityResult> => {
      const host = allHosts.find((h) => h.id === id);
      if (!host) return { host: id, ok: false, failedStep: "remote-daemon-unreachable", error: `unknown host ${id}` };
      if (host.transport !== "http") {
        return { host: id, ok: false, failedStep: "remote-command-failed", error: `host ${id} uses transport ${host.transport}; whoami fan-out requires http` };
      }
      const httpHost = host as HttpHostEntry;
      const bearerResult = resolveRemoteBearer(httpHost);
      if (!bearerResult.ok) {
        return { host: id, ok: false, failedStep: bearerResult.failedStep, error: bearerResult.error };
      }
      const client = deps.clientFactory(httpHost.url);
      const headers = { Authorization: `Bearer ${bearerResult.token}` };
      try {
        const { classifyHttpFailedStep: classifyStatus } = await import("../host-registry.js");
        const infoRes = await client.get<{ installRoot?: string }>("/api/info", { headers });
        if (classifyStatus(infoRes.status) !== "none") {
          return { host: id, ok: false, failedStep: classifyStatus(infoRes.status), error: `HTTP ${infoRes.status}` };
        }
        const psRes = await client.get<Array<{ rigId: string; name: string }>>("/api/ps", { headers });
        if (classifyStatus(psRes.status) !== "none") {
          return { host: id, ok: false, failedStep: classifyStatus(psRes.status), error: `HTTP ${psRes.status}` };
        }
        return {
          host: id,
          ok: true,
          failedStep: "none",
          identity: {
            url: httpHost.url,
            installRoot: infoRes.data?.installRoot ?? "unknown",
            rigs: Array.isArray(psRes.data) ? psRes.data.map((r) => ({ id: r.rigId, name: r.name })) : [],
          },
        };
      } catch (err) {
        return { host: id, ok: false, failedStep: classifyHttpError(err), error: (err as Error).message };
      }
    }),
  );

  const hasFailure = results.some((r) => !r.ok);

  if (opts.json) {
    console.log(JSON.stringify({ hosts: results }));
  } else {
    for (const r of results) {
      if (r.ok && r.identity) {
        console.log(`\n[host=${r.host}] ${r.identity.url}`);
        console.log(`  Install: ${r.identity.installRoot}`);
        console.log(`  Rigs:    ${r.identity.rigs.length > 0 ? r.identity.rigs.map((g) => g.name).join(", ") : "(none)"}`);
      } else {
        console.log(`\n[host=${r.host}] FAILED (${r.failedStep}): ${r.error}`);
      }
    }
  }

  if (hasFailure) process.exitCode = 3;
}
