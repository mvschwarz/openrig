import { modelObservation, unknownModelObservation, formatModelObservation } from "../lib/model-observation.js";
import { Command } from "commander";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { ConfigStore } from "../config-store.js";
import { mcpPresenceFilePath, readPresence } from "../mcp-presence.js";
import { parseRoster, readRosters, type Roster, type RosterMember, type RosterWake } from "@openrig/daemon/rosters";

// One roster parser, shared with the daemon (a hosted member's wake route reads the same files).
export { parseRoster, readRosters, type Roster, type RosterMember, type RosterWake };

type Row = Record<string, unknown>;
export interface RosterInventory {
  readAt: string;
  nodes: Row[];
  sources: Row[];
  /** This host's id, from the local daemon's own nodes; null when it has none to read it from. */
  localHostId?: string | null;
}
const object = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v : null;

// Reuse ps's local routing and observation-only HTTP fan-out, including its partial failures.
// Explicit fields keep native transcripts, resume tokens and fresh pane captures out of this read.
const fields = "rigId,logicalId,canonicalSessionName,hostSelfId,runtime,model,modelObservation,sessionStatus,agentActivity";
export async function readRosterInventory(): Promise<RosterInventory> {
  const nodes: Row[] = [], sources: Row[] = [];
  let localHostId: string | null = null;
  for (const remote of [false, true]) {
    const argv = [fileURLToPath(new URL("../index.js", import.meta.url)), "ps", "--no-cleanup", "--nodes", "-A", "--json", "--fields", fields,
      ...(remote ? ["--all-hosts"] : [])];
    const result = await new Promise<{ stdout: string; stderr: string; error: Error | null }>(done => {
      execFile(process.execPath, argv, { env: { ...process.env, OPENRIG_HOST_SELECTED: "local" },
        timeout: 45_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => done({ error, stdout, stderr }));
    });
    const scope = remote ? "registered-hosts" : "configured-daemon";
    try {
      const data: unknown = JSON.parse(result.stdout);
      const entries = Array.isArray(data) ? data : object(data) ? data.entries ?? data.items : null;
      if (!Array.isArray(entries)) throw new Error("ps returned no node array");
      nodes.push(...entries.filter(object));
      if (!remote) localHostId = entries.filter(object).map((n) => text(n.hostSelfId)).find((id) => id !== null) ?? null;
      sources.push({ scope, status: result.error || result.stderr.trim() ? "partial" : "ok",
        ...(object(data) && Array.isArray(data.hosts) ? { hosts: data.hosts } : {}),
        ...(result.stderr.trim() ? { warning: result.stderr.trim() } : {}),
        ...(result.error ? { error: result.error.message } : {}) });
    } catch (error) {
      sources.push({ scope, status: "unavailable", error: result.stderr.trim() || (error as Error).message });
    }
  }
  return { readAt: new Date().toISOString(), nodes, sources, localHostId };
}

export function enrichRosterMember(member: RosterMember, inventory: RosterInventory) {
  const matches = inventory.nodes.filter(n => n.hostSelfId === member.host && n.canonicalSessionName === member.seat);
  // Two aliases can query the same host. Collapse repeated identical identity/configuration,
  // but leave conflicting identities or values ambiguous rather than choosing a route's answer.
  const identities = new Set(matches.map(n => JSON.stringify([n.rigId, n.logicalId, n.runtime, n.model, n.sessionStatus])));
  const node = identities.size === 1 ? matches[0] : undefined;
  const sessionStatus = node ? text(node.sessionStatus) : null;
  const current = sessionStatus === "running";
  const activity = current && object(node?.agentActivity) ? node.agentActivity : null;
  const observations = matches.map(n => modelObservation(n.modelObservation, current));
  const observation = node && new Set(observations.map(o => JSON.stringify(o))).size === 1 ? observations[0]!
    : unknownModelObservation(matches.length ? "conflicting-observations" : "host-or-seat-unavailable");
  return { ...member, live: {
    status: !node ? "unknown" : current ? "reported" : "stale",
    reason: !node ? (matches.length ? "Conflicting node observations"
      : member.hosted ? "A hosted member: it has no pane, and OpenRig doesn't observe it between calls"
        : "No exact hostSelfId and seat match; check observation gaps")
      : current ? "Registry, activity and labelled last model observation; not a promise about the next turn" : "Seat is not reported running; current runtime and model are unknown",
    runtime: current ? text(node?.runtime) : null,
    configuredModel: current ? text(node?.model) : null,
    observedModel: observation.model,
    modelObservation: observation,
    sessionStatus,
    agentActivity: { state: text(activity?.state) ?? "unknown", reason: text(activity?.reason), sampledAt: text(activity?.sampledAt) },
    // A hosted member's last call to this host's MCP server, for a roster row on this host only: another host's member,
    // or one whose host can't be told, is unknown (null), never this host's record for a same-named seat. Its last ring
    // is in rig_team.
    ...(member.hosted ? { lastCallAt: inventory.localHostId && member.host === inventory.localHostId
      ? readPresence(mcpPresenceFilePath())[member.seat]?.lastCallAt ?? null : null } : {}),
  } };
}

type Deps = { folder?: () => string; inventory?: () => Promise<RosterInventory> };
export function rosterCommand(deps: Deps = {}): Command {
  const cmd = new Command("roster").description("Find recommended specialists across rigs and hosts (read-only)");
  cmd.addHelpText("after", "\nRosters are recommendations, not assignments or authority. Contact members through rig send or rig queue.\nFiles: <workspace.root>/rosters/*.json; --folder reads another folder without installing it.\nConfigured model is registry data; last observed model includes its native evidence kind and record time, or UNKNOWN. It does not promise the next turn model.\n");
  for (const verb of ["list", "show", "find"] as const) {
    const sub = cmd.command(verb === "list" ? "list" : `${verb} <${verb === "show" ? "id" : "query"}>`)
      .description(verb === "list" ? "List authored purposes and curators" : verb === "show" ? "Read a roster with current node observations" : "Find a capability or seat across all rosters")
      .option("--folder <path>", "Roster folder (default: workspace.root/rosters)").option("--json", "JSON output");
    sub.action(async (...args: unknown[]) => {
      const query = verb === "list" ? "" : args[0] as string;
      const opts = args[verb === "list" ? 0 : 1] as { folder?: string; json?: boolean };
      const folder = resolve(opts.folder ?? deps.folder?.() ?? join(new ConfigStore().get("workspace.root") as string, "rosters"));
      const { rosters, warnings } = readRosters(folder);
      let result: Row;
      if (verb === "list") {
        result = { folder, rosters: rosters.map(({ members, ...r }) => ({ ...r, memberCount: members.length })), warnings };
      } else {
        const selected = verb === "show" ? rosters.filter(r => r.id === query) : rosters;
        if (verb === "show" && selected.length !== 1) {
          result = { folder, error: selected.length ? `Ambiguous roster id: ${query}` : `Roster not found: ${query}; use rig roster list`, warnings };
          process.exitCode = 1;
        } else {
          const inventory = await (deps.inventory ?? readRosterInventory)();
          const matches = selected.flatMap(r => r.members.filter(m => verb === "show" ||
            [m.seat, ...m.capabilities].some(s => s.toLowerCase().includes(query.toLowerCase())))
            .map(m => ({ roster: { id: r.id, name: r.name, purpose: r.purpose, curator: r.curator }, ...enrichRosterMember(m, inventory) })));
          result = { folder, ...(verb === "show" ? { roster: { ...selected[0], members: matches.map(({ roster: _, ...m }) => m) } } : { query, matches }),
            observations: { readAt: inventory.readAt, sources: inventory.sources }, warnings };
        }
      }
      if (opts.json) console.log(JSON.stringify(result));
      else {
        if (result.error) console.error(result.error);
        else if (verb === "list") for (const r of result.rosters as Array<Roster & { memberCount: number }>)
          console.log(`${r.id} — ${r.purpose}\n  Curator: ${r.curator.seat} (${r.curator.host}); ${r.memberCount} members`);
        else {
          const members = (verb === "show" ? (result.roster as Row).members : result.matches) as Array<ReturnType<typeof enrichRosterMember> & { roster?: { id: string } }>;
          if (verb === "show") { const r = result.roster as Roster; console.log(`${r.name} — ${r.purpose}\nCurator: ${r.curator.seat} (${r.curator.host})`); }
          for (const m of members) console.log(`${m.seat} (${m.host})${m.roster ? ` [${m.roster.id}]` : ""}\n  ${m.engagement.join(", ")}: ${m.capabilities.join(", ")}\n  When: ${m.use_when}\n  Why: ${m.why}${m.caveat ? `\n  Caveat: ${m.caveat}` : ""}\n  ${m.live.status}: runtime ${m.live.runtime ?? "unknown"}; configured model ${m.live.configuredModel ?? "unknown"}; last observed model ${formatModelObservation(m.live.modelObservation)}\n  Activity: ${m.live.agentActivity.state}; sampled ${m.live.agentActivity.sampledAt ?? "unknown"}${m.hosted ? `\n  Last call: ${m.live.lastCallAt ?? "unknown"}` : ""}\n  ${m.live.reason}`);
          if (!members.length) console.log("No matching members.");
          const obs = result.observations as { sources: Row[] };
          for (const source of obs.sources) if (source.status !== "ok") console.error(`Observation gap (${source.scope}): ${source.warning ?? source.error ?? source.status}`);
          console.log("Recommendations only; use rig send or rig queue to contact a member.");
        }
        for (const warning of warnings) console.error(warning);
      }
    });
  }
  return cmd;
}
