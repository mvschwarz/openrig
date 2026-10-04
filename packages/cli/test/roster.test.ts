import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichRosterMember, parseRoster, readRosters, rosterCommand, type RosterInventory } from "../src/commands/roster.js";

const member = { seat: "editor@studio", host: "host-a", capabilities: ["colour grading"], engagement: ["consult"], use_when: "Choose a look", why: "Knows the footage", caveat: "Advice only" };
const authored = { version: 1, id: "production", name: "Production", purpose: "Make a film", curator: { seat: "lead@studio", host: "host-a" }, updated_at: "2026-09-01", members: [member] };
const node = { rigId: "r1", logicalId: "editor", canonicalSessionName: member.seat, hostSelfId: member.host, runtime: "claude-code", model: "configured-a", sessionStatus: "running", agentActivity: { state: "idle", sampledAt: "2026-10-01T00:00:00Z" } };
const inventory = (nodes = [node]): RosterInventory => ({ readAt: new Date().toISOString(), nodes, sources: [] });
const folders: string[] = [];
function folder() { const p = mkdtempSync(join(tmpdir(), "roster-test-")); folders.push(p); writeFileSync(join(p, "production.json"), JSON.stringify(authored)); return p; }
afterEach(() => { vi.restoreAllMocks(); for (const p of folders.splice(0)) rmSync(p, { recursive: true, force: true }); process.exitCode = 0; });

it("reads v1 extensions without importing authored live facts", () => {
  const value = parseRoster({ ...authored, depth: { optional: true }, members: [{ ...member, runtime: "invented", model: "invented", live: { observedModel: "invented" } }] });
  expect(value.members).toEqual([member]);
  expect(() => parseRoster({ ...authored, version: 2 })).toThrow("version 1");
});
it("joins exact host self-id and seat, never the caller alias", () => {
  expect(enrichRosterMember(member, inventory()).live).toMatchObject({ status: "reported", runtime: "claude-code", configuredModel: "configured-a", observedModel: null, agentActivity: { sampledAt: node.agentActivity.sampledAt } });
  expect(enrichRosterMember(member, inventory([{ ...node, hostSelfId: "different", hostId: member.host } as typeof node])).live).toMatchObject({ status: "unknown", runtime: null, configuredModel: null });
  expect(enrichRosterMember(member, inventory([{ ...node, canonicalSessionName: "renamed@studio" }])).live.status).toBe("unknown");
});
it("shows offline and conflicting observations honestly; duplicate aliases do not invent conflicts", () => {
  expect(enrichRosterMember(member, inventory([{ ...node, sessionStatus: "stopped" }])).live).toMatchObject({ status: "stale", runtime: null, configuredModel: null });
  expect(enrichRosterMember(member, inventory([node, { ...node, model: "different" }])).live.status).toBe("unknown");
  expect(enrichRosterMember(member, inventory([node, { ...node }])).live.status).toBe("reported");
});
it("keeps valid rosters while exposing unreadable files and duplicate IDs", async () => {
  const p = folder(); writeFileSync(join(p, "broken.json"), "{"); writeFileSync(join(p, "duplicate.json"), JSON.stringify(authored));
  const read = readRosters(p); expect(read.rosters).toHaveLength(2); expect(read.warnings[0]).toContain("broken.json");
  const logs = vi.spyOn(console, "log").mockImplementation(() => {}), io = vi.fn(async () => inventory());
  await new Command().addCommand(rosterCommand({ folder: () => p, inventory: io })).parseAsync(["roster", "show", "production", "--json"], { from: "user" });
  expect(JSON.parse(logs.mock.calls[0]![0]).error).toContain("Ambiguous"); expect(io).not.toHaveBeenCalled();
});
it("list is file-only; find retains distinct recommendations and reads fresh inventory", async () => {
  const p = folder(); writeFileSync(join(p, "operations.json"), JSON.stringify({ ...authored, id: "operations", purpose: "Operate hosts", members: [{ ...member, capabilities: ["host operations"], why: "Knows the machines" }] }));
  const io = vi.fn(async () => inventory()), logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const run = async (args: string[]) => { await new Command().addCommand(rosterCommand({ folder: () => p, inventory: io })).parseAsync(["roster", ...args, "--json"], { from: "user" }); return JSON.parse(logs.mock.calls.at(-1)![0]); };
  expect((await run(["list"])).rosters).toHaveLength(2); expect(io).not.toHaveBeenCalled();
  const first = await run(["find", member.seat]); expect(first.matches).toHaveLength(2); expect(first.matches.map((m: any) => m.why).sort()).toEqual(["Knows the footage", "Knows the machines"]);
  io.mockResolvedValue(inventory([{ ...node, model: "configured-b", runtime: "codex" }]));
  const next = await run(["find", "colour"]); expect(next.matches[0].live).toMatchObject({ runtime: "codex", configuredModel: "configured-b", observedModel: null }); expect(io).toHaveBeenCalledTimes(2);
  const shown = await run(["show", "production"]); expect(shown.roster.members[0].caveat).toBe("Advice only");
});
it("preserves fan-out gaps in JSON and text, without claiming availability", async () => {
  const p = folder(), unavailable = { readAt: "now", nodes: [], sources: [{ scope: "registered-hosts", status: "partial", hosts: [{ hostId: "alias", status: "unreachable" }], warning: "one host unavailable" }] };
  const logs = vi.spyOn(console, "log").mockImplementation(() => {}), errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await new Command().addCommand(rosterCommand({ folder: () => p, inventory: async () => unavailable })).parseAsync(["roster", "show", "production", "--json"], { from: "user" });
  const result = JSON.parse(logs.mock.calls[0]![0]); expect(result.roster.members[0].live.status).toBe("unknown"); expect(result.observations.sources).toEqual(unavailable.sources);
  await new Command().addCommand(rosterCommand({ folder: () => p, inventory: async () => unavailable })).parseAsync(["roster", "find", "colour"], { from: "user" });
  expect(logs.mock.calls.flat().join("\n")).toContain("observed model unknown"); expect(errors.mock.calls.flat().join("\n")).toContain("one host unavailable");
});
