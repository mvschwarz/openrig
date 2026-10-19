// A watchdog digest through the real outbox and the draft-aware transport, with inert terminal effects: each member is
// bound to the one attempt before any input, so an interrupted or partly accounted attempt is never written again under
// another identity, and a new reminder still goes.
import Database from "better-sqlite3";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { makeWatchdogDeliver, watchdogDeliveryId } from "../src/domain/watchdog-delivery.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function frame(body: string): ComposerSnapshot {
  const rows = body.split("\n");
  return { screen: ["Ready", "────────────────────", `❯ ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(rows.at(-1)!), y: 1 + rows.length, width: 240, height: 60 }, inMode: false };
}

/** One draft-aware seat on a fake tmux whose only effect is recording what was pasted and submitted. */
function fixture(saved?: Buffer) {
  const db = new Database(saved ?? ":memory:");
  if (!saved) {
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','terminal');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
  }
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  let body: string | null = "";
  let history = "";
  let staged = "";
  const submissions: string[] = [];
  const hooks: { paste?: () => Promise<void> } = {};
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("paste-buffer")) { await hooks.paste?.(); body = staged; }
    if (command.includes("send-keys") && command.includes("Enter")) { submissions.push(body ?? ""); history += `${body}\n`; body = ""; }
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/draft-input", bufferName: () => "draft-input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => [{ id: guard.target(name).pane! } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async () => body == null ? null : frame(body));
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async () => body == null ? null : history + frame(body).screen);
  const at = Date.now();
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    now: () => new Date(at), sleep: async () => {},
    agentActivityStore: { getLatestForNode: () => ({ state: "idle", reason: "fixture idle hook", evidenceSource: "runtime_hook", sampledAt: new Date(at).toISOString(), evidence: null }) } as never });
  transport.guardedDelivery!.recover();
  const outbox = new OutboxHandler(db);
  const deliver = makeWatchdogDeliver({ sessionTransport: transport, outbox, db });
  cleanup.push(async () => { await transport.guardedDelivery!.stop(); db.close(); });
  return { db, outbox, deliver, submissions, hooks, enable: () => guard.set("a", { mode: "draft-aware" }, "human@test", "keep draft") };
}

const seat = "worker@test";
const lone = (jobId: string, occurrenceId: string) => ({ jobId, policy: "periodic-reminder", occurrenceId });
const digest = (...members: Array<[string, string]>) => ({
  jobId: `digest-${members.map(([, o]) => o).join("+")}`, policy: "periodic-reminder", occurrenceId: `digest-${members.map(([, o]) => o).join("+")}`,
  members: members.map(([jobId, occurrenceId]) => ({ jobId, occurrenceId })),
});

describe("a watchdog digest through the real outbox and draft-aware transport", () => {
  it("binds every member to the one attempt, so neither a lone send nor a changed digest writes it again, and a new reminder goes", async () => {
    const f = fixture();
    await f.enable();
    expect(await f.deliver({ targetSession: seat, message: "A and B" }, digest(["job-a", "occ-a"], ["job-b", "occ-b"]))).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(1);
    for (const occ of ["occ-a", "occ-b"]) expect(f.outbox.getById(watchdogDeliveryId(occ))).toMatchObject({ deliveryState: "delivered" });
    // A lone fallback for B, and a digest that now also holds C: no input for the attempted occurrences.
    expect(await f.deliver({ targetSession: seat, message: "B alone" }, lone("job-b", "occ-b"))).toMatchObject({ status: "ok" });
    expect((await f.deliver({ targetSession: seat, message: "A and C" }, digest(["job-a", "occ-a"], ["job-c", "occ-c"]))).status).toBe("failed");
    expect(f.submissions).toHaveLength(1);
    expect(f.outbox.getById(watchdogDeliveryId("occ-c"))).toBeNull();
    // C, never attempted, still goes.
    expect(await f.deliver({ targetSession: seat, message: "C alone" }, lone("job-c", "occ-c"))).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(2);
    expect(f.submissions[1]).toContain("C alone");
  });

  it("never writes an interrupted attempt again after the store is reopened", async () => {
    const f = fixture();
    await f.enable();
    let reached!: () => void;
    const pasting = new Promise<void>((done) => { reached = done; });
    let unblock!: () => void;
    f.hooks.paste = () => { reached(); return new Promise((done) => { unblock = done; }); };
    void f.deliver({ targetSession: seat, message: "A and B" }, digest(["job-a", "occ-a"], ["job-b", "occ-b"]));
    await pasting;
    // The process ends mid-write; the next one opens the same store.
    const g = fixture(f.db.serialize());
    for (const occ of ["occ-a", "occ-b"]) expect(g.outbox.getById(watchdogDeliveryId(occ))?.deliveryState).toMatch(/^(indeterminate|sending)$/);
    const b = await g.deliver({ targetSession: seat, message: "B alone" }, lone("job-b", "occ-b"));
    expect(b).toMatchObject({ status: "failed" });
    expect(b.error).toMatch(/outcome is unknown/);
    expect(g.submissions).toEqual([]);
    expect(await g.deliver({ targetSession: seat, message: "C alone" }, lone("job-c", "occ-c"))).toMatchObject({ status: "ok" });
    expect(g.submissions).toHaveLength(1);
    // Let the first process's abandoned write end, so its cleanup doesn't wait on it.
    unblock();
  });
});
