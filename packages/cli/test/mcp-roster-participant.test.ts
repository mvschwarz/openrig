// A roster entry can record which client its participant uses (`app`) and what kind of participant it is (`kind`), as the
// service that issued its access recorded them. rig_team passes them through as `participant`, apart from a seat's own
// `kind` (its node kind). OpenRig keeps no list of its own: a short lowercase token passes as recorded, anything else is
// dropped with the reason, and the roster still loads. Absent is unknown, never inferred from a name or label.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, MEMBER_WORKFLOW, type McpAccess } from "../src/mcp-server.js";
import { DaemonClient, type DaemonResponse } from "../src/client.js";
import { parseRoster } from "../src/commands/roster.js";

const CALLER = "cus-1-caller@team";
const EXTERNAL: McpAccess = { principal: "cus-1", owner: false, rigs: ["team"], roots: [], workspace: false,
  external: { objects: { queue: ["create", "show", "list", "claim", "update"], team: ["list"] } } };
const member = (seat: string, extra: Record<string, unknown> = {}) => ({ seat, host: "host-a", capabilities: ["code review"],
  engagement: ["delegate"], use_when: "A second read", why: "Reads diffs", ...extra });
const roster = (members: unknown[]) => ({ version: 1, id: "network-team", name: "Sam's team", purpose: "The person's team",
  curator: { seat: "lead@team", host: "host-a" }, updated_at: "2026-11-17", members });

const folders: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of folders.splice(0)) fs.rmSync(f, { recursive: true, force: true }); });

function rosters(members: unknown[]) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-participant-"));
  folders.push(folder);
  fs.writeFileSync(path.join(folder, "network-team.json"), JSON.stringify(roster(members)));
  return folder;
}

async function connect(folder: string, external: boolean, representative: string | null = null, nodes?: unknown[]) {
  const get = vi.fn(async (p: string): Promise<DaemonResponse> => {
    if (p === "/healthz") return { status: 200, data: { selfHostId: "host-a" } };
    if (p.startsWith("/api/rigs/summary")) return { status: 200, data: [{ id: "rig-1", name: "team" }] };
    if (p === "/api/rigs/rig-1") return { status: 200, data: { rig: { id: "rig-1", name: "team" }, nodes: [{ id: "n1", logicalId: "net.chatgpt" },
      { id: "n2", logicalId: "dev.impl" }], edges: [], representative } };
    // A terminal-attached network seat is an infrastructure node: that's its own kind, which a roster never changes.
    if (p === "/api/rigs/rig-1/nodes") return { status: 200, data: nodes ?? [
      { logicalId: "net.chatgpt", canonicalSessionName: "net-chatgpt@team", hostSelfId: "host-a", nodeKind: "infrastructure", agentActivity: { state: "idle" } },
      { logicalId: "dev.impl", canonicalSessionName: "dev-impl@team", hostSelfId: "host-a", nodeKind: "agent", agentActivity: { state: "idle" } },
    ] };
    if (p === "/api/queue/hosted-members") return { status: 200, data: { members: [] } };
    if (p.startsWith("/api/queue/list?")) return { status: 200, data: [] };
    return { status: 404, data: {} };
  });
  const client = new DaemonClient("http://127.0.0.1:9999");
  client.get = get;
  const server = createMcpServer(client, { rostersFolder: () => folder, presenceFile: () => path.join(os.tmpdir(), "mcp-participant-presence.json"),
    ...(external ? { seat: CALLER, access: EXTERNAL } : { seat: "lead@team" }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "participant", version: "1.0.0" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  // An external grant's sole rig is found for it; an internal caller names the rig.
  const team = async () => ((await mcp.callTool({ name: "rig_team", arguments: external ? {} : { rigId: "team" } })) as { structuredContent: Record<string, any> }).structuredContent;
  return { team, instructions: () => mcp.getInstructions() ?? "", close: async () => { await mcp.close(); await server.close(); } };
}

describe("a roster entry's participant app and kind", () => {
  it("loads a token as recorded, drops a value that isn't one with the reason, and never stops the roster loading", () => {
    const parsed = parseRoster(roster([
      member("a@team", { app: "chatgpt", kind: "persistent" }),
      member("b@team", { app: "newclient-2" }),
      member("c@team", { app: "ChatGPT", kind: "shared" }),
      member("d@team", { app: 7, kind: "a shared one" }),
      member("e@team", { app: "", kind: "" }),
      member("f@team"),
    ])).members;
    expect(parsed.map((m) => m.seat)).toEqual(["a@team", "b@team", "c@team", "d@team", "e@team", "f@team"]);
    expect(parsed.map((m) => m.participant ?? null)).toEqual([{ app: "chatgpt", kind: "persistent" }, { app: "newclient-2" },
      { kind: "shared" }, null, null, null]);
    expect(parsed.map((m) => m.participant_problem ?? null)).toEqual([null, null,
      expect.stringContaining("app \"ChatGPT\" isn't a short lowercase token"),
      expect.stringMatching(/^app 7 isn't a short lowercase token.*; kind "a shared one" isn't a short lowercase token/), null, null]);
  });

  it("shows on rig_team for an external caller: a network seat's entry keeps its node kind, and a hosted member's too", async () => {
    const s = await connect(rosters([
      member("net-chatgpt@team", { app: "chatgpt", kind: "shared" }),
      member("dev-impl@team"),
      member("hermes@team", { hosted: true, app: "hermes", kind: "persistent" }),
      member("odd@team", { hosted: true, app: "Claude Code" }),
    ]), true);
    try {
      const team = await s.team();
      const seat = (session: string) => team.seats.find((entry: { session: string }) => entry.session === session);
      expect(seat("net-chatgpt@team")).toMatchObject({ kind: "infrastructure", participant: { app: "chatgpt", kind: "shared" } });
      // Absent is unknown: nothing is shown, and the seat is as the daemon reports it.
      expect(seat("dev-impl@team")).toMatchObject({ kind: "agent" });
      expect(seat("dev-impl@team")).not.toHaveProperty("participant");
      const hosted = (session: string) => team.hostedMembers.find((entry: { session: string }) => entry.session === session);
      expect(hosted("hermes@team")).toMatchObject({ participant: { app: "hermes", kind: "persistent" } });
      // A value that isn't a token isn't shown; the member still is, with the reason.
      expect(hosted("odd@team")).not.toHaveProperty("participant");
      expect(hosted("odd@team")).toMatchObject({ participantProblem: expect.stringContaining("isn't a short lowercase token") });
    } finally { await s.close(); }
  });

  it("shows on a hosted member for an internal caller too", async () => {
    const s = await connect(rosters([member("hermes@team", { hosted: true, app: "hermes", kind: "persistent" })]), false);
    try {
      expect((await s.team()).hostedMembers).toMatchObject([{ session: "hermes@team", participant: { app: "hermes", kind: "persistent" } }]);
    } finally { await s.close(); }
  });
});

// A roster entry can declare lead_of, the team it's the entry point for. rig_team shows it as the lead only where the daemon
// names no single lead and exactly one entry declares one; it's context, so nothing escalates or routes to it.
describe("a roster entry's declared lead_of", () => {
  const at = (name: string) => [name, "team"].join("@");

  it("loads a plain team name, trimmed, and drops one that isn't, with the reason", () => {
    const parsed = parseRoster(roster([
      member(at("a"), { lead_of: " Sam's team " }),
      member(at("b"), { lead_of: "x".repeat(41) }),
      member(at("c"), { lead_of: 7 }),
      member(at("d"), { lead_of: "" }),
    ])).members;
    expect(parsed.map((m) => m.lead_of ?? null)).toEqual(["Sam's team", null, null, null]);
    expect(parsed.map((m) => m.lead_of_problem ?? null)).toEqual([null, "lead_of is longer than 40 characters", "lead_of isn't non-empty text", null]);
  });

  it("shows one declared entry point as the lead where there's no delegation root, for either caller", async () => {
    for (const external of [false, true]) {
      const s = await connect(rosters([member(at("net-chatgpt"), { lead_of: "Sam's team" }), member(at("hermes"), { hosted: true })]), external);
      try {
        const team = await s.team();
        expect(team.lead).toEqual({ session: at("net-chatgpt"), logicalId: "net.chatgpt", declared: true, team: "Sam's team" });
        expect(team.leadNote).toBe("Sam's team's entry point: send work for that team here. It doesn't manage this network or its other participants.");
      } finally { await s.close(); }
    }
  });

  it("shows no lead when several entries declare one, and the note names them", async () => {
    const s = await connect(rosters([member(at("net-chatgpt"), { lead_of: "Sam's team" }), member(at("hermes"), { hosted: true, lead_of: "Ops" })]), false);
    try {
      const team = await s.team();
      expect(team.lead).toBeNull();
      expect(team.leadNote).toContain(`Several roster entries declare lead_of (${at("net-chatgpt")} for Sam's team, ${at("hermes")} for Ops), so none is shown as the lead.`);
    } finally { await s.close(); }
  });

  it("keeps the one declared entry point when a roster can't be read, and says another may be declared", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const external of [false, true]) {
      const folder = rosters([member(at("net-chatgpt"), { lead_of: "Sam's team" })]);
      // An unreadable roster is skipped, and it could hold a second declaration.
      fs.writeFileSync(path.join(folder, "other.json"), "{ not json");
      const s = await connect(folder, external);
      try {
        const team = await s.team();
        expect(team.hostedMembersNote).toEqual(expect.any(String));
        expect(team.lead).toEqual({ session: at("net-chatgpt"), logicalId: "net.chatgpt", declared: true, team: "Sam's team" });
        expect(team.leadNote).toBe("Sam's team's entry point: send work for that team here. It doesn't manage this network or its other participants."
          + " Some rosters couldn't be read, so another entry point may be declared.");
      } finally { await s.close(); }
    }
  });

  // network-sme's condition: on a network hub, "the rig's lead" means the delegation-root lead only, never a declared entry point.
  it("never gives a network grant the member workflow, which sends questions to the rig's lead; a team member gets it", async () => {
    for (const external of [true, false]) {
      const s = await connect(rosters([member(at("net-chatgpt"), { lead_of: "Sam's team" })]), external);
      try {
        if (external) {
          expect(s.instructions()).not.toContain(MEMBER_WORKFLOW);
          expect(s.instructions()).not.toContain("member-workflow/");
        } else {
          expect(s.instructions()).toContain(MEMBER_WORKFLOW);
        }
      } finally { await s.close(); }
    }
  });

  // One declaration per seat and team: a seat in two rosters with two teams is two, and one node under both its names is one.
  const secondRoster = (folder: string, members: unknown[]) =>
    fs.writeFileSync(path.join(folder, "ops.json"), JSON.stringify({ ...roster(members), id: "ops" }));

  it("shows the lead when one seat declares the same team in two rosters", async () => {
    const folder = rosters([member(at("net-chatgpt"), { lead_of: "Sam's team" })]);
    secondRoster(folder, [member(at("net-chatgpt"), { lead_of: "Sam's team" })]);
    const s = await connect(folder, false);
    try {
      expect((await s.team()).lead).toEqual({ session: at("net-chatgpt"), logicalId: "net.chatgpt", declared: true, team: "Sam's team" });
    } finally { await s.close(); }
  });

  it("shows no lead when one seat declares a different team in another roster, and the note names both", async () => {
    const folder = rosters([member(at("net-chatgpt"), { lead_of: "Sam's team" })]);
    secondRoster(folder, [member(at("net-chatgpt"), { lead_of: "Ops" })]);
    const s = await connect(folder, false);
    try {
      const team = await s.team();
      expect(team.lead).toBeNull();
      expect(team.leadNote).toContain(`Several roster entries declare lead_of (${at("net-chatgpt")} for Sam's team, ${at("net-chatgpt")} for Ops), so none is shown as the lead.`);
    } finally { await s.close(); }
  });

  it("counts one node named by its session in one roster and its logical address in another, for the same team, once", async () => {
    const folder = rosters([member(at("chatgpt-seat"), { lead_of: "Sam's team" })]);
    secondRoster(folder, [member(at("net-chatgpt"), { lead_of: "Sam's team" })]);
    const s = await connect(folder, false, null, [
      { logicalId: "net.chatgpt", canonicalSessionName: at("chatgpt-seat"), hostSelfId: "host-a", nodeKind: "infrastructure", agentActivity: { state: "idle" } },
      { logicalId: "dev.impl", canonicalSessionName: at("dev-impl"), hostSelfId: "host-a", nodeKind: "agent", agentActivity: { state: "idle" } },
    ]);
    try {
      expect((await s.team()).lead).toEqual({ session: at("chatgpt-seat"), logicalId: "net.chatgpt", declared: true, team: "Sam's team" });
    } finally { await s.close(); }
  });

  it("keeps a real delegation root as the lead, undeclared", async () => {
    const s = await connect(rosters([member(at("net-chatgpt"), { lead_of: "Sam's team" })]), false, at("dev-impl"));
    try {
      expect((await s.team()).lead).toEqual({ session: at("dev-impl"), logicalId: "dev.impl" });
    } finally { await s.close(); }
  });
});
