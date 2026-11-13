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

async function connect(folder: string, opts: { external?: boolean; queueRows?: unknown[] } = {}) {
  const get = vi.fn(async (p: string): Promise<DaemonResponse> => {
    if (p.startsWith("/api/rigs/summary")) return { status: 200, data: [{ id: "rig-1", name: "team" }] };
    if (p === "/api/rigs/rig-1") return { status: 200, data: { rig: { id: "rig-1", name: "team" }, nodes: [{ id: "n1", logicalId: "dev.review" }, { id: "n2", logicalId: "dev.impl" }], edges: [], representative: null } };
    if (p === "/api/rigs/rig-1/nodes") return { status: 200, data: [
      { logicalId: "dev.review", canonicalSessionName: "dev-review@team", hostSelfId: "host-a", agentActivity: { state: "idle" } },
      { logicalId: "dev.impl", canonicalSessionName: "dev-impl@team", hostSelfId: "host-a", agentActivity: { state: "idle" } },
    ] };
    if (p === "/api/queue/hosted-members") return { status: 200, data: { members: [] } };
    if (p.startsWith("/api/queue/list?")) return { status: 200, data: opts.queueRows ?? [] };
    return { status: 404, data: {} };
  });
  const client = new DaemonClient("http://127.0.0.1:9999");
  client.get = get;
  const presence = path.join(folder, "presence.json");
  const server = createMcpServer(client, { rostersFolder: () => folder, presenceFile: () => presence,
    ...(opts.external ? { seat: CALLER, access: EXTERNAL } : {}) });
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
    ])).members;
    expect(parsed.map((m) => m.label ?? null)).toEqual(["claude (Sam's assistant, invited)", null, null, null, null, "é".repeat(200)]);
    expect(parsed.map((m) => m.label_problem ?? null)).toEqual([null, expect.stringContaining("longer than 200"),
      expect.stringContaining("control character"), expect.stringContaining("angle bracket"), expect.stringContaining("isn't non-empty text"), null]);
  });

  it("names the team from the rig's network roster, unquoted when its owner hasn't named it", () => {
    expect(rosterTeamName(rosters("Sam's team"), "team")).toBe("Sam's team");
    expect(rosterTeamName(rosters(null), "team")).toBeNull();
    expect(rosterTeamName(rosters("Sam's team"), "../team")).toBeNull();
    expect(teamPhrase("Sam's team")).toBe('the team "Sam\'s team"');
    expect(teamPhrase("Your OpenRig team")).toBe("your OpenRig team");
    expect(teamPhrase(null)).toBe("your OpenRig team");
  });
});

describe("rig_team for a person's assistant", () => {
  it("names the team and its members, and puts a network seat's roster entry and presence on its own entry", async () => {
    const folder = rosters("Sam's team", [
      member("dev-review@team", { label: "codex (Sam's reviewer)", caveat: "Reads, doesn't push" }),
      member("grok@team", { hosted: true, label: "grok (Sam's researcher)" }),
    ]);
    const s = await connect(folder);
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
      expect((await external.team()).hostedMembers.find((m: { session: string }) => m.session === "grok@team")).toHaveProperty("presence");
      // Its own rows aren't even read for it.
      expect(external.get.mock.calls.some(([p]) => p.includes(`destinationSession=${encodeURIComponent(CALLER)}`))).toBe(false);
      // An internal caller sees every member's presence, as before.
      expect((await internal.team()).hostedMembers.find((m: { session: string }) => m.session === CALLER)).toHaveProperty("presence");
    } finally { await external.close(); await internal.close(); }
  });
});

describe("rig_queue_list: an empty inbox", () => {
  it("says so in a line the assistant can repeat, naming the team, with the rows' shape unchanged", async () => {
    const named = await connect(rosters("Sam's team"), { external: true });
    const unnamed = await connect(rosters("Your OpenRig team"), { external: true });
    const none = await connect(rosters(null), { external: true });
    try {
      const listed = await named.list({ owned: true });
      expect(listed.structuredContent).toEqual({ items: [], message: 'No requests are addressed to you on the team "Sam\'s team" yet.' });
      expect(listed.content.map((c) => c.text)).toEqual(["[]", 'No requests are addressed to you on the team "Sam\'s team" yet.']);
      expect((await named.list()).structuredContent.message).toBe('No requests are addressed to you on the team "Sam\'s team" yet.');
      expect((await unnamed.list({ owned: true })).structuredContent.message).toBe("No requests are addressed to you on your OpenRig team yet.");
      expect((await none.list({ owned: true })).structuredContent.message).toBe("No requests are addressed to you on your OpenRig team yet.");
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
