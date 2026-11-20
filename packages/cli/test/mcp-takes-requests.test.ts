// A roster seat whose owner says it takes no requests: rig_team shows it before a send, and a create or handoff to it is
// written as today and says so after, with the owner's note, so the sender's assistant sends the work elsewhere. No
// refusal: an ordinary seat is unchanged, and a roster that can't be read never stops the write.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type McpAccess } from "../src/mcp-server.js";
import { DaemonClient, type DaemonResponse } from "../src/client.js";
import { parseRoster } from "../src/commands/roster.js";

const CALLER = "cus-1-caller@team";
const EXTERNAL: McpAccess = { principal: "cus-1", owner: false, rigs: ["team"], roots: [], workspace: false,
  external: { objects: { queue: ["create", "show", "list", "claim", "update"], team: ["list"] } } };
const NOTE = "Sam's Studio: it shows Sam the team's work and never picks up requests.";
const member = (seat: string, extra: Record<string, unknown> = {}) => ({ seat, host: "host-a", capabilities: ["code review"],
  engagement: ["delegate"], use_when: "A second read", why: "Reads diffs", ...extra });
const roster = (members: unknown[]) => ({ version: 1, id: "network-team", name: "Sam's team", purpose: "The person's team",
  curator: { seat: "lead@team", host: "host-a" }, updated_at: "2026-11-16", members });

const folders: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of folders.splice(0)) fs.rmSync(f, { recursive: true, force: true }); });

function rosters(members: unknown[]) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-takes-"));
  folders.push(folder);
  fs.writeFileSync(path.join(folder, "network-team.json"), JSON.stringify(roster(members)));
  return folder;
}
// dev.lead's session isn't named after its logical address: its entry is authored under dev-lead@team, the name rig_team
// also matches it by.
const studio = () => rosters([
  member("dev-review@team", { takes_requests: false, takes_requests_note: NOTE }),
  member("grok@team", { hosted: true, takes_requests: false }),
  member("dev-impl@team"),
  member("dev-lead@team", { takes_requests: false, takes_requests_note: NOTE }),
]);

async function connect(folder: string | (() => string), external: boolean) {
  const stored = new Map<string, Record<string, unknown>>();
  const get = vi.fn(async (p: string): Promise<DaemonResponse> => {
    if (p === "/healthz") return { status: 200, data: { selfHostId: "host-a" } };
    if (p.startsWith("/api/rigs/summary")) return { status: 200, data: [{ id: "rig-1", name: "team" }] };
    if (p === "/api/rigs/rig-1") return { status: 200, data: { rig: { id: "rig-1", name: "team" }, nodes: [{ id: "n1", logicalId: "dev.review" },
      { id: "n2", logicalId: "dev.impl" }, { id: "n3", logicalId: "dev.lead" }], edges: [], representative: null } };
    if (p === "/api/rigs/rig-1/nodes") return { status: 200, data: [
      { logicalId: "dev.review", canonicalSessionName: "dev-review@team", hostSelfId: "host-a", agentActivity: { state: "idle" } },
      { logicalId: "dev.impl", canonicalSessionName: "dev-impl@team", hostSelfId: "host-a", agentActivity: { state: "idle" } },
      { logicalId: "dev.lead", canonicalSessionName: "dev-lead-2@team", hostSelfId: "host-a", agentActivity: { state: "idle" } },
    ] };
    if (p === "/api/queue/hosted-members") return { status: 200, data: { members: [] } };
    if (p.startsWith("/api/queue/list?")) return { status: 200, data: [] };
    return { status: 404, data: {} };
  });
  // The daemon's create answers a retry of the same qitemId from the stored row.
  const post = vi.fn(async (route: string, body?: unknown): Promise<DaemonResponse> => {
    const sent = (body ?? {}) as Record<string, unknown>;
    if (route === "/api/queue/create") {
      const id = sent.qitemId as string;
      const again = stored.has(id);
      if (!again) stored.set(id, { qitemId: id, state: "pending", sourceSession: CALLER, destinationSession: sent.destinationSession });
      return { status: again ? 200 : 201, data: stored.get(id) };
    }
    if (route.endsWith("/handoff")) return { status: 201, data: { closed: { qitemId: "qitem-held", state: "handed-off" },
      successor: { qitemId: "qitem-next", destinationSession: sent.toSession, state: "pending" } } };
    return { status: 404, data: {} };
  });
  const client = new DaemonClient("http://127.0.0.1:9999");
  client.get = get;
  client.post = post as typeof client.post;
  const server = createMcpServer(client, { rostersFolder: typeof folder === "string" ? () => folder : folder, presenceFile: () => path.join(os.tmpdir(), "mcp-takes-presence.json"),
    ...(external ? { seat: CALLER, access: EXTERNAL } : { seat: "lead@team" }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "takes", version: "1.0.0" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) =>
    await mcp.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, any> };
  return { post, call, close: async () => { await mcp.close(); await server.close(); } };
}

describe("a roster entry that takes no requests", () => {
  it("loads takes_requests: false with its note, and a value it can't use never drops the roster", () => {
    const parsed = parseRoster(roster([
      member("a@team", { takes_requests: false, takes_requests_note: ` ${NOTE} ` }),
      member("b@team", { takes_requests: "no" }),
      member("c@team", { takes_requests_note: NOTE }),
      member("d@team", { takes_requests: false, takes_requests_note: "<b>never</b>" }),
      member("e@team", { takes_requests: true }),
      member("f@team"),
    ])).members;
    expect(parsed.map((m) => m.takes_requests ?? null)).toEqual([false, null, null, false, null, null]);
    expect(parsed.map((m) => m.takes_requests_note ?? null)).toEqual([NOTE, null, null, null, null, null]);
    expect(parsed.map((m) => m.takes_requests_problem ?? null)).toEqual([null, expect.stringContaining("isn't true or false"),
      expect.stringContaining("is for a member with takes_requests: false"), expect.stringContaining("angle bracket"), null, null]);
  });

  it("shows on rig_team before a send: a network seat's entry and a hosted member's, and an ordinary seat as before", async () => {
    const s = await connect(studio(), true);
    try {
      const team = (await s.call("rig_team", {})).structuredContent;
      const seat = (session: string) => team.seats.find((entry: { session: string }) => entry.session === session);
      expect(seat("dev-review@team")).toMatchObject({ takesRequests: false, takesRequestsNote: NOTE });
      expect(seat("dev-impl@team")).not.toHaveProperty("takesRequests");
      expect(team.hostedMembers).toMatchObject([{ session: "grok@team", takesRequests: false }]);
      expect(team.hostedMembers[0]).not.toHaveProperty("takesRequestsNote");
    } finally { await s.close(); }
  });

  it("writes a create to it as asked and answers with the owner's note, the same on a retry with that qitemId", async () => {
    const s = await connect(studio(), true);
    try {
      const args = { destination: "dev-review@team", body: "Review the diff", qitemId: "qitem-chosen-1" };
      const first = await s.call("rig_queue_create", args);
      expect(first.isError).toBeFalsy();
      expect(s.post.mock.calls[0]).toEqual(["/api/queue/create", expect.objectContaining({ qitemId: "qitem-chosen-1", destinationSession: "dev-review@team" })]);
      expect(first.structuredContent).toMatchObject({ qitemId: "qitem-chosen-1", state: "pending",
        requestsAdvisory: { seat: "dev-review@team", takesRequests: false, takesRequestsNote: NOTE } });
      expect(first.structuredContent.requestsAdvisory.message).toBe("dev-review@team's roster entry says it takes no requests, so it isn't expected"
        + " to pick this up. The item was written as asked. To get the work done, send it to another seat; rig_team shows which take requests.");
      expect(first.content[0]!.text).toContain("takes no requests");
      const retry = await s.call("rig_queue_create", args);
      expect(s.post.mock.calls.map(([, body]) => (body as { qitemId: string }).qitemId)).toEqual(["qitem-chosen-1", "qitem-chosen-1"]);
      expect(retry.structuredContent).toEqual(first.structuredContent);
    } finally { await s.close(); }
  });

  it("leaves a create to an ordinary seat as it was", async () => {
    const s = await connect(studio(), true);
    try {
      const sent = await s.call("rig_queue_create", { destination: "dev-impl@team", body: "Build it", qitemId: "qitem-chosen-2" });
      expect(sent.isError).toBeFalsy();
      expect(sent.structuredContent).toEqual({ qitemId: "qitem-chosen-2", state: "pending", sourceSession: CALLER, destinationSession: "dev-impl@team" });
    } finally { await s.close(); }
  });

  it("goes ahead when a roster can't be read, saying whether the seat takes requests isn't known", async () => {
    const folder = rosters([member("dev-impl@team")]);
    fs.writeFileSync(path.join(folder, "broken.json"), "{");
    const s = await connect(folder, true);
    try {
      const sent = await s.call("rig_queue_create", { destination: "dev-review@team", body: "Review the diff", qitemId: "qitem-chosen-3" });
      expect(sent.isError).toBeFalsy();
      expect(s.post).toHaveBeenCalledWith("/api/queue/create", expect.objectContaining({ destinationSession: "dev-review@team" }));
      expect(sent.structuredContent.requestsAdvisory).toEqual({ seat: "dev-review@team", takesRequests: "unknown",
        message: expect.stringContaining("whether this seat takes requests isn't known") });
    } finally { await s.close(); }
  });

  it("says it isn't known when a roster that can't be read could hold the entry that wins, and goes ahead", async () => {
    const send = async (folder: string, destination: string) => {
      const s = await connect(folder, true);
      try {
        const sent = await s.call("rig_queue_create", { destination, body: "Review the diff", qitemId: `qitem-${destination}` });
        expect(sent.isError).toBeFalsy();
        expect(s.post).toHaveBeenCalledWith("/api/queue/create", expect.objectContaining({ destinationSession: destination }));
        return sent.structuredContent.requestsAdvisory;
      } finally { await s.close(); }
    };
    // An unreadable roster ahead of the entry, by file name, could hold that seat's entry instead.
    const ahead = studio();
    fs.writeFileSync(path.join(ahead, "a-broken.json"), "{");
    expect(await send(ahead, "dev-review@team")).toEqual({ seat: "dev-review@team", takesRequests: "unknown", message: expect.stringContaining("isn't known") });
    // One after it can't: the earlier roster's entry is the one rig_team applies.
    const after = studio();
    fs.writeFileSync(path.join(after, "z-broken.json"), "{");
    expect(await send(after, "dev-review@team")).toMatchObject({ seat: "dev-review@team", takesRequests: false, takesRequestsNote: NOTE });
    // For a node whose entry was found under its logical address, any unreadable roster could hold its session's entry, which
    // comes first.
    expect(await send(after, "dev-lead-2@team")).toEqual({ seat: "dev-lead-2@team", takesRequests: "unknown", message: expect.stringContaining("isn't known") });
  });

  it("hands work on to it as asked and says so, and leaves a handoff to an ordinary seat as it was", async () => {
    const s = await connect(studio(), false);
    try {
      const handed = await s.call("rig_queue_handoff", { qitemId: "qitem-held", to: "grok@team" });
      expect(handed.isError).toBeFalsy();
      expect(s.post).toHaveBeenCalledWith("/api/queue/qitem-held/handoff", expect.objectContaining({ toSession: "grok@team" }));
      expect(handed.structuredContent).toMatchObject({ successor: { qitemId: "qitem-next" }, requestsAdvisory: { seat: "grok@team", takesRequests: false } });
      expect(handed.structuredContent.requestsAdvisory).not.toHaveProperty("takesRequestsNote");
      const ordinary = await s.call("rig_queue_handoff", { qitemId: "qitem-held", to: "dev-impl@team" });
      expect(ordinary.structuredContent).not.toHaveProperty("requestsAdvisory");
    } finally { await s.close(); }
  });

  it("keeps a landed create and handoff when finding the roster folder throws, with the unknown advisory", async () => {
    // The default folder reads the config file; one that becomes malformed under a running server throws there.
    const s = await connect(() => { throw new Error("config.json: Unexpected token"); }, false);
    try {
      const sent = await s.call("rig_queue_create", { destination: "dev-review@team", body: "Review the diff", qitemId: "qitem-chosen-4" });
      expect(sent.isError).toBeFalsy();
      expect(sent.structuredContent).toMatchObject({ qitemId: "qitem-chosen-4", state: "pending",
        requestsAdvisory: { seat: "dev-review@team", takesRequests: "unknown" } });
      const handed = await s.call("rig_queue_handoff", { qitemId: "qitem-held", to: "dev-review@team" });
      expect(handed.isError).toBeFalsy();
      expect(handed.structuredContent).toMatchObject({ successor: { qitemId: "qitem-next" },
        requestsAdvisory: { seat: "dev-review@team", takesRequests: "unknown" } });
    } finally { await s.close(); }
  });

  it("finds an entry authored under a node's other name, as rig_team does, for a create, its retry and a handoff", async () => {
    const s = await connect(studio(), true);
    try {
      const team = (await s.call("rig_team", {})).structuredContent;
      expect(team.seats.find((entry: { session: string }) => entry.session === "dev-lead-2@team")).toMatchObject({ takesRequests: false });
      const args = { destination: "dev-lead-2@team", body: "Plan it", qitemId: "qitem-chosen-5" };
      const first = await s.call("rig_queue_create", args);
      expect(first.structuredContent.requestsAdvisory).toMatchObject({ seat: "dev-lead-2@team", takesRequests: false, takesRequestsNote: NOTE });
      expect((await s.call("rig_queue_create", args)).structuredContent).toEqual(first.structuredContent);
    } finally { await s.close(); }
    const internal = await connect(studio(), false);
    try {
      const handed = await internal.call("rig_queue_handoff", { qitemId: "qitem-held", to: "dev-lead-2@team" });
      expect(handed.structuredContent.requestsAdvisory).toMatchObject({ seat: "dev-lead-2@team", takesRequests: false, takesRequestsNote: NOTE });
      // An internal caller's rig_team doesn't show a node seat's roster entry, so the advisory doesn't send it there.
      expect(handed.structuredContent.requestsAdvisory.message).not.toContain("rig_team");
      const hosted = await internal.call("rig_queue_handoff", { qitemId: "qitem-held", to: "grok@team" });
      expect(hosted.structuredContent.requestsAdvisory.message).toContain("rig_team shows which take requests");
    } finally { await internal.close(); }
  });
});
