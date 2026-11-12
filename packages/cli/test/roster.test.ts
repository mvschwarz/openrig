import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { enrichRosterMember, formatCheckIn, parseRoster, readRosters, rosterCommand, type RosterInventory } from "../src/commands/roster.js";

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
it("shows a hosted member's last call only for a roster row on this host; another host's same-named seat is unknown", () => {
  const home = mkdtempSync(join(tmpdir(), "roster-presence-"));
  folders.push(home);
  vi.stubEnv("OPENRIG_HOME", home);
  writeFileSync(join(home, "mcp-http-presence.json"), JSON.stringify({ version: 1, seats: { "bot@team": { grant: "bot", lastCallAt: "2026-10-26T18:00:00.000Z" } } }));
  const local = { ...member, seat: "bot@team", host: "host-a", hosted: true };
  const here = { ...inventory([]), localHostId: "host-a" };
  expect(enrichRosterMember(local, here).live).toMatchObject({ lastCallAt: "2026-10-26T18:00:00.000Z" });
  expect(enrichRosterMember({ ...local, host: "host-b" }, here).live).toMatchObject({ lastCallAt: null });
  expect(enrichRosterMember(local, { ...here, localHostId: null }).live).toMatchObject({ lastCallAt: null });
  vi.unstubAllEnvs();
});

it("keeps an authored hosted flag, refuses one that isn't a boolean, and says a hosted member has no pane", () => {
  const hosted = { ...member, seat: "grok@studio", hosted: true };
  expect(parseRoster({ ...authored, members: [hosted, { ...member, hosted: false }] }).members).toEqual([hosted, member]);
  expect(() => parseRoster({ ...authored, members: [{ ...member, hosted: "yes" }] })).toThrow("hosted: true or false");
  expect(enrichRosterMember(hosted, inventory()).live).toMatchObject({ status: "unknown", reason: expect.stringContaining("hosted member: it has no pane") });
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
  expect(logs.mock.calls.flat().join("\n")).toContain("last observed model UNKNOWN"); expect(errors.mock.calls.flat().join("\n")).toContain("one host unavailable");
});

it.skipIf(process.platform === "win32")("skips a FIFO without blocking or losing regular rosters", async () => {
  const p = folder(); execFileSync("mkfifo", [join(p, "waiting.json")]);
  const source = new URL("../src/commands/roster.ts", import.meta.url).href;
  const script = `import { readRosters } from ${JSON.stringify(source)}; console.log(JSON.stringify(readRosters(process.argv[1])));`;
  // A broken synchronous reader fails within the child bound instead of hanging Vitest.
  const { stdout } = await promisify(execFile)(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, p], { timeout: 10_000 });
  const result = JSON.parse(stdout);
  expect(result.rosters.map((r: { id: string }) => r.id)).toEqual(["production"]);
  expect(result.warnings).toEqual(["waiting.json: Not a regular file; skipped"]);
});

it("reports the occupant's observed model separately from its configured model, retaining host gaps", () => {
  const observation = { status: "observed", model: "claude-opus-example", source: "claude-assistant-response", observedAt: "2026-10-18T23:00:00.000Z", generation: "current", reason: null };
  const sample: RosterInventory = { readAt: "2026-10-18T23:01:00Z", nodes: [{ ...node, modelObservation: observation }], sources: [{ scope: "registered-hosts", status: "partial", error: "offline peer" }] };
  const live = enrichRosterMember(member, sample).live;
  expect(live.configuredModel).toBe("configured-a");
  expect(live.observedModel).toBe("claude-opus-example");
  expect(live).toMatchObject({ modelObservation: observation });
  expect(sample.sources[0]?.status).toBe("partial");
});

it.each(["model", "time", "unknown", "generation"])("r2: preserves registry fields when duplicate routes disagree only on observation %s", kind => {
  const observation = { status: "observed", model: "model-a", source: "codex-turn-context", observedAt: "2026-10-18T23:00:00.000Z", generation: "current", reason: null };
  const other = kind === "model" ? { ...observation, model: "model-b" }
    : kind === "time" ? { ...observation, observedAt: "2026-10-18T23:00:01.000Z" }
    : kind === "generation" ? { ...observation, generation: "replacement" }
    : { status: "unknown", model: null, source: null, observedAt: null, generation: "current", reason: "model-record-unavailable" };
  const sample: RosterInventory = { readAt: "2026-10-18T23:01:00Z", nodes: [{ ...node, modelObservation: observation }, { ...node, modelObservation: other }], sources: [] };
  expect(enrichRosterMember(member, sample).live).toMatchObject({ status: "reported", configuredModel: "configured-a", runtime: "claude-code", sessionStatus: "running", agentActivity: node.agentActivity });
  expect(enrichRosterMember(member, sample).live.observedModel).toBeNull();
  expect(enrichRosterMember(member, sample).live).toMatchObject({ modelObservation: { status: "unknown", reason: "conflicting-observations" } });
});

it("does not choose the first duplicate route when activity observations conflict", () => {
  const idle = { ...node, agentActivity: { state: "idle", sampledAt: "2026-10-01T00:00:00Z" } };
  const working = { ...node, agentActivity: { state: "working", sampledAt: "2026-10-01T00:00:00Z" } };
  for (const nodes of [[idle, working], [working, idle]]) {
    const live = enrichRosterMember(member, { readAt: "2026-10-01T00:00:01Z", nodes, sources: [] }).live;
    expect(live).toMatchObject({ status: "reported", runtime: "claude-code", configuredModel: "configured-a",
      agentActivity: { state: "unknown", reason: "Conflicting activity observations", sampledAt: null } });
  }
  expect(enrichRosterMember(member, { readAt: "2026-10-01T00:00:01Z", nodes: [idle, idle], sources: [] }).live.agentActivity)
    .toEqual({ state: "idle", reason: null, sampledAt: "2026-10-01T00:00:00Z" });
  const later = { ...idle, agentActivity: { ...idle.agentActivity, sampledAt: "2026-10-01T00:00:01Z" } };
  const missing = { ...idle, agentActivity: null };
  for (const nodes of [[idle, later], [later, idle]]) {
    expect(enrichRosterMember(member, { readAt: "2026-10-01T00:00:02Z", nodes, sources: [] }).live.agentActivity)
      .toEqual({ state: "idle", reason: null, sampledAt: "2026-10-01T00:00:01Z" });
  }
  for (const nodes of [[idle, missing], [missing, idle]]) {
    expect(enrichRosterMember(member, { readAt: "2026-10-01T00:00:02Z", nodes, sources: [] }).live.agentActivity)
      .toEqual({ state: "unknown", reason: "Conflicting activity observations", sampledAt: null });
  }
  const unclocked = { ...idle, agentActivity: { ...idle.agentActivity, sampledAt: null } };
  expect(enrichRosterMember(member, { readAt: "2026-10-01T00:00:02Z", nodes: [idle, unclocked], sources: [] }).live.agentActivity)
    .toEqual({ state: "idle", reason: null, sampledAt: null });
});

it("keeps any positive whole check-in cadence; one that can't be used still loads, with its reason and no cadence", () => {
  const hourly = { ...member, seat: "bot@team", hosted: true, check_in_minutes: 60 };
  expect(parseRoster({ ...authored, members: [hourly, { ...hourly, seat: "fast@team", check_in_minutes: 1 }] }).members)
    .toEqual([hourly, { ...hourly, seat: "fast@team", check_in_minutes: 1 }]);
  for (const bad of [{ ...hourly, check_in_minutes: 0 }, { ...hourly, check_in_minutes: 1.5 }, { ...hourly, check_in_minutes: "60" },
    { ...member, check_in_minutes: 60 }]) {
    const [loaded] = parseRoster({ ...authored, members: [bad] }).members;
    expect(loaded).not.toHaveProperty("check_in_minutes");
    expect(loaded!.check_in_problem).toMatch(/check_in_minutes/);
  }
});
it("shows a hosted member's check-in status from this host's daemon; another host's member, or no answer, reads unknown", () => {
  const bot = { ...member, seat: "bot@team", host: "host-a", hosted: true, check_in_minutes: 60 };
  const checkIns = [{ seat: "bot@team", rung: false, status: "check-in-overdue", lastCheckInAt: "2026-11-12T09:00:00.000Z", expectedMinutes: 60, reporter: "openrig-observed" }];
  const here = { ...inventory([]), localHostId: "host-a", checkIns: { hostId: "host-a", members: checkIns } };
  expect(enrichRosterMember(bot, here).live.checkIn).toMatchObject({ status: "check-in-overdue", lastCheckInAt: "2026-11-12T09:00:00.000Z" });
  expect(formatCheckIn(enrichRosterMember(bot, here).live.checkIn!))
    .toBe("overdue: last check-in 2026-11-12T09:00:00.000Z, expected every 60 min; its schedule may be off or waiting for an approval");
  for (const [missing, reason] of [[{ ...here, checkIns: null }, "this host's daemon gave no check-in status"],
    [{ ...here, checkIns: { hostId: "host-b", members: checkIns } }, "it's listed on another host, whose check-ins this host doesn't hold"],
    [{ ...here, checkIns: { hostId: null, members: checkIns } }, "it's listed on another host, whose check-ins this host doesn't hold"],
    [{ ...here, checkIns: { hostId: "host-a", members: [{ ...checkIns[0], status: "invented" }] } }, "this host's daemon gave no status for it"]] as const) {
    expect(enrichRosterMember(bot, missing).live.checkIn).toEqual({ status: "unknown", lastCheckInAt: null, expectedMinutes: 60, onRequest: false, reason });
  }
  // The roster line is the daemon's own sentence for each status.
  expect(formatCheckIn({ status: "unknown", lastCheckInAt: null, expectedMinutes: null, reason: "its check-ins couldn't be read" }))
    .toBe("unknown (its check-ins couldn't be read)");
  expect(formatCheckIn({ status: "no-check-in-yet", lastCheckInAt: null, expectedMinutes: null })).toBe("no check-in yet; no check-in cadence declared");
  expect(formatCheckIn({ status: "no-check-in-yet", lastCheckInAt: null, expectedMinutes: 60 })).toBe("no check-in yet; expected every 60 min");
  expect(formatCheckIn({ status: "on-request", lastCheckInAt: "2026-11-12T09:00:00.000Z", expectedMinutes: null, onRequest: true }))
    .toBe("on request: it checks its queue when a person asks it; last check-in 2026-11-12T09:00:00.000Z");
  expect(formatCheckIn({ status: "invented", lastCheckInAt: null, expectedMinutes: null })).toBe("unknown (its check-in status couldn't be read)");
  expect(enrichRosterMember(member, here).live).not.toHaveProperty("checkIn");
});
it("a team with no terminal seat still shows its members' check-ins: the daemon names its own host with them", () => {
  const bot = { ...member, seat: "bot@team", host: "host-a", hosted: true, check_in_minutes: 60 };
  const fresh = { seat: "bot@team", rung: false, status: "checking-in", lastCheckInAt: "2026-11-12T09:55:00.000Z", expectedMinutes: 60, reporter: "openrig-observed" };
  const noSeats: RosterInventory = { ...inventory([]), localHostId: null, checkIns: { hostId: "host-a", members: [fresh] } };
  expect(enrichRosterMember(bot, noSeats).live.checkIn).toMatchObject({ status: "checking-in", lastCheckInAt: fresh.lastCheckInAt });
});
it("keeps check_in_on_request: true; any other value, both statements at once, or a member not marked hosted loads with its reason", () => {
  const asked = { ...member, seat: "bot@team", hosted: true, check_in_on_request: true };
  expect(parseRoster({ ...authored, members: [asked] }).members).toEqual([asked]);
  for (const [bad, reason] of [[{ ...asked, check_in_on_request: false }, /isn't true/], [{ ...asked, check_in_minutes: 60 }, /both/],
    [{ ...member, check_in_on_request: true }, /connected assistant/]] as const) {
    const [loaded] = parseRoster({ ...authored, members: [bad] }).members;
    expect(loaded).not.toHaveProperty("check_in_on_request");
    expect(loaded).not.toHaveProperty("check_in_minutes");
    expect(loaded!.check_in_problem).toMatch(reason);
  }
});
