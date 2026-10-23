// Seat interruption levels: per seat, how much automatic input may type into its terminal. Always interrupt (`off`) and
// full quiet (`hold`) are today's guard; the middle levels decide by the input's source (OpenRig's own, or anyone else's)
// and whether it's marked urgent. What a level keeps out is held, never refused or lost. Real SQLite (all migrations).
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SeatDeliveryGuard, type AdmissionInput, type GuardTarget } from "../src/domain/seat-delivery-guard.js";

function fixture() {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('r', 'rig')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('agent', 'r', 'dev.impl', 'claude-code'), ('term', 'r', 'ops.shell', 'terminal')").run();
  const targets: Record<string, GuardTarget> = {
    agent: { nodeId: "agent", session: "agent", occupant: "g1", pane: "%1" },
    term: { nodeId: "term", session: "term", occupant: "g2", pane: "%2" },
  };
  const guard = new SeatDeliveryGuard(db, (name) => targets[name] ?? null);
  // What the person sees for one input: typed, or held (and the sender is told).
  const deliver = (seat: string, input?: AdmissionInput) =>
    guard.operation(seat, async () => "typed", async () => "held", input);
  return { db, guard, deliver };
}

const openrig: AdmissionInput = { source: "openrig", urgent: false };
const agent: AdmissionInput = { source: "agent", urgent: false };
const urgentAgent: AdmissionInput = { source: "agent", urgent: true };

describe("the level table at the guard", () => {
  it.each([
    ["off", { openrig: "typed", agent: "typed", urgent: "typed" }],
    ["openrig-urgent", { openrig: "typed", agent: "held", urgent: "typed" }],
    ["urgent-only", { openrig: "held", agent: "held", urgent: "typed" }],
    ["hold", { openrig: "held", agent: "held", urgent: "held" }],
  ] as const)("at %s: an OpenRig message, an agent's, and an agent's marked urgent", async (mode, expected) => {
    const f = fixture();
    await f.guard.set("agent", { mode }, "person", "focus");
    expect({ openrig: await f.deliver("agent", openrig), agent: await f.deliver("agent", agent), urgent: await f.deliver("agent", urgentAgent) })
      .toEqual(expected);
    // The person's own typing always works.
    expect(await f.guard.humanInput("agent", async () => "typed by the person")).toBe("typed by the person");
  });

  it("an agent seat nobody configured types everything, as today", async () => {
    const f = fixture();
    expect([await f.deliver("agent", openrig), await f.deliver("agent", agent)]).toEqual(["typed", "typed"]);
    expect(f.guard.preference("agent")).toMatchObject({ desired: false, effective: false, desiredMode: "off" });
    expect(f.guard.preference("agent").desiredLevel).toBeUndefined();
  });

  it("a terminal member nobody configured holds OpenRig's notices and takes deliberate sends; its switch makes notices type", async () => {
    const f = fixture();
    expect([await f.deliver("term", openrig), await f.deliver("term", agent)]).toEqual(["held", "typed"]);
    expect(f.guard.preference("term")).toMatchObject({ desired: false, desiredMode: "off", desiredLevel: "sends-only" });
    // Lifecycle work isn't an input the level classifies: the default never blocks it.
    expect(await f.guard.operation("term", async () => "restarted")).toBe("restarted");
    await f.guard.set("term", { mode: "off" }, "person", "show me OpenRig's notices");
    expect(await f.deliver("term", openrig)).toBe("typed");
  });

  it("a middle level is stored with the coarse mode older daemons understand, so they hold more, never type what it holds", async () => {
    const f = fixture();
    await f.guard.set("agent", { mode: "openrig-urgent" }, "person", "focus");
    const row = f.db.prepare("SELECT desired, desired_config FROM seat_delivery_guards WHERE node_id='agent'").get() as { desired: number; desired_config: string };
    expect(JSON.parse(row.desired_config)).toMatchObject({ mode: "hold", level: "openrig-urgent" });
    expect(row.desired).toBe(1); // a daemon without modes reads the legacy bit: hold
    // Lifecycle work at a middle level is refused, as at hold.
    await expect(f.guard.operation("agent", async () => "restarted")).rejects.toMatchObject({ code: "typing_guard_enabled" });
  });
});
