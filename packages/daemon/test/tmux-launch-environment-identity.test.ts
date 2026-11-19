import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";

function fixture(kind: "tmux" | "psmux" = "psmux") {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY); INSERT INTO nodes VALUES ('a'),('b');");
  db.exec(outboxEntriesSchema.sql); db.exec(seatDeliveryGuardSchema.sql);
  const guard = new SeatDeliveryGuard(db, id => ["a", "b"].includes(id) ? { nodeId: id, session: id, occupant: "owned", pane: "%1" } : null);
  const tmux = new TmuxAdapter(async () => { throw new Error("No terminal dispatch permitted"); }, undefined, undefined, [], kind);
  tmux.deliveryGuard = guard;
  const boundary = tmux as unknown as { createSessionUnchecked(name: string, cwd?: string, env?: Record<string, string>): Promise<{ ok: true }> };
  const create = vi.spyOn(boundary, "createSessionUnchecked").mockResolvedValue({ ok: true });
  vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%new" } as never]);
  const note = vi.spyOn(guard, "noteFreshLifecyclePane");
  return { db, tmux, guard, create, note };
}

it.runIf(process.platform === "win32").each([
  [{ openrig_node_id: "a" }, true], [{ Openrig_Node_Id: "a" }, true],
  [{ OPENRIG_NODE_ID: "b", openrig_node_id: "a" }, false],
] as Array<[Record<string, string>, boolean]>)("native launch lease follows child environment identity %j", async (env, allowed) => {
  const f = fixture();
  try {
    const result = await f.guard.lifecycle(["a"], () => f.tmux.createSession("a", undefined, env));
    expect(result.ok).toBe(allowed);
    if (allowed) expect(f.note).toHaveBeenCalledWith("a", "%new");
    else { expect(result).toMatchObject({ code: "guard_lease_required" }); expect(f.create).not.toHaveBeenCalled(); expect(f.note).not.toHaveBeenCalled(); }
  } finally { f.db.close(); }
});

it("launch snapshots identity and environment before asynchronous preparation", async () => {
  const f = fixture(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => entered = resolve), finish = new Promise<void>(resolve => release = resolve);
  const env = { OPENRIG_NODE_ID: "a", OWNED_CANARY: "original" }; let observed: Record<string, string> | undefined;
  f.create.mockImplementation(async (_name, _cwd, selected) => { entered(); await finish; observed = { ...selected }; return { ok: true }; });
  const result = f.guard.lifecycle(["a"], () => f.tmux.createSession("a", undefined, env));
  try {
    await started; env.OPENRIG_NODE_ID = "b"; env.OWNED_CANARY = "changed"; release();
    expect(await result).toMatchObject({ ok: true }); expect(observed).toEqual({ OPENRIG_NODE_ID: "a", OWNED_CANARY: "original" });
    expect(f.note).toHaveBeenCalledWith("a", "%new");
  } finally { release(); await result; f.db.close(); }
});

it("POSIX terminal launch keeps exact environment-name matching", async () => {
  const f = fixture("tmux");
  try {
    expect(await f.guard.lifecycle(["a"], () => f.tmux.createSession("a", undefined, { openrig_node_id: "a" })))
      .toMatchObject({ ok: false, code: "guard_lease_required" });
    expect(f.create).not.toHaveBeenCalled();
  } finally { f.db.close(); }
});
