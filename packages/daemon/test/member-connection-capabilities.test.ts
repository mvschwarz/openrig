// The member-connection.v1 declarations: what each delivery route says it supports, read from the running daemon's
// route and from the contract module the consumers read.
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { resolveMemberConnection } from "../src/domain/member-connection.js";
import { ROUTE_DECLARATIONS, declaredCapabilities, memberConnection, type ConnectionCapabilities } from "../src/domain/connection-contract.js";

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  vi.restoreAllMocks();
});

const flatten = (c: ConnectionCapabilities) => Object.values(c).flatMap((group) => Object.values(group));

describe("declared capabilities", () => {
  it("declares Codex's queue command as a route that isn't armed, and the typed route as armed", () => {
    expect(ROUTE_DECLARATIONS.map((d) => [d.route, d.armed])).toEqual([["typed", true], ["codex-queue", false], ["hosted-trigger", true], ["gateway", true]]);
  });

  it("declares in the design's four groups, with what only Claude Code's screen gives limited to it", () => {
    const claude = declaredCapabilities("typed", "claude-code"), codex = declaredCapabilities("typed", "codex");
    expect(Object.keys(claude)).toEqual(["observe", "control", "nativeIdentity", "continuity"]);
    expect(claude.continuity.restorePacketConfirmation).toBe("supported");
    expect(codex.continuity.restorePacketConfirmation).toBe("not-supported");
    expect(codex.continuity.managedCompaction).toBe("not-supported");
    // No route correlates a turn start to a delivery yet.
    expect(ROUTE_DECLARATIONS.flatMap((d) => Object.values(d.capabilities)).map((c) => c.observe.turnStart)).not.toContain("supported");
    // Any other runtime: typing works; what it would need to read its screen isn't claimed.
    expect(declaredCapabilities("typed", "some-new-runtime")).toMatchObject({ control: { submit: "supported" }, observe: { dialog: "not-supported" } });
  });

  it("a seat with no live terminal keeps its declaration, with what needs the terminal unavailable, never supported or idle", () => {
    const stopped = memberConnection("dev-impl@r", { kind: "seat", runtime: "codex", live: false });
    expect(stopped).toMatchObject({ route: "typed", runtime: "codex", reason: "it has no live terminal now",
      capabilities: { control: { submit: "unavailable" }, observe: { dialog: "unavailable" }, nativeIdentity: { resume: "supported" } } });
    const nobody = memberConnection("ghost@r", { kind: "none", reason: "no one has it" });
    expect(nobody).toMatchObject({ route: null, reason: "no one has it" });
    expect(new Set(flatten(nobody.capabilities))).toEqual(new Set(["unknown"]));
  });
});

describe("GET /api/member-connection/capabilities", () => {
  function setup() {
    const db = createFullTestDb();
    dbs.push(db);
    const app = createTestApp(db);
    const get = async (query = "") => {
      const res = await app.app.request(`/api/member-connection/capabilities${query}`);
      return { status: res.status, body: await res.json() as Record<string, any> };
    };
    return { ...app, get };
  }

  it("answers every route's declaration, and the member an address names: its route, runtime and capabilities", async () => {
    const t = setup();
    const rig = t.rigRepo.createRig("team");
    const live = t.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    t.sessionRegistry.updateStatus(t.sessionRegistry.registerSession(live.id, "dev-impl@team").id, "running");
    t.sessionRegistry.updateBinding(live.id, { tmuxSession: "dev-impl@team", tmuxPane: "%1" });
    const stopped = t.rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    t.sessionRegistry.updateStatus(t.sessionRegistry.registerSession(stopped.id, "dev-qa@team").id, "exited");

    const all = await t.get();
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ contract: "member-connection.v1", routes: JSON.parse(JSON.stringify(ROUTE_DECLARATIONS)) });

    expect((await t.get("?session=dev-impl@team")).body.member).toEqual({ member: "dev-impl@team", route: "typed", runtime: "claude-code",
      capabilities: declaredCapabilities("typed", "claude-code") });
    expect((await t.get("?session=dev-qa@team")).body.member).toMatchObject({ route: "typed", runtime: "codex",
      capabilities: { control: { submit: "unavailable" } } });
    expect((await t.get("?session=human@host")).body.member).toMatchObject({ route: "gateway" });
    const unknown = (await t.get("?session=nobody@nowhere")).body.member;
    expect(unknown).toMatchObject({ route: null, runtime: null, reason: expect.stringContaining("no seat, hosted member or registered person") });
    expect(new Set(flatten(unknown.capabilities))).toEqual(new Set(["unknown"]));
  });
});

describe("resolveMemberConnection: the daemon's queue names people and hosted members", () => {
  it("a registered person is reached through the gateway and a hosted member through its trigger, before any seat", () => {
    const db = createFullTestDb();
    dbs.push(db);
    const registry = { ok: true as const, entities: [{ entityId: "ana", class: "human" as const, displayName: "Ana", address: "ana@external",
      connectorBindings: [], prefs: { deliveryClass: "A" as const } }] };
    const queue = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry, isHostedMember: (address) => address === "assistant@team" });
    expect(resolveMemberConnection(db, queue, "ana@external")).toMatchObject({ route: "gateway",
      capabilities: { control: { submit: "not-applicable" } } });
    expect(resolveMemberConnection(db, queue, "assistant@team")).toMatchObject({ route: "hosted-trigger",
      capabilities: { observe: { dialog: "not-applicable" }, control: { submit: "not-applicable" } } });
    // Without the queue (an older wiring), people and hosted members can't be told apart: unknown, never a guess.
    expect(resolveMemberConnection(db, undefined, "assistant@team")).toMatchObject({ route: null });
  });
});
