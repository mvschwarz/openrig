// What a person's assistant sees on an external grant: the team and its members named the way the person knows them,
// a network seat's authored roster entry on its own rig_team entry, no line about the caller's own activity, and an empty
// inbox said in a sentence it can repeat. Internal callers and seats on no roster read as before.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type McpAccess } from "../src/mcp-server.js";
import { DaemonClient, type DaemonResponse } from "../src/client.js";
import { parseRoster, rosterTeamName, teamPhrase } from "../src/commands/roster.js";

const CALLER = "cus-1-caller@team";
const EXTERNAL: McpAccess = { principal: "cus-1", owner: false, rigs: ["team"], roots: [], workspace: false,
  external: { objects: { queue: ["create", "show", "list", "claim", "update"], team: ["list"] } } };
const member = (seat: string, extra: Record<string, unknown> = {}) => ({ seat, host: "host-a", capabilities: ["code review"],
  engagement: ["delegate"], use_when: "A second read", why: "Reads diffs", ...extra });
const roster = (name: string, members: unknown[]) => ({ version: 1, id: "network-team", name, purpose: "The person's team",
  curator: { seat: "lead@team", host: "host-a" }, updated_at: "2026-11-13", members });

const folders: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of folders.splice(0)) fs.rmSync(f, { recursive: true, force: true }); });

function rosters(name: string | null, members: unknown[] = []) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-names-"));
  folders.push(folder);
  if (name !== null) fs.writeFileSync(path.join(folder, "network-team.json"), JSON.stringify(roster(name, members)));
  return folder;
}

async function connect(folder: string, opts: { external?: boolean; seat?: string; queueRows?: unknown[] } = {}) {
  const get = vi.fn(async (p: string): Promise<DaemonResponse> => {
    if (p.startsWith("/api/rigs/summary")) return { status: 200, data: [{ id: "rig-1", name: "team" }] };
    if (p === "/api/rigs/rig-1") return { status: 200, data: { rig: { id: "rig-1", name: "team" }, nodes: [{ id: "n1", logicalId: "dev.review" },
      { id: "n2", logicalId: "dev.impl" }, { id: "n3", logicalId: "dev.lead" }, { id: "n4", logicalId: "dev.idle" }], edges: [], representative: null } };
    // dev.lead's session isn't named after its logical address, and dev.idle has no session yet.
    if (p === "/api/rigs/rig-1/nodes") return { status: 200, data: [
      { logicalId: "dev.review", canonicalSessionName: "dev-review@team", hostSelfId: "host-a", agentActivity: { state: "idle" } },
      { logicalId: "dev.impl", canonicalSessionName: "dev-impl@team", hostSelfId: "host-a", agentActivity: { state: "idle" } },
      { logicalId: "dev.lead", canonicalSessionName: "dev-lead-2@team", hostSelfId: "host-a", agentActivity: { state: "idle" } },
      { logicalId: "dev.idle", canonicalSessionName: null, hostSelfId: "host-a" },
    ] };
    if (p === "/api/queue/hosted-members") return { status: 200, data: { members: [] } };
    if (p.startsWith("/api/queue/list?")) return { status: 200, data: opts.queueRows ?? [] };
    return { status: 404, data: {} };
  });
  const client = new DaemonClient("http://127.0.0.1:9999");
  client.get = get;
  const presence = path.join(folder, "presence.json");
  const server = createMcpServer(client, { rostersFolder: () => folder, presenceFile: () => presence,
    ...(opts.external ? { seat: opts.seat ?? CALLER, access: EXTERNAL } : {}) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "names", version: "1.0.0" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return {
    get,
    team: async () => (await mcp.callTool({ name: "rig_team", arguments: opts.external ? {} : { rigId: "team" } })).structuredContent as Record<string, any>,
    list: async (args: Record<string, unknown> = {}) => await mcp.callTool({ name: "rig_queue_list", arguments: args }) as
      { content: Array<{ text: string }>; structuredContent: Record<string, any> },
    close: async () => { await mcp.close(); await server.close(); },
  };
}

describe("a member's label", () => {
  it("loads a plain label, and a bad one never drops the roster: the member is named by its seat instead", () => {
    const parsed = parseRoster(roster("Sam's team", [
      member("a@team", { label: "claude (Sam's assistant, invited)" }),
      member("b@team", { label: "x".repeat(201) }),
      member("c@team", { label: "line\nbreak" }),
      member("d@team", { label: "<b>bold</b>" }),
      member("e@team", { label: 42 }),
      member("f@team", { label: "é".repeat(200) }),
      // A bidirectional override and a line separator change what's shown; a joiner and a direction mark are ordinary.
      member("g@team", { label: "claude \u202Etnatsissa" }),
      member("h@team", { label: "claude\u2028assistant" }),
      member("i@team", { label: "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u062f" }),
      member("j@team", { label: "\u05e9\u05e8\u05d4\u200f (Sara)" }),
    ])).members;
    expect(parsed.map((m) => m.label ?? null)).toEqual(["claude (Sam's assistant, invited)", null, null, null, null, "é".repeat(200),
      null, null, "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u062f", "\u05e9\u05e8\u05d4\u200f (Sara)"]);
    expect(parsed.map((m) => m.label_problem ?? null)).toEqual([null, expect.stringContaining("longer than 200"),
      expect.stringContaining("control character"), expect.stringContaining("angle bracket"), expect.stringContaining("isn't non-empty text"), null,
      expect.stringContaining("bidirectional control"), expect.stringContaining("separator"), null, null]);
  });

  it("names the team from the rig's network roster, unquoted when its owner hasn't named it", () => {
    expect(rosterTeamName(rosters("Sam's team"), "team")).toEqual({ name: "Sam's team" });
    expect(rosterTeamName(rosters(null), "team")).toEqual({ name: null });
    expect(rosterTeamName(rosters("Sam's team"), "../team")).toEqual({ name: null });
    // A name that can't be shown as authored isn't used, and says why; the roster itself still loads.
    expect(rosterTeamName(rosters("Sam's \u202Emaet"), "team")).toEqual({ name: null, problem: expect.stringContaining("bidirectional control") });
    expect(rosterTeamName(rosters("x".repeat(201)), "team")).toEqual({ name: null, problem: expect.stringContaining("longer than 200") });
    expect(teamPhrase("Sam's team")).toBe('the team "Sam\'s team"');
    expect(teamPhrase("Your OpenRig team")).toBe("your OpenRig team");
    expect(teamPhrase(null)).toBe("your OpenRig team");
  });

  it("refuses the word joiner, the invisible operators and a byte-order mark, and keeps the zero-width space", () => {
    // Each makes a label that looks the same differ. U+200B breaks words in Thai, Khmer and Burmese names, so it stays allowed.
    const thai = "สม​ชาย";
    const parsed = parseRoster(roster("Sam's team", [
      member("a@team", { label: "claude⁠assistant" }),
      member("b@team", { label: "claude⁢assistant" }),
      member("c@team", { label: "claude⁤assistant" }),
      member("d@team", { label: "claude﻿assistant" }),
      member("e@team", { label: thai }),
    ])).members;
    expect(parsed.map((m) => m.label ?? null)).toEqual([null, null, null, null, thai]);
    expect(parsed.map((m) => m.label_problem ?? null)).toEqual([...Array(4).fill(expect.stringContaining("invisible character")), null]);
  });

  it("names the team from the roster that declares the rig as its id when there's no network roster", () => {
    const folder = rosters(null);
    const declared = (file: string, id: string, name: string) =>
      fs.writeFileSync(path.join(folder, file), JSON.stringify({ ...roster(name, []), id }));
    // A starter or factory lead writes `<rig>.json` with the rig as its id; the file's name doesn't decide it.
    declared("sams-team.json", "team", "Sam's team");
    expect(rosterTeamName(folder, "team")).toEqual({ name: "Sam's team" });
    expect(rosterTeamName(folder, "elsewhere")).toEqual({ name: null });
    // When two rosters declare the same rig, the first by file name names it.
    declared("a.json", "pair", "First");
    declared("b.json", "pair", "Second");
    expect(rosterTeamName(folder, "pair")).toEqual({ name: "First" });
    // The declared roster's name follows the label rule.
    declared("c.json", "hidden", "Sam﻿'s team");
    expect(rosterTeamName(folder, "hidden")).toEqual({ name: null, problem: expect.stringContaining("invisible character") });
    // The network roster still comes first, and one that's there but can't be read leaves the team unnamed.
    fs.writeFileSync(path.join(folder, "network-team.json"), JSON.stringify(roster("The network's name", [])));
    expect(rosterTeamName(folder, "team")).toEqual({ name: "The network's name" });
    fs.writeFileSync(path.join(folder, "network-team.json"), "{");
    expect(rosterTeamName(folder, "team")).toEqual({ name: null });
  });
});

describe("rig_team for a person's assistant", () => {
  const named = () => rosters("Sam's team", [
    member("dev-review@team", { label: "codex (Sam's reviewer)", caveat: "Reads, doesn't push" }),
    member("grok@team", { hosted: true, label: "grok (Sam's researcher)" }),
  ]);

  it("names the team and its members, and puts a network seat's roster entry and presence on its own entry", async () => {
    const s = await connect(named(), { external: true });
    try {
      const team = await s.team();
      expect(team.rig).toEqual({ id: "rig-1", name: "team", displayName: "Sam's team" });
      const review = team.seats.find((seat: { session: string }) => seat.session === "dev-review@team");
      expect(review).toMatchObject({ logicalId: "dev.review", label: "codex (Sam's reviewer)", roster: "network-team", capabilities: ["code review"],
        useWhen: "A second read", caveat: "Reads, doesn't push", presence: { lastCallAt: null, lastWake: null, checkIn: { status: "unknown" } } });
      // A seat on no roster is as the daemon reports it.
      const impl = team.seats.find((seat: { session: string }) => seat.session === "dev-impl@team");
      expect(Object.keys(impl).sort()).toEqual(["activity", "delegatesTo", "kind", "logicalId", "pod", "reportsTo", "role", "runtime", "session", "sessionStatus"]);
      expect(team.hostedMembers).toMatchObject([{ session: "grok@team", label: "grok (Sam's researcher)" }]);
    } finally { await s.close(); }
  });

  it("gives an internal caller the answer it had: no display name, no seat entries, no labels", async () => {
    const s = await connect(named());
    try {
      const team = await s.team();
      expect(team.rig).toEqual({ id: "rig-1", name: "team" });
      const plain = ["activity", "delegatesTo", "kind", "logicalId", "pod", "reportsTo", "role", "runtime", "session", "sessionStatus"];
      for (const seat of team.seats) expect(Object.keys(seat).sort()).toEqual(plain);
      expect(team.hostedMembers).toHaveLength(1);
      expect(team.hostedMembers[0]).toMatchObject({ session: "grok@team", activity: "unknown", presence: expect.any(Object) });
      expect(team.hostedMembers[0]).not.toHaveProperty("label");
    } finally { await s.close(); }
  });

  it("says why a label or the team's name isn't shown, so neither reads as absent", async () => {
    const folder = rosters("Sam's \u202Emaet", [
      member("dev-review@team", { label: "codex\u2028reviewer" }),
      member("grok@team", { hosted: true, label: "<b>grok</b>" }),
    ]);
    const s = await connect(folder, { external: true });
    try {
      const team = await s.team();
      expect(team.rig).toEqual({ id: "rig-1", name: "team", displayNameProblem: expect.stringContaining("bidirectional control") });
      const review = team.seats.find((seat: { session: string }) => seat.session === "dev-review@team");
      expect(review).toMatchObject({ label_problem: expect.stringContaining("separator"), roster: "network-team" });
      expect(review).not.toHaveProperty("label");
      expect(team.hostedMembers[0]).toMatchObject({ session: "grok@team", label_problem: expect.stringContaining("angle bracket") });
      expect(team.hostedMembers[0]).not.toHaveProperty("label");
    } finally { await s.close(); }
  });

  it("with nothing authored, reads as before: no display name", async () => {
    const s = await connect(rosters(null));
    try {
      expect((await s.team()).rig).toEqual({ id: "rig-1", name: "team" });
    } finally { await s.close(); }
  });

  it("keeps the caller's own entry, so it sees its address, without a line about its own activity", async () => {
    const folder = rosters("Sam's team", [member(CALLER, { hosted: true, label: "chatgpt (Sam's assistant)" }), member("grok@team", { hosted: true })]);
    const external = await connect(folder, { external: true });
    const internal = await connect(folder);
    try {
      const own = (await external.team()).hostedMembers.find((m: { session: string }) => m.session === CALLER);
      expect(own).toMatchObject({ session: CALLER, label: "chatgpt (Sam's assistant)", capabilities: ["code review"] });
      expect(own).not.toHaveProperty("presence");
      expect(own).not.toHaveProperty("activity");
      expect((await external.team()).hostedMembers.find((m: { session: string }) => m.session === "grok@team")).toHaveProperty("presence");
      // Its own rows aren't even read for it.
      expect(external.get.mock.calls.some(([p]) => p.includes(`destinationSession=${encodeURIComponent(CALLER)}`))).toBe(false);
      // An internal caller sees every member's presence, as before.
      expect((await internal.team()).hostedMembers.find((m: { session: string }) => m.session === CALLER)).toHaveProperty("presence");
    } finally { await external.close(); await internal.close(); }
  });

  // The caller is its seat under either name the roster match uses: its session's name or its logical address.
  it.each([
    ["by its logical address, with a roster entry under its session's name", "dev-lead@team", "dev-lead-2@team"],
    ["by its session's name, with a roster entry under its logical address", "dev-lead-2@team", "dev-lead@team"],
  ])("keeps a node caller's own seat %s, with no line about its activity", async (_label, callerName, rosterSeat) => {
    const s = await connect(rosters("Sam's team", [member(rosterSeat, { label: "claude (Sam's lead)" })]), { external: true, seat: callerName });
    try {
      const own = (await s.team()).seats.find((seat: { logicalId: string }) => seat.logicalId === "dev.lead");
      expect(own).toMatchObject({ session: "dev-lead-2@team", label: "claude (Sam's lead)" });
      for (const key of ["activity", "sessionStatus", "presence"]) expect(own).not.toHaveProperty(key);
      expect(s.get.mock.calls.some(([p]) => /destinationSession=dev-lead/.test(decodeURIComponent(p)))).toBe(false);
    } finally { await s.close(); }
  });

  it("keeps a no-session node caller's own seat by its logical address, its session still null", async () => {
    const s = await connect(rosters("Sam's team"), { external: true, seat: "dev-idle@team" });
    try {
      const own = (await s.team()).seats.find((seat: { logicalId: string }) => seat.logicalId === "dev.idle");
      expect(own).toMatchObject({ logicalId: "dev.idle", session: null });
      for (const key of ["activity", "sessionStatus", "presence"]) expect(own).not.toHaveProperty(key);
    } finally { await s.close(); }
  });

  it("keeps a node caller's own seat, with its identity and label, and no line about its activity", async () => {
    const s = await connect(named(), { external: true, seat: "dev-review@team" });
    try {
      const team = await s.team();
      const own = team.seats.find((seat: { session: string }) => seat.session === "dev-review@team");
      expect(own).toMatchObject({ logicalId: "dev.review", session: "dev-review@team", label: "codex (Sam's reviewer)" });
      for (const key of ["activity", "sessionStatus", "presence"]) expect(own).not.toHaveProperty(key);
      const other = team.seats.find((seat: { session: string }) => seat.session === "dev-impl@team");
      expect(other).toHaveProperty("activity");
    } finally { await s.close(); }
  });
});

describe("rig_queue_list: an empty inbox", () => {
  it("says so in a line the assistant can repeat, naming the team, with the rows' shape unchanged", async () => {
    const named = await connect(rosters("Sam's team"), { external: true });
    const unnamed = await connect(rosters("Your OpenRig team"), { external: true });
    const none = await connect(rosters(null), { external: true });
    try {
      const listed = await named.list({ owned: true });
      expect(listed.structuredContent).toEqual({ items: [], message: 'No open requests are addressed to you on the team "Sam\'s team".' });
      expect(listed.content.map((c) => c.text)).toEqual(["[]", 'No open requests are addressed to you on the team "Sam\'s team".']);
      expect((await named.list()).structuredContent.message).toBe('No open requests are addressed to you on the team "Sam\'s team".');
      expect((await unnamed.list({ owned: true })).structuredContent.message).toBe("No open requests are addressed to you on your OpenRig team.");
      expect((await none.list({ owned: true })).structuredContent.message).toBe("No open requests are addressed to you on your OpenRig team.");
      // A list of every state says none at all, not "open".
      expect((await named.list({ owned: true, all: true })).structuredContent.message).toBe('No requests are addressed to you on the team "Sam\'s team".');
      // A narrowed list that comes back empty isn't an empty inbox.
      expect((await named.list({ owned: true, state: "done" })).structuredContent).toEqual({ items: [] });
    } finally { await named.close(); await unnamed.close(); await none.close(); }
  });

  it("isn't added when there are items, or for an internal caller", async () => {
    const row = { qitemId: "q-1", sourceSession: "dev-impl@team", destinationSession: CALLER, state: "pending" };
    const busy = await connect(rosters("Sam's team"), { external: true, queueRows: [row] });
    const internal = await connect(rosters("Sam's team"));
    try {
      const listed = await busy.list({ owned: true });
      expect(listed.structuredContent).not.toHaveProperty("message");
      expect(listed.structuredContent.items).toHaveLength(1);
      expect(listed.content).toHaveLength(1);
      expect((await internal.list({ destination: CALLER })).structuredContent).toEqual({ items: [] });
    } finally { await busy.close(); await internal.close(); }
  });
});
