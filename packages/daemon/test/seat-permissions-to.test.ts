// rig seat set-permissions-to: choose the registered person who answers a runner seat's permission requests. Only a
// registered person can be chosen, the canonical address is stored, and every change is audited.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { LoadResult } from "../src/domain/gateway/human-registry.js";

const person = (id: string) => ({ entityId: id, class: "human" as const, displayName: id, address: `${id}@external`,
  connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "unused", role: "primary" as const, handle: `U${id.toUpperCase()}` }],
  prefs: { deliveryClass: "A" as const } });
const REGISTRY = { ok: true, entities: [person("mike"), person("runner")] } as unknown as LoadResult;

function events(db: Database.Database): Array<Record<string, unknown>> {
  return (db.prepare("SELECT payload FROM events WHERE type = 'node.permissions_to_changed' ORDER BY seq").all() as Array<{ payload: string }>)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}
const owner = (db: Database.Database, nodeId: string) =>
  (db.prepare("SELECT permissions_to FROM nodes WHERE id = ?").get(nodeId) as { permissions_to: string | null }).permissions_to;

describe("SeatLifecycleService.setPermissionsTo", () => {
  let db: Database.Database;
  let nodeId: string;
  let registry: () => LoadResult;
  let service: (withRegistry?: boolean) => SeatLifecycleService;

  beforeEach(() => {
    db = createFullTestDb();
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
    const rig = rigRepo.createRig("perm-rig");
    nodeId = rigRepo.addNode(rig.id, "dev.runner", { runtime: "synth" }).id;
    sessionRegistry.registerSession(nodeId, "dev-runner@perm-rig");
    registry = () => REGISTRY;
    service = (withRegistry = true) => new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus,
      tmuxAdapter: {} as TmuxAdapter, ...(withRegistry ? { humanRegistry: () => registry() } : {}) });
  });
  afterEach(() => db.close());

  it("chooses a registered person by their canonical address, and audits it", () => {
    expect(service().setPermissionsTo({ seatRef: "dev-runner@perm-rig", to: "mike@external", reason: "Mike approves tool calls", operator: "ops@perm-rig" }))
      .toMatchObject({ ok: true, from: null, to: "mike@external", changed: true });
    expect(owner(db, nodeId)).toBe("mike@external");
    expect(events(db)).toEqual([expect.objectContaining({ nodeId, from: null, to: "mike@external", reason: "Mike approves tool calls", operator: "ops@perm-rig" })]);
  });

  it("records the operator's explicit opt-in to refuse every request, and audits it", () => {
    expect(service().setPermissionsTo({ seatRef: "dev-runner@perm-rig", to: "deny", reason: "high stakes", operator: "ops@perm-rig" }))
      .toMatchObject({ ok: true, from: null, to: "deny", changed: true });
    expect(owner(db, nodeId)).toBe("deny");
    expect(events(db)).toEqual([expect.objectContaining({ nodeId, from: null, to: "deny", reason: "high stakes" })]);
  });

  it("records no change when the same person is chosen again, and clears to no one", () => {
    service().setPermissionsTo({ seatRef: "dev-runner@perm-rig", to: "mike@external", reason: "first" });
    expect(service().setPermissionsTo({ seatRef: "dev-runner@perm-rig", to: "mike@external", reason: "again" })).toMatchObject({ ok: true, changed: false });
    expect(events(db)).toHaveLength(1);
    expect(service().setPermissionsTo({ seatRef: "dev-runner@perm-rig", to: null, reason: "back to refusal" }))
      .toMatchObject({ ok: true, from: "mike@external", to: null, changed: true });
    expect(owner(db, nodeId)).toBeNull();
    expect(events(db)).toHaveLength(2);
  });

  it.each([
    ["a seat address, even when its member name is a registered person", "dev-runner@perm-rig"],
    ["an agent seat on another rig", "ops-lead@perm-rig"],
    ["an unregistered person", "nobody@external"],
  ])("refuses %s, and saves nothing", (_case, to) => {
    expect(service().setPermissionsTo({ seatRef: "dev-runner@perm-rig", to, reason: "try" })).toMatchObject({ ok: false, code: "permissions_to_not_a_person" });
    expect(owner(db, nodeId)).toBeNull();
    expect(events(db)).toHaveLength(0);
  });

  it("refuses when the registered people can't be read, and when the daemon has no registry", () => {
    registry = () => ({ ok: false, error: "registry file is malformed" }) as unknown as LoadResult;
    expect(service().setPermissionsTo({ seatRef: "dev-runner@perm-rig", to: "mike@external", reason: "try" }))
      .toMatchObject({ ok: false, code: "permissions_to_unavailable", message: "registry file is malformed" });
    expect(service(false).setPermissionsTo({ seatRef: "dev-runner@perm-rig", to: "mike@external", reason: "try" }))
      .toMatchObject({ ok: false, code: "permissions_to_unavailable" });
    expect(owner(db, nodeId)).toBeNull();
  });

  it("needs a reason and a person, and names an unknown seat", () => {
    expect(service().setPermissionsTo({ seatRef: "dev-runner@perm-rig", to: "mike@external", reason: " " })).toMatchObject({ ok: false, code: "missing_reason" });
    expect(service().setPermissionsTo({ seatRef: "dev-runner@perm-rig", to: "", reason: "try" })).toMatchObject({ ok: false, code: "missing_permissions_to" });
    expect(service().setPermissionsTo({ seatRef: "dev-nobody@perm-rig", to: "mike@external", reason: "try" })).toMatchObject({ ok: false, code: "seat_not_found" });
  });
});
