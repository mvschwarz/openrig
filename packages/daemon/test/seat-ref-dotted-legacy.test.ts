// #1332: `rig start` and `rig up --existing` print `rig seat launch <logical id>@<rig> --fresh ...` for a seat a restore
// left awaiting a decision. Follow that reference through the seat resolver every seat verb shares: in an older
// flat rig with dotted ids, each printed reference must reach its own seat.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const RIG = "legacy-rig";

describe("#1332 the printed one-seat reference for dotted legacy seat ids", () => {
  let db: Database.Database;
  let service: SeatLifecycleService;
  const nodeIds: Record<string, string> = {};
  const resolve = (ref: string) => {
    const result = service.stopPrecondition(ref);
    return "code" in result ? result.code : result.expected.nodeId;
  };

  beforeEach(() => {
    db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig(RIG);
    // Seats only, no sessions: the resolver matches the rig's seats. Since #1587 both dotted seats share the team
    // address dev-ops-impl@legacy-rig, so only one of them can register a session, but both can still be left
    // awaiting a decision.
    for (const logicalId of ["dev.ops.impl", "dev.ops-impl", "orch.lead"]) {
      nodeIds[logicalId] = rigRepo.addNode(rig.id, logicalId, { role: "worker", runtime: "claude-code" }).id;
    }
    service = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus: new EventBus(db), tmuxAdapter: {} as TmuxAdapter });
  });
  afterEach(() => db.close());

  it("each seat's printed reference resolves to that seat only", () => {
    expect(resolve(`dev.ops.impl@${RIG}`)).toBe(nodeIds["dev.ops.impl"]);
    expect(resolve(`dev.ops-impl@${RIG}`)).toBe(nodeIds["dev.ops-impl"]);
    expect(resolve(`orch.lead@${RIG}`)).toBe(nodeIds["orch.lead"]);
  });

  it("control: the dots-to-dashes name reaches the other seat, which is why it isn't printed", () => {
    expect(resolve(`dev-ops-impl@${RIG}`)).toBe(nodeIds["dev.ops-impl"]);
  });
});
