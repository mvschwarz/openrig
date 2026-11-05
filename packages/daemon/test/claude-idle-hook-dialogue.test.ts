// Synthetic hooks, panes, input effects and SQLite; no live provider or terminal.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";

const rule = "─".repeat(60);
const composer = `${rule}\n❯ \n${rule}\n  ⏵⏵ accept edits on (shift+tab to cycle)`;
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()); vi.restoreAllMocks(); });

function fixture(pane: string) {
  const db = new Database(":memory:"); cleanups.push(() => db.close()); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('node','rig','worker','claude-code');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('binding','node','worker@test','%1');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('session','node','worker@test','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('generation','node',1,'g1','fresh');`);
  const effects: Array<{ kind: string; argv: string[]; text?: string }> = [];
  let staged = "";
  const tmux = new TmuxAdapter(async () => "", {
    writeFile: async (_path, text) => { staged = text; }, unlink: async () => {},
    tmpName: () => "/fixture/input", bufferName: () => "input",
  }, async argv => {
    if (argv[1] === "paste-buffer") effects.push({ kind: "paste", argv: [...argv], text: staged });
    if (argv[1] === "send-keys") effects.push({ kind: "keys", argv: [...argv] });
    return "";
  });
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name)); guard.recoverActivation();
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1" } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("claude");
  vi.spyOn(tmux, "getPanePid").mockResolvedValue(null);
  vi.spyOn(tmux, "capturePaneContent").mockResolvedValue(pane);
  const screen = pane.split("\n");
  const inputRow = screen.findLastIndex(line => line.trimStart().startsWith("❯"));
  const height = Math.max(34, screen.length);
  while (screen.length < height) screen.push("");
  vi.spyOn(tmux, "captureComposerSnapshot").mockResolvedValue({ screen: screen.join("\n"),
    cursor: { x: inputRow < 0 ? 0 : screen[inputRow]!.length, y: Math.max(0, inputRow), width: 106, height } });
  const now = new Date("2026-10-28T19:00:00Z");
  const eventBus = new EventBus(db), activity = new AgentActivityStore({ db, eventBus });
  const transport = new SessionTransport({ db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    tmuxAdapter: tmux, agentActivityStore: activity, eventBus, now: () => now, sleep: async () => {} });
  return { db, tmux, activity, transport, effects, now };
}

describe("a current Claude dialog vetoes a fresh idle hook", () => {
  it("refuses a recognized permission selector before any input", async () => {
    const f = fixture("Do you want to proceed?\n❯ 1. Yes\n  2. No");
    f.activity.recordHookEvent({ runtime: "claude-code", sessionName: "worker@test", hookEvent: "Stop", occurredAt: f.now.toISOString() });
    expect(await f.transport.send("worker@test", "ordinary wake")).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(f.effects).toEqual([]);
  });
  it.each([composer, "unrecognized transient pane"])("keeps ordinary delivery for a non-dialog pane (%#)", async pane => {
    const f = fixture(pane);
    f.activity.recordHookEvent({ runtime: "claude-code", sessionName: "worker@test", hookEvent: "Stop", occurredAt: f.now.toISOString() });
    expect((await f.transport.send("worker@test", "ordinary message")).ok).toBe(true);
    expect(f.effects.some(effect => effect.kind === "paste")).toBe(true);
  });
  it("does not change the existing veto for a fresh running hook", async () => {
    const f = fixture("Do you want to proceed?\n❯ 1. Yes\n  2. No");
    f.activity.recordHookEvent({ runtime: "claude-code", sessionName: "worker@test", hookEvent: "UserPromptSubmit", occurredAt: f.now.toISOString() });
    expect(await f.transport.send("worker@test", "ordinary wake")).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(f.effects).toEqual([]);
  });
});
