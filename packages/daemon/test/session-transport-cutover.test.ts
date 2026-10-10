import { describe, it, expect } from "vitest";
import { ulid } from "ulid";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";

// Exercise the real adapter classifier over a delayed, inert tmux reply.
// Send deliberately omits the optional delivery guard to test the shared writer too.
describe.each(["capture", "send"] as const)("%s absence observation", verb => {
  it.each(["same-pane successor", "different-pane successor", "binding changed", "current occupant"])(
    "does not reassign evidence across %s",
    async change => {
      const db = createFullTestDb();
      try {
        const start = Date.parse("2026-07-02T12:00:00.000Z");
        const oldId = ulid(start), newId = ulid(start + 200);
        const name = "dev-impl@test-rig";
        db.prepare("INSERT INTO rigs(id,name) VALUES('r','test-rig')").run();
        db.prepare("INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES('n','r','dev.impl','claude-code')").run();
        const insert = db.prepare("INSERT INTO sessions(id,node_id,session_name,status,startup_status,created_at) VALUES(?,'n',?,'running','ready','2026-07-02 12:00:00')");
        insert.run(oldId, name);
        db.prepare("INSERT INTO bindings(id,node_id,attachment_type,tmux_session,tmux_pane) VALUES('b','n','tmux',?,'%1')").run(name);
        let release!: () => void;
        const pendingProbe = new Promise<void>(resolve => { release = resolve; });
        let now = start + 100;
        let started = false;
        const transport = new SessionTransport({
          db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), now: () => new Date(now),
          tmuxAdapter: new TmuxAdapter(async () => {
            started = true;
            await pendingProbe;
            throw new Error("can't find session: " + name);
          }),
        });
        const pending = verb === "capture" ? transport.capture(name) : transport.send(name, "hello");
        expect(started).toBe(true);
        if (change.endsWith("successor")) {
          db.prepare("UPDATE sessions SET status='superseded' WHERE id=?").run(oldId);
          insert.run(newId, name);
          db.prepare("UPDATE nodes SET handover_at=? WHERE id='n'").run(new Date(start + 200).toISOString());
        }
        if (change === "different-pane successor" || change === "binding changed") {
          db.prepare("UPDATE bindings SET tmux_pane='%2' WHERE node_id='n'").run();
        }
        if (change !== "current occupant") {
          new SeatIdentityStore(db).upsert({
            nodeId: "n", verdict: "verified", evidenceSource: "pane_process", reason: null,
            evidence: { registeredPane: change === "same-pane successor" ? "%1" : "%2", observedPid: 123, observedCommand: "claude", matchedLayer: null },
            sessionName: name, observedAt: new Date(start + 250).toISOString(),
          });
        }
        now = start + 300;
        release();
        expect(await pending).toMatchObject({ ok: false, reason: "session_missing" });
        const stored = new SeatIdentityStore(db).getForNode("n");
        if (change === "current occupant") {
          expect(stored).toMatchObject({ reason: "session_missing", observedAt: new Date(start + 100).toISOString(), evidence: { registeredPane: "%1" } });
          expect(getNodeInventory(db, "r")[0]!.startupStatus).toBe("attention_required");
        } else {
          expect(stored).toMatchObject({ verdict: "verified", observedAt: new Date(start + 250).toISOString() });
          expect(getNodeInventory(db, "r")[0]!.startupStatus).toBe("ready");
        }
      } finally { db.close(); }
    },
  );
});
