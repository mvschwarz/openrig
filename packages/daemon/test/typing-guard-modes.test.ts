import Database from "better-sqlite3";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, type GuardTarget } from "../src/domain/seat-delivery-guard.js";
import { parseTypingGuardSettings } from "../src/domain/seat-delivery-guard.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { typingGuardModesSchema } from "../src/db/migrations/100_typing_guard_modes.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));

function screen(body: string): ComposerSnapshot {
  const rows = body.split("\n");
  return { screen: ["Ready", "────────────────────", `❯ ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(rows.at(-1)!), y: 1 + rows.length, width: 120, height: 40 }, inMode: false };
}

function fixture() {
  const db = new Database(":memory:"); cleanup.push(() => db.close());
  db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY); INSERT INTO nodes VALUES ('a'),('b');");
  db.exec(outboxEntriesSchema.sql); db.exec(seatDeliveryGuardSchema.sql); db.exec(typingGuardModesSchema.sql);
  const targets: Record<string, GuardTarget> = {
    a: { nodeId: "a", session: "a", occupant: "g1", pane: "%1" },
    b: { nodeId: "b", session: "b", occupant: "g2", pane: "%2" },
  };
  const guard = new SeatDeliveryGuard(db, name => Object.values(targets).find(t => t.nodeId === name || t.session === name || t.pane === name) ?? null);
  const panes: Record<string, ComposerSnapshot | null> = { a: screen(""), b: screen("") };
  const writes: string[] = [];
  let staged = "";
  let onLoad: (() => void) | undefined;
  let renderPaste: ((text: string) => string) | undefined;
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("load-buffer")) onLoad?.();
    if (command.includes("paste-buffer")) {
      const name = command.includes("%2") ? "b" : "a";
      writes.push(`paste:${name}:${staged}`); panes[name] = screen(renderPaste?.(staged) ?? staged);
    }
    if (command.includes("send-keys")) writes.push(command);
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/input", bufferName: () => "fixture-buffer" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => {
    const t = guard.maybeTarget(name);
    return t?.pane ? [{ id: t.pane, index: 0, cwd: "/fixture", width: 120, height: 40, active: true }] : [];
  });
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async name => panes[guard.target(name).nodeId] ?? null);
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "isPaneDead").mockResolvedValue(false);
  return { db, guard, targets, panes, writes, tmux,
    onLoad: (fn: () => void) => { onLoad = fn; }, renderPaste: (fn: (text: string) => string) => { renderPaste = fn; } };
}

describe("typing guard modes", () => {

  it.each(["unchanged", "on", "off", "off-on"])("keeps rollback protection and honors the last legacy write (%s)", async setting => {
    const f = fixture();
    await f.guard.set("a", { mode: "draft-aware" }, "operator", "protect input");
    expect(f.db.prepare("SELECT desired,effective FROM seat_delivery_guards WHERE node_id='a'").get()).toEqual({ desired: 1, effective: 1 });
    f.db.exec("INSERT INTO outbox_entries(outbox_id,sender_session,destination_session,body,delivery_state,ts_dispatched) VALUES ('held','human','a','keep held','retained','fixture'),('uncertain','human','a','keep uncertain','indeterminate','fixture')");
    // Main's boolean writer also audits 1 -> 1. Reuse changed_at deliberately:
    // two writes in one clock tick must still be ordered by the audit row ID.
    const legacySet = (enabled: number) => f.db.transaction(() => {
      const row = f.db.prepare("SELECT desired,effective,changed_at FROM seat_delivery_guards WHERE node_id='a'").get() as { desired: number; effective: number; changed_at: string };
      f.db.prepare("UPDATE seat_delivery_guards SET desired=?,effective=?,actor='legacy',reason='legacy setting' WHERE node_id='a'").run(enabled, enabled);
      f.db.prepare("INSERT INTO seat_delivery_guard_changes(node_id,desired,previous_desired,previous_effective,actor,reason,requested_at,effective_at) VALUES ('a',?,?,?,'legacy','legacy setting',?,?)")
        .run(enabled, row.desired, row.effective, row.changed_at, row.changed_at);
    })();
    if (setting === "on") legacySet(1);
    if (setting === "off") legacySet(0);
    if (setting === "off-on") { legacySet(0); legacySet(1); }
    const reopened = new SeatDeliveryGuard(f.db, name => f.targets[name] ?? null);
    reopened.recoverActivation();
    const expected = setting === "unchanged" ? "draft-aware" : setting === "off" ? "off" : "hold";
    expect(reopened.preference("a")).toMatchObject({ desiredMode: expected, effectiveMode: expected, pending: false });
    if (expected === "hold") await expect(reopened.operation("a", async () => { throw new Error("must not write"); })).rejects.toMatchObject({ code: "typing_guard_enabled" });
    expect(f.db.prepare("SELECT body,delivery_state FROM outbox_entries ORDER BY outbox_id").all()).toEqual([
      { body: "keep held", delivery_state: "retained" }, { body: "keep uncertain", delivery_state: "indeterminate" },
    ]);
    expect(f.writes).toEqual([]);
  });

  it.each(["ordinary request ", "1. Review the change", "2) Review the change"])("submits its exact ordinary text once: %j", async text => {
    const f = fixture(); await f.guard.set("a", { mode: "draft-aware" }, "operator", "preserve draft");
    await f.guard.operation("a", async () => {
      expect(await f.tmux.sendText("a", text)).toEqual({ ok: true });
      expect(await f.tmux.sendKeys("a", ["Enter"])).toEqual({ ok: true });
    });
    expect(f.writes[0]).toBe("paste:a:" + text);
    expect(f.writes.filter(line => line.includes("send-keys"))).toHaveLength(1);
  });

  it.each(["padded", "trimmed"])("uses the cursor to distinguish authored trailing spaces from %s capture cells", async capture => {
    const f = fixture(); await f.guard.set("a", { mode: "draft-aware" }, "operator", "preserve spaces");
    await f.guard.operation("a", async () => {
      expect(await f.tmux.sendText("a", "ordinary request  ")).toEqual({ ok: true });
      const pane = f.panes.a!;
      const lines = pane.screen.split("\n");
      lines[2] = capture === "padded" ? lines[2]!.padEnd(120) : lines[2]!.trimEnd();
      pane.screen = lines.join("\n");
      expect(await f.tmux.sendKeys("a", ["Enter"])).toEqual({ ok: true });
    });
  });

  it("refuses a real numbered menu before any paste and edits to its numbered body after paste", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "draft-aware" }, "operator", "protect menus");
    f.panes.a = screen("1. Approve the command");
    expect(await f.tmux.sendText("a", "1. Review the change")).toMatchObject({ code: "draft_input_unknown" });
    expect(f.writes).toEqual([]);
    f.panes.a = screen("");
    await f.guard.operation("a", async () => {
      expect(await f.tmux.sendText("a", "1. Review the change")).toEqual({ ok: true });
      f.panes.a = screen("1. Review the change with a human edit");
      expect(await f.tmux.sendKeys("a", ["Enter"])).toMatchObject({ ok: false });
    });
    expect(f.writes.filter(line => line.includes("send-keys"))).toHaveLength(0);
  });

  it.each([false, true])("checks several paste placeholders and their literal tail (edited: %s)", async edited => {
    const f = fixture(); await f.guard.set("a", { mode: "draft-aware" }, "operator", "large paste");
    const tail = "This literal tail belongs only to the original message and provides enough visible identity.";
    const text = ["hidden one", "hidden two", "hidden three", "hidden four", tail].join("\n");
    const rendered = "[Pasted text #4 +2 lines]\n[Pasted text #5 +2 lines]\n" + tail;
    f.renderPaste(() => rendered);
    await f.guard.operation("a", async () => {
      expect(await f.tmux.sendText("a", text)).toEqual({ ok: true });
      if (edited) f.panes.a = screen(rendered + " human edit");
      expect(await f.tmux.sendKeys("a", ["Enter"])).toMatchObject({ ok: !edited });
    });
    expect(f.writes.filter(line => line.includes("send-keys"))).toHaveLength(edited ? 0 : 1);
  });

  it("upgrades the existing boolean control and retained outbox without adding any tables", async () => {
    const db = new Database(":memory:"); cleanup.push(() => db.close());
    db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY); INSERT INTO nodes VALUES ('a');");
    db.exec(outboxEntriesSchema.sql); db.exec(seatDeliveryGuardSchema.sql);
    const target = { nodeId: "a", session: "a", occupant: "g1", pane: "%1" };
    const legacy = new SeatDeliveryGuard(db, () => target);
    await legacy.set("a", true, "operator", "existing protection");
    db.exec("INSERT INTO outbox_entries(outbox_id,sender_session,destination_session,body,delivery_state,ts_dispatched) VALUES ('old','human','a','keep these bytes','retained','2026-10-01T00:00:00Z')");
    const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const before = tables();
    db.exec(typingGuardModesSchema.sql);
    expect(tables()).toEqual(before);
    const upgraded = new SeatDeliveryGuard(db, () => target);
    upgraded.recoverActivation();
    expect(upgraded.preference("a")).toMatchObject({ desired: true, effective: true, desiredMode: "hold", effectiveMode: "hold", pending: false });
    expect(db.prepare("SELECT body,delivery_state,guard_delivery FROM outbox_entries WHERE outbox_id='old'").get())
      .toEqual({ body: "keep these bytes", delivery_state: "retained", guard_delivery: null });
    await upgraded.set("a", { mode: "draft-aware" }, "operator", "wait for clear input");
    await upgraded.set("a", false, "operator", "legacy off");
    expect(upgraded.preference("a")).toMatchObject({ effective: false, effectiveMode: "off" });
    await upgraded.set("a", true, "operator", "legacy hold");
    expect(upgraded.preference("a")).toMatchObject({ effective: true, effectiveMode: "hold" });
    expect(db.prepare("SELECT count(*) n FROM seat_delivery_guards").get()).toEqual({ n: 1 });
  });

  it("does not treat an adopted existing pane as a newly created lifecycle shell", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "draft-aware" }, "operator", "keep my draft");
    f.targets.a = { ...f.targets.a!, pane: null };
    await f.guard.lifecycle(["a"], async () => {
      f.targets.a = { ...f.targets.a!, pane: "%3", occupant: "adopted" };
      f.guard.rebindLifecycle("a");
      f.panes.a = screen("existing human draft");
      expect(await f.tmux.sendText("a", "adoption hint")).toMatchObject({ ok: false, code: "draft_input_busy" });
      expect(await f.tmux.sendKeys("a", ["Enter"])).toMatchObject({ ok: false, code: "draft_input_changed" });
    });
    expect(f.writes).toEqual([]);
  });

  it("holds literal placeholder text when the operator moved the cursor to its start", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "draft-aware" }, "operator", "keep my draft");
    const draft = screen("Ask Codex to do anything"); draft.cursor.x = 2;
    f.panes.a = draft;
    expect(await f.tmux.sendText("a", "message")).toMatchObject({ ok: false, code: "draft_input_busy" });
    expect(f.writes).toEqual([]);
  });
  it("defaults off and rejects invalid modes and obsolete retry settings", () => {
    const f = fixture();
    expect(f.guard.configuration("a").effective.mode).toBe("off");
    expect(parseTypingGuardSettings({ mode: "draft-aware" })).toEqual({ mode: "draft-aware" });
    for (const input of [{ mode: "typo" }, { mode: "draft-aware", holdSeconds: 0 }, { mode: "draft-aware", holdSeconds: Infinity },
      { mode: "draft-aware", holdSeconds: 3601 }, { mode: "draft-aware", holdSeconds: null },
      { mode: "draft-aware", maxAttempts: null }, { mode: "draft-aware", maxAttempts: 1.5 }, { mode: "draft-aware", maxAttempts: 101 }]) {
      expect(() => parseTypingGuardSettings(input)).toThrow();
    }
  });

  it("activates after the existing operation, survives restart and keeps same-setting activation idempotent", async () => {
    const f = fixture(); let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const operation = f.guard.operation("a", async () => { entered(); await held; });
    await started;
    const pending = await f.guard.set("a", { mode: "draft-aware" }, "operator", "protect my input", 1);
    expect(pending).toMatchObject({ desiredMode: "draft-aware", effectiveMode: "off", pending: true });
    release(); await operation; await new Promise(resolve => setTimeout(resolve, 0));
    const active = f.guard.configuration("a");
    expect(f.guard.preference("a")).toMatchObject({ effectiveMode: "draft-aware", pending: false });
    await f.guard.set("a", { mode: "draft-aware" }, "operator", "same preference");
    expect(f.guard.configuration("a").effective.revision).toBe(active.effective.revision);

    const desired = { ...active.desired, mode: "hold", revision: "restart-activation" };
    f.db.prepare("UPDATE seat_delivery_guards SET desired=1,desired_config=? WHERE node_id='a'").run(JSON.stringify(desired));
    f.db.prepare("UPDATE seat_delivery_guard_changes SET desired_config=? WHERE id=(SELECT max(id) FROM seat_delivery_guard_changes)").run(JSON.stringify(desired));
    f.guard.recoverActivation();
    expect(f.guard.preference("a")).toMatchObject({ desired: true, effective: true, effectiveMode: "hold", pending: false });
  });

  it("hold mode prevents raw automatic input but preserves human input and siblings", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "hold" }, "operator", "manual terminal");
    expect(await f.tmux.sendText("a", "automatic")).toMatchObject({ ok: false, code: "typing_guard_enabled" });
    expect(f.writes).toEqual([]);
    expect(await f.tmux.humanInput("a", () => f.tmux.sendText("a", "human"))).toEqual({ ok: true });
    expect(await f.tmux.sendText("b", "sibling")).toEqual({ ok: true });
    expect(f.writes).toEqual(["paste:a:human", "paste:b:sibling"]);
  });

  it("observes the draft after buffer preparation and never pastes on unreadable input", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "draft-aware" }, "operator", "keep my draft");
    f.onLoad(() => { f.panes.a = screen("a draft appeared during file preparation"); });
    expect(await f.tmux.sendText("a", "message")).toMatchObject({ ok: false, code: "draft_input_busy" });
    expect(f.writes).toEqual([]);
    f.onLoad(() => { f.panes.a = null; });
    expect(await f.tmux.sendText("a", "message")).toMatchObject({ ok: false, code: "draft_input_unknown" });
    expect(f.writes).toEqual([]);
  });

  it("submits owned text once and refuses a draft that appears before Enter", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "draft-aware" }, "operator", "keep my draft");
    await f.guard.operation("a", async () => {
      expect(await f.tmux.sendText("a", "first message")).toEqual({ ok: true });
      expect(await f.tmux.sendKeys("a", ["Enter"])).toEqual({ ok: true });
    });
    f.panes.a = screen("");
    await f.guard.operation("a", async () => {
      expect(await f.tmux.sendText("a", "second message")).toEqual({ ok: true });
      f.panes.a = screen("second message and an unfinished human input");
      expect(await f.tmux.sendKeys("a", ["Enter"])).toMatchObject({ ok: false, code: "draft_input_changed" });
    });
    expect(f.writes.filter(line => line.includes("send-keys"))).toHaveLength(1);
  });

  it("remembers only the opaque paste observed by this lease and rejects a replacement label", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "draft-aware" }, "operator", "keep my draft");
    f.renderPaste(() => "[Pasted text #4 +2 lines]");
    await f.guard.operation("a", async () => {
      expect(await f.tmux.sendText("a", "one\ntwo\nthree")).toEqual({ ok: true });
      f.panes.a = screen("[Pasted text #5 +2 lines]");
      expect(await f.tmux.sendKeys("a", ["Enter"])).toMatchObject({ ok: false, code: "draft_input_changed" });
    });
    expect(f.writes.filter(line => line.includes("send-keys"))).toHaveLength(0);
  });

  it("a brokered human action invalidates the automatic submission even if the visible text is unchanged", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "draft-aware" }, "operator", "keep my draft");
    await f.guard.operation("a", async () => {
      expect(await f.tmux.sendText("a", "owned")).toEqual({ ok: true });
      await f.guard.humanInput("a", async () => {});
      expect(await f.tmux.sendKeys("a", ["Enter"])).toMatchObject({ ok: false, code: "draft_input_changed" });
    });
    expect(f.writes.filter(line => line.includes("send-keys"))).toHaveLength(0);
  });

  it("refuses lifecycle effects on an active protected seat but permits a fresh, owned launch", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "draft-aware" }, "operator", "keep my draft");
    let effects = 0;
    await expect(f.guard.lifecycle(["a"], async () => { effects++; })).rejects.toMatchObject({ code: "draft_aware_lifecycle" });
    expect(effects).toBe(0);
    f.targets.a = { ...f.targets.a!, pane: null };
    await f.guard.lifecycle(["a"], async () => {
      vi.mocked(f.tmux.listPanes).mockResolvedValueOnce([{ id: "%3", index: 0, cwd: "/fixture", width: 120, height: 40, active: true }]);
      expect(await f.tmux.createSession("a", undefined, { OPENRIG_NODE_ID: "a" })).toEqual({ ok: true });
      f.targets.a = { ...f.targets.a!, pane: "%3", occupant: "new" };
      f.guard.rebindLifecycle("a");
      f.panes.a = null;
      expect(await f.tmux.sendText("a", "launch the runtime")).toEqual({ ok: true });
      expect(await f.tmux.sendKeys("a", ["Enter"])).toEqual({ ok: true });
    });
    expect(f.writes).toHaveLength(2);
  });

  it("grants startup input only after a dead pane was successfully respawned", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "draft-aware" }, "operator", "protect resumed input");
    vi.mocked(f.tmux.isPaneDead).mockResolvedValue(true); f.panes.a = null;
    await f.guard.lifecycle(["a"], async () => {
      expect(await f.tmux.sendText("a", "premature input")).toMatchObject({ ok: false, code: "draft_input_unknown" });
      expect(await f.tmux.respawnPane("%1", "/bin/sh")).toEqual({ ok: true });
      expect(await f.tmux.sendText("a", "launch the runtime")).toEqual({ ok: true });
      expect(await f.tmux.sendKeys("a", ["Enter"])).toEqual({ ok: true });
    });
    expect(f.writes).toHaveLength(2);
  });
});
