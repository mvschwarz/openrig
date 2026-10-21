// Operating modes for a person: save a mode, apply it, end it. Through the real gateway routes with a temp home (the
// human registry's fragments), a real SQLite schema and an injected clock; the service directly where a writer has to
// fail. Ending a mode undoes only what is still its own: a later choice of the person's stays.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { addHumanFragment, readHumanAvailability, removeHumanFragment, setHumanField } from "../src/domain/gateway/human-registry.js";
import { HumanModeService, registryAvailability, type AvailabilityAccess } from "../src/domain/gateway/human-operating-modes.js";
import { HumanQuietStore } from "../src/domain/gateway/human-quiet-windows.js";
import { RigModeStore } from "../src/domain/rig-mode/rig-mode-store.js";
import type { OperatorContextModeRecord } from "../src/domain/rig-mode/rig-mode-types.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const person = (entityId: string, prefs: Record<string, unknown> = { deliveryClass: "B" }) => ({
  entityId, class: "human", displayName: entityId, address: `${entityId}@external`, prefs,
  connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://fixture", role: "primary", handle: `U-${entityId.toUpperCase()}` }],
});

function fixture(startIso = "2026-10-20T21:00:00Z", db: Database.Database = createFullTestDb(), home?: string) {
  if (!home) {
    home = mkdtempSync(join(tmpdir(), "modes-route-")); homes.push(home);
    expect(addHumanFragment(person("alex", { deliveryClass: "B", availability: "available" }), home).ok).toBe(true);
    expect(addHumanFragment(person("sam"), home).ok).toBe(true);
  }
  const clock = { now: new Date(startIso) };
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("db" as never, db as never); await next(); });
  app.route("/api/gateway", gatewayRoutes({ home, now: () => clock.now }));
  const call = async (method: string, path: string, body?: unknown, session = "operator@kernel") => {
    const res = await app.request(`/api/gateway/human/${path}`, { method,
      headers: { "Content-Type": "application/json", ...(session ? { "X-OpenRig-Session": session } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const availability = (entityId = "alex") => { const r = readHumanAvailability(entityId, home); return r.ok ? r.availability : `unreadable: ${r.error}`; };
  const quiet = new HumanQuietStore(db);
  return { db, home, clock, call, availability, quiet };
}

const asleep = { availability: "away", expectedBack: "07:00", decisionRoom: "decide my usual asks", exclusions: ["publishing", "spending", "accounts"],
  quiet: "until-end", timezone: "UTC", account: "slack" };
const stateOf = (application: Record<string, any>, consumer: string) =>
  (application.effects as Array<Record<string, any>>).find((e) => e.consumer === consumer)?.state;

describe("saved modes", () => {
  it("a saved mode reads back as agreed, and saving one person's mode leaves another's settings alone", async () => {
    const f = fixture();
    await f.call("PUT", "sam/modes/asleep", { availability: "off", timezone: "UTC" });
    const saved = await f.call("PUT", "alex/modes/Asleep", asleep);
    expect(saved).toMatchObject({ status: 200, body: { mode: { entityId: "alex", name: "asleep",
      availability: { value: "away", expectedBack: "07:00" },
      decisionRoom: { words: "decide my usual asks", exclusions: ["publishing", "spending", "accounts"] },
      delivery: { quiet: { kind: "until-end", timezone: "UTC" }, account: "slack" }, setBy: "operator@kernel" } } });
    expect((await f.call("GET", "alex/modes/asleep")).body.mode).toEqual(saved.body.mode);
    expect((await f.call("GET", "sam/modes/asleep")).body.mode).toMatchObject({ availability: { value: "off" }, decisionRoom: null });
    expect(f.availability("sam")).toBeUndefined(); // saving touches nothing outside the saved row
  });

  it("no decision room is inferred: a mode named asleep with none stated has none, and applying it adds no room", async () => {
    const f = fixture();
    const saved = await f.call("PUT", "alex/modes/asleep", { availability: "away", timezone: "UTC" });
    expect(saved.body.mode.decisionRoom).toBeNull();
    const applied = await f.call("POST", "alex/modes/asleep/apply", {});
    expect(applied.body.application.settings.decisionRoom).toBeNull();
    expect(stateOf(applied.body.application, "decision-room")).toBeUndefined();
  });
});

describe("applying and ending a mode", () => {
  it("applying shows each effect active; a normal end ends each one and restores what was there before", async () => {
    const f = fixture();
    f.quiet.setDaily("alex", { start: "23:00", end: "06:00", timezone: "UTC", setBy: "alex", now: f.clock.now });
    await f.call("PUT", "alex/modes/asleep", asleep);
    const applied = await f.call("POST", "alex/modes/asleep/apply", { until: "07:00", timezone: "UTC" });
    expect(applied.status).toBe(200);
    const app = applied.body.application;
    expect(app).toMatchObject({ modeName: "asleep", scheduledEnd: "2026-10-21T07:00:00.000Z", endedAt: null });
    expect(app.effects.map((e: Record<string, any>) => [e.consumer, e.state])).toEqual([["availability", "active"], ["decision-room", "active"], ["quiet", "active"]]);
    expect(f.availability()).toBe("away");
    expect(f.quiet.show("alex")).toMatchObject({ kind: "until", until: "2026-10-21T07:00:00.000Z", source: `mode-application:${app.applicationId}` });
    expect((await f.call("GET", "alex/mode")).body).toMatchObject({ atDesk: false, current: { applicationId: app.applicationId } });

    f.clock.now = new Date("2026-10-21T05:30:00Z");
    const ended = await f.call("POST", "alex/mode/end", {});
    expect(ended.body).toMatchObject({ atDesk: true, ended: { endReason: "back", endedBy: "operator@kernel" } });
    expect(ended.body.ended.effects.map((e: Record<string, any>) => [e.consumer, e.state])).toEqual([["availability", "ended"], ["decision-room", "ended"], ["quiet", "ended"]]);
    expect(f.availability()).toBe("available");
    expect(f.quiet.show("alex")).toMatchObject({ kind: "daily", start: "23:00", end: "06:00", source: "manual", setBy: "operator@kernel" });
    expect((await f.call("GET", "alex/mode")).body).toMatchObject({ atDesk: true, current: null });
  });

  it("the manual-choice case: quiet extended by hand stays; availability is restored; the decision room ends", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/asleep", asleep);
    const app = (await f.call("POST", "alex/modes/asleep/apply", { until: "07:00", timezone: "UTC" })).body.application;
    expect((await f.call("PUT", "alex/quiet", { until: "2026-10-21T09:00:00Z", timezone: "UTC" }, "alex")).status).toBe(200); // by hand
    const ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(stateOf(ended, "quiet")).toBe("kept");
    expect(stateOf(ended, "availability")).toBe("ended");
    expect(stateOf(ended, "decision-room")).toBe("ended");
    expect(f.quiet.show("alex")).toMatchObject({ until: "2026-10-21T09:00:00.000Z", source: "manual", setBy: "alex" }); // still extended
    expect(f.availability()).toBe("available");
    expect(app.applicationId).toBe(ended.applicationId);
  });

  it("availability changed by hand since the mode started is kept", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/asleep", asleep);
    await f.call("POST", "alex/modes/asleep/apply", { until: "07:00", timezone: "UTC" });
    expect(setHumanField("alex", "availability", "focus", f.home).ok).toBe(true);
    const ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(stateOf(ended, "availability")).toBe("kept");
    expect(stateOf(ended, "quiet")).toBe("ended");
    expect(f.availability()).toBe("focus");
  });

  it("review F4: an 'I'm back' the person left on an earlier night of a daily mode doesn't switch tonight off", async () => {
    const f = fixture("2026-10-19T21:00:00Z");
    f.quiet.setDaily("alex", { start: "20:30", end: "07:00", timezone: "UTC", setBy: "alex", now: f.clock.now });
    await f.call("PUT", "alex/modes/asleep", { availability: "away", quiet: "20:00-08:00", timezone: "UTC" });
    await f.call("POST", "alex/modes/asleep/apply", {});
    expect((await f.call("POST", "alex/quiet/end", {}, "alex")).status).toBe(200); // last night, by hand
    f.clock.now = new Date("2026-10-20T21:30:00Z"); // the next night
    const ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(stateOf(ended, "quiet")).toBe("ended");
    expect(ended.effects.find((e: Record<string, any>) => e.consumer === "quiet").detail).not.toMatch(/tonight stays off/);
    expect(f.quiet.quietStateFor("alex", f.clock.now).active, "tonight's quiet is on, as the restored rule says").toBe(true);
  });

  it("review F1: away by the mode, then focus and away again by hand: the same value, but a later change of theirs, so kept", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/away-from-desk", { availability: "away" });
    await f.call("POST", "alex/modes/away-from-desk/apply", {});
    expect(setHumanField("alex", "availability", "focus", f.home).ok).toBe(true);
    expect(setHumanField("alex", "availability", "away", f.home).ok).toBe(true);
    const ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(stateOf(ended, "availability")).toBe("kept");
    expect(f.availability()).toBe("away");
  });

  it("review F1: removing a person drops their change record, so a re-add never inherits an old change id", () => {
    const f = fixture();
    const before = readHumanAvailability("sam", f.home);
    expect(before).toMatchObject({ ok: true, changeId: expect.any(String) });
    expect(removeHumanFragment("sam", { inflight: [] }, f.home).ok).toBe(true);
    expect(addHumanFragment(person("sam"), f.home).ok).toBe(true);
    const after = readHumanAvailability("sam", f.home);
    expect(after).toMatchObject({ ok: true, changeId: expect.any(String) });
    expect((after as { changeId: string }).changeId).not.toBe((before as { changeId: string }).changeId);
  });

  it("review F4: a prior occurrence the person had ended before the mode stays ended when the prior rule is restored", async () => {
    const f = fixture(); // 21:00 UTC
    f.quiet.setDaily("alex", { start: "20:00", end: "08:00", timezone: "UTC", setBy: "alex", now: f.clock.now });
    f.quiet.end("alex", { endedBy: "alex", now: f.clock.now }); // "I'm back" for tonight, before any mode
    await f.call("PUT", "alex/modes/asleep", { availability: "away", quiet: "23:00-06:00", timezone: "UTC" });
    await f.call("POST", "alex/modes/asleep/apply", {});
    f.clock.now = new Date("2026-10-20T22:00:00Z");
    const ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(stateOf(ended, "quiet")).toBe("ended");
    expect(f.quiet.show("alex")).toMatchObject({ kind: "daily", start: "20:00", end: "08:00", source: "manual", ended: { occurrence: "2026-10-20", by: "alex" } });
    expect(f.quiet.quietStateFor("alex", f.clock.now).active, "tonight doesn't start again").toBe(false);
  });

  it("review F4: a manual quiet end during the mode carries across: the prior rule is restored, tonight stays off, the mode's window is gone", async () => {
    const f = fixture(); // 21:00 UTC
    f.quiet.setDaily("alex", { start: "20:30", end: "07:00", timezone: "UTC", setBy: "alex", now: f.clock.now });
    await f.call("PUT", "alex/modes/asleep", { availability: "away", quiet: "20:00-08:00", timezone: "UTC" });
    const app = (await f.call("POST", "alex/modes/asleep/apply", {})).body.application;
    expect(f.quiet.quietStateFor("alex", f.clock.now).active).toBe(true);
    expect((await f.call("POST", "alex/quiet/end", {}, "alex")).status).toBe(200); // the person's own "I'm back" for tonight
    f.clock.now = new Date("2026-10-20T21:30:00Z");
    const ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    const quietEffect = ended.effects.find((e: Record<string, any>) => e.consumer === "quiet");
    expect(quietEffect).toMatchObject({ state: "ended", detail: expect.stringMatching(/restored the daily quiet hours 20:30-07:00 UTC .*; tonight stays off, as you set it$/) });
    const window = f.quiet.show("alex")!;
    expect(window).toMatchObject({ kind: "daily", start: "20:30", end: "07:00", source: "manual", ended: { by: "alex" } });
    expect(window.source).not.toBe(`mode-application:${app.applicationId}`);
    expect(f.quiet.quietStateFor("alex", f.clock.now).active, "quiet is off now").toBe(false);
  });

  it("review R3-1: `away` set during a mode while availability is authored changes nothing, so ending still restores", async () => {
    const f = fixture(); // alex: available
    await f.call("PUT", "alex/modes/away-from-desk", { availability: "away" });
    await f.call("POST", "alex/modes/away-from-desk/apply", {});
    expect(setHumanField("alex", "away", "true", f.home).ok).toBe(true); // agrees with availability away: no change
    let ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(stateOf(ended, "availability")).toBe("ended");
    expect(f.availability()).toBe("available");
    await f.call("PUT", "alex/modes/out-of-office", { availability: "off" });
    await f.call("POST", "alex/modes/out-of-office/apply", {});
    expect(setHumanField("alex", "away", "false", f.home).ok).toBe(true); // also no change to availability
    ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(stateOf(ended, "availability")).toBe("ended");
    expect(f.availability()).toBe("available");
  });

  // Round 4 (F5): the legacy away flag, as the person's record has it.
  const awayFlag = (home: string, id: string) => (readHumanAvailability(id, home) as { away: boolean }).away;

  it("review F5: a legacy away the person had before the mode stays: still away after it ends, and the report says so", async () => {
    const f = fixture();
    expect(addHumanFragment(person("kim", { deliveryClass: "B", away: true }), f.home).ok).toBe(true);
    await f.call("PUT", "kim/modes/away-from-desk", { availability: "away" });
    const app = (await f.call("POST", "kim/modes/away-from-desk/apply", {})).body.application;
    expect(app.effects[0]).toMatchObject({ consumer: "availability", state: "active", prior: { availability: null, away: true } });
    const ended = (await f.call("POST", "kim/mode/end", {})).body.ended;
    expect(ended.effects[0]).toMatchObject({ state: "ended", detail: "restored to not set; away stays on, as it was before the mode" });
    expect(f.availability("kim")).toBeUndefined();
    expect(awayFlag(f.home, "kim")).toBe(true);
  });

  it("review F5: an away flag set during the mode, over nothing authored before, is cleared: available again", async () => {
    const f = fixture(); // sam: no availability, no flag
    await f.call("PUT", "sam/modes/away-from-desk", { availability: "away" });
    await f.call("POST", "sam/modes/away-from-desk/apply", {});
    expect(setHumanField("sam", "away", "true", f.home).ok).toBe(true);
    const ended = (await f.call("POST", "sam/mode/end", {})).body.ended;
    expect(ended.effects[0]).toMatchObject({ state: "ended", detail: "restored to not set; the away flag set during it is cleared" });
    expect(f.availability("sam")).toBeUndefined();
    expect(awayFlag(f.home, "sam")).toBe(false);
  });

  it("review F5: R3-1 unchanged: an authored prior, away set during the mode, cleared and the prior restored", async () => {
    const f = fixture(); // alex: available
    await f.call("PUT", "alex/modes/away-from-desk", { availability: "away" });
    await f.call("POST", "alex/modes/away-from-desk/apply", {});
    expect(setHumanField("alex", "away", "true", f.home).ok).toBe(true);
    const ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(stateOf(ended, "availability")).toBe("ended");
    expect(f.availability()).toBe("available");
    expect(awayFlag(f.home, "alex")).toBe(false);
  });

  it("review F5: a restore handed off at a switch carries the person's own away flag too", async () => {
    const f = fixture();
    expect(addHumanFragment(person("kim", { deliveryClass: "B", away: true }), f.home).ok).toBe(true);
    const real = registryAvailability(f.home);
    let failReads = 0;
    const modes = new HumanModeService({ db: f.db, now: () => f.clock.now,
      availability: { ...real, read: (id) => (failReads-- > 0 ? { ok: false, error: "registry unreadable (test)" } : real.read(id)) } });
    modes.save("kim", { name: "away-from-desk", availability: { value: "away" } }, "op");
    modes.save("kim", { name: "out-of-office", availability: { value: "away", expectedBack: "Monday" } }, "op");
    const first = modes.apply("kim", "away-from-desk", {}, "op").application!;
    failReads = 1; // the switch's end can't read the registry: the restore is owed, then handed off
    const second = modes.apply("kim", "out-of-office", {}, "op").application!;
    expect(second.effects[0]).toMatchObject({ state: "active", prior: { availability: null, away: true } });
    expect(stateOf(modes.get(first.applicationId)!, "availability")).toBe("handed-off");
    modes.end("kim", "back", "op");
    expect(f.availability("kim")).toBeUndefined();
    expect(awayFlag(f.home, "kim")).toBe(true);
  });

  it("review R5-1: an away flag the person turned off during the mode is their choice: available after it ends, and the report says so", async () => {
    const f = fixture();
    expect(addHumanFragment(person("kim", { deliveryClass: "B", away: true }), f.home).ok).toBe(true);
    await f.call("PUT", "kim/modes/away-from-desk", { availability: "away" });
    await f.call("POST", "kim/modes/away-from-desk/apply", {});
    expect(setHumanField("kim", "away", "false", f.home).ok).toBe(true); // "I'm back", during the mode
    const ended = (await f.call("POST", "kim/mode/end", {})).body.ended;
    expect(ended.effects[0]).toMatchObject({ state: "ended", detail: "restored to not set; away was turned off during the mode; that choice stands" });
    expect(f.availability("kim")).toBeUndefined();
    expect(awayFlag(f.home, "kim")).toBe(false); // so available
  });

  it("review F6: a restore write that saved but failed to re-project is finished by the retry, unless the person changed it first", async () => {
    const f = fixture(); // alex: available
    const real = registryAvailability(f.home);
    let failRestore = true;
    const modes = new HumanModeService({ db: f.db, now: () => f.clock.now, availability: { ...real, write: (id, value) => {
      const res = real.write(id, value);
      if (value === "available" && failRestore && res.ok) {
        failRestore = false;
        return { ok: false, error: "fragment written but re-projection failed: disk full (test)", changeId: res.changeId };
      }
      return res;
    } } });
    modes.save("alex", { name: "away-from-desk", availability: { value: "away" } }, "op");
    const app = modes.apply("alex", "away-from-desk", {}, "op").application!;
    const first = modes.end("alex", "back", "op")!;
    expect(first.effects[0]).toMatchObject({ state: "failed", changeIdentity: { availability: "available" } });
    modes.end("alex", "back", "op"); // the projection works again
    expect(stateOf(modes.get(app.applicationId)!, "availability")).toBe("ended");
    expect(f.availability()).toBe("available");
    expect(modes.unresolved("alex")).toEqual([]);
    const again = modes.apply("alex", "away-from-desk", {}, "op").application!;
    failRestore = true;
    modes.end("alex", "back", "op"); // partial again
    expect(setHumanField("alex", "availability", "focus", f.home).ok).toBe(true); // by hand, before the retry
    modes.end("alex", "back", "op");
    expect(stateOf(modes.get(again.applicationId)!, "availability")).toBe("kept");
    expect(f.availability()).toBe("focus");
  });

  it("review F7: a partial restore to not set, ended by a switch, is handed off to the next mode, not taken for a manual change", async () => {
    const f = fixture(); // sam: nothing authored
    const real = registryAvailability(f.home);
    let failRestore = true; // the switch's restore to not set saves but doesn't re-project
    const modes = new HumanModeService({ db: f.db, now: () => f.clock.now, availability: { ...real, write: (id, value) => {
      const res = real.write(id, value);
      if (value === "unset" && failRestore && res.ok) {
        failRestore = false;
        return { ok: false, error: "fragment written but re-projection failed: disk full (test)", changeId: res.changeId };
      }
      return res;
    } } });
    modes.save("sam", { name: "away-from-desk", availability: { value: "away" } }, "op");
    modes.save("sam", { name: "out-of-office", availability: { value: "away", expectedBack: "Monday" } }, "op");
    const first = modes.apply("sam", "away-from-desk", {}, "op").application!;
    const second = modes.apply("sam", "out-of-office", {}, "op").application!; // the switch's end: partial restore
    expect(second.effects[0]).toMatchObject({ state: "active", prior: { availability: null, away: false } });
    expect(stateOf(modes.get(first.applicationId)!, "availability")).toBe("handed-off");
    modes.end("sam", "back", "op"); // recovered
    expect(stateOf(modes.get(first.applicationId)!, "availability")).toBe("handed-off");
    expect(stateOf(modes.get(second.applicationId)!, "availability")).toBe("ended");
    expect(f.availability("sam")).toBeUndefined();
    expect(modes.unresolved("sam")).toEqual([]);
  });

  it("review R3-1: with no availability authored, `away` is the person's availability, so setting it is a change", () => {
    const f = fixture();
    const before = readHumanAvailability("sam", f.home) as { changeId: string };
    expect(setHumanField("sam", "away", "true", f.home).ok).toBe(true);
    expect((readHumanAvailability("sam", f.home) as { changeId: string }).changeId).not.toBe(before.changeId);
  });

  it("review R3-2: the person's end carries by time across rules: a daily mode over a prior until-window, ended by hand, stays off", async () => {
    const f = fixture("2026-10-20T20:30:00Z");
    f.quiet.setUntil("alex", { until: new Date("2026-10-20T23:00:00Z"), timezone: "UTC", setBy: "alex", now: f.clock.now });
    f.clock.now = new Date("2026-10-20T21:00:00Z");
    await f.call("PUT", "alex/modes/asleep", { availability: "away", quiet: "20:00-08:00", timezone: "UTC" });
    await f.call("POST", "alex/modes/asleep/apply", {});
    f.clock.now = new Date("2026-10-20T21:15:00Z");
    expect((await f.call("POST", "alex/quiet/end", {}, "alex")).status).toBe(200); // the mode's occurrence 2026-10-20
    f.clock.now = new Date("2026-10-20T21:30:00Z");
    const ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(ended.effects.find((e: Record<string, any>) => e.consumer === "quiet").detail).toMatch(/restored quiet hours until .*; tonight stays off, as you set it$/);
    expect(f.quiet.show("alex")).toMatchObject({ kind: "until", until: "2026-10-20T23:00:00.000Z", ended: { occurrence: "until", by: "alex" } });
    expect(f.quiet.quietStateFor("alex", f.clock.now).active).toBe(false);
  });

  it("review R3-2: a mark from before the restored occurrence began doesn't carry, even across rules", async () => {
    const f = fixture("2026-10-20T18:30:00Z");
    f.quiet.setDaily("alex", { start: "20:00", end: "08:00", timezone: "UTC", setBy: "alex", now: f.clock.now });
    await f.call("PUT", "alex/modes/away-from-desk", { availability: "away", quiet: "until-end", timezone: "UTC" });
    await f.call("POST", "alex/modes/away-from-desk/apply", { until: "23:30", timezone: "UTC" });
    f.clock.now = new Date("2026-10-20T19:00:00Z");
    expect((await f.call("POST", "alex/quiet/end", {}, "alex")).status).toBe(200); // ended the mode's quiet at 19:00
    f.clock.now = new Date("2026-10-20T21:30:00Z");
    const ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(ended.effects.find((e: Record<string, any>) => e.consumer === "quiet").detail).not.toMatch(/tonight stays off/);
    expect(f.quiet.quietStateFor("alex", f.clock.now).active, "tonight's 20:00 occurrence began after that mark").toBe(true);
  });

  it("review R3-3: a manual write landing between the mode's write and its record isn't taken for the mode's; it's kept", async () => {
    const f = fixture();
    const real = registryAvailability(f.home);
    let first = true;
    const modes = new HumanModeService({ db: f.db, now: () => f.clock.now, availability: { read: real.read, write: (id, value) => {
      const res = real.write(id, value);
      if (first) { first = false; expect(setHumanField(id, "availability", "focus", f.home).ok).toBe(true); } // by hand, right after
      return res;
    } } });
    modes.save("alex", { name: "away-from-desk", availability: { value: "away" } }, "op");
    modes.apply("alex", "away-from-desk", {}, "op");
    const ended = modes.end("alex", "back", "op")!;
    expect(stateOf(ended, "availability")).toBe("kept");
    expect(f.availability()).toBe("focus");
  });

  it("an availability that wasn't authored before the mode is unauthored again after it", async () => {
    const f = fixture();
    await f.call("PUT", "sam/modes/away-from-desk", { availability: "away", timezone: "UTC" });
    await f.call("POST", "sam/modes/away-from-desk/apply", {});
    expect(f.availability("sam")).toBe("away");
    await f.call("POST", "sam/mode/end", {});
    expect(f.availability("sam")).toBeUndefined();
    expect(readFileSync(join(f.home, "gateway", "humans", "sam.yaml"), "utf8")).not.toMatch(/availability/);
  });

  it("switching mode ends the first with reason switched; at desk ends the current one and applies nothing", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/away-from-desk", { availability: "away", timezone: "UTC" });
    await f.call("PUT", "alex/modes/out-of-office", { availability: "off", expectedBack: "Monday", timezone: "UTC" });
    const first = (await f.call("POST", "alex/modes/away-from-desk/apply", {})).body.application;
    const second = await f.call("POST", "alex/modes/out-of-office/apply", {});
    expect(second.body.ended).toMatchObject({ applicationId: first.applicationId, endReason: "switched" });
    expect(f.availability()).toBe("off");
    const desk = await f.call("POST", "alex/modes/at desk/apply", {});
    expect(desk.body).toMatchObject({ atDesk: true, application: null, ended: { modeName: "out-of-office", endReason: "back" } });
    expect(f.availability()).toBe("available");
    expect((await f.call("POST", "alex/modes/at-desk/apply", {})).body).toMatchObject({ atDesk: true, application: null, ended: null });
    expect((await f.call("PUT", "alex/modes/at-desk", { availability: "available", timezone: "UTC" })).status).toBe(400);
  });

  it("a mode whose quiet hours run until it ends needs an end time; without one nothing is applied", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/asleep", asleep);
    const refused = await f.call("POST", "alex/modes/asleep/apply", {});
    expect(refused).toMatchObject({ status: 400, body: { error: "end_required" } });
    expect(f.availability()).toBe("available");
    expect(f.quiet.show("alex")).toBeNull();
    expect((await f.call("GET", "alex/mode")).body.current).toBeNull();
  });

  it("a scheduled end is recorded as such", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/asleep", asleep);
    await f.call("POST", "alex/modes/asleep/apply", { until: "07:00", timezone: "UTC" });
    expect((await f.call("POST", "alex/mode/end", { reason: "scheduled" })).body.ended).toMatchObject({ endReason: "scheduled" });
  });

  it("the application and its effects survive a restart, and ending after it works", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/asleep", asleep);
    const app = (await f.call("POST", "alex/modes/asleep/apply", { until: "07:00", timezone: "UTC" })).body.application;
    const after = fixture("2026-10-21T01:00:00Z", f.db, f.home); // a new route stack over the same database and home
    const current = (await after.call("GET", "alex/mode")).body.current;
    expect(current).toMatchObject({ applicationId: app.applicationId, effects: app.effects });
    const ended = (await after.call("POST", "alex/mode/end", {})).body.ended;
    expect(ended.effects.every((e: Record<string, any>) => e.state === "ended")).toBe(true);
  });
});

describe("effects that fail or can't be checked", () => {
  function service(f: ReturnType<typeof fixture>, availability: AvailabilityAccess) {
    return new HumanModeService({ db: f.db, availability, now: () => f.clock.now });
  }

  it("a writer that fails when the mode starts makes that effect failed, not active; the others still apply", async () => {
    const f = fixture();
    const real = registryAvailability(f.home);
    const modes = service(f, { read: real.read, write: () => ({ ok: false, error: "registry is read-only (test)" }) });
    modes.save("alex", { name: "asleep", availability: { value: "away" }, delivery: { quiet: { kind: "daily", start: "22:00", end: "07:00", timezone: "UTC" }, account: null } }, "op");
    const app = modes.apply("alex", "asleep", {}, "op").application!;
    expect(stateOf(app, "availability")).toBe("failed");
    expect(stateOf(app, "quiet")).toBe("active");
    expect(f.availability()).toBe("available");
    const ended = modes.end("alex", "back", "op")!;
    expect(stateOf(ended, "availability")).toBe("ended"); // it never took effect, so nothing to undo
    expect(stateOf(ended, "quiet")).toBe("ended");
  });

  it("QA F1: a quiet read that throws during apply fails only the quiet effect; the others are recorded, and ending works", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/asleep", { ...asleep, quiet: "22:00-07:00" });
    const show = vi.spyOn(HumanQuietStore.prototype, "show").mockImplementationOnce(() => { throw new Error("database is locked (test)"); });
    let applied: Awaited<ReturnType<typeof f.call>>;
    try { applied = await f.call("POST", "alex/modes/asleep/apply", {}); } finally { show.mockRestore(); }
    expect(applied.status).toBe(200);
    const app = applied.body.application;
    expect(app.effects.map((e: Record<string, any>) => [e.consumer, e.state])).toEqual([["availability", "active"], ["decision-room", "active"], ["quiet", "failed"]]);
    expect(app.effects.find((e: Record<string, any>) => e.consumer === "quiet")).toMatchObject({ changeIdentity: null, detail: expect.stringMatching(/^couldn't read the current quiet hours: database is locked/) });
    expect(f.quiet.show("alex"), "nothing was written").toBeNull();
    expect((await f.call("GET", "alex/mode")).body.current.effects).toEqual(app.effects);
    const ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(ended.effects.map((e: Record<string, any>) => [e.consumer, e.state])).toEqual([["availability", "ended"], ["decision-room", "ended"], ["quiet", "ended"]]);
    expect(ended.effects.find((e: Record<string, any>) => e.consumer === "quiet").detail).toMatch(/never took effect/);
    expect(f.availability()).toBe("available");
  });

  it("review F2: a write that saved the fragment but failed to re-project is still the mode's change, so ending restores it", async () => {
    const f = fixture();
    const real = registryAvailability(f.home);
    let first = true;
    const modes = service(f, { read: real.read, write: (id, value) => {
      if (!first) return real.write(id, value);
      first = false;
      real.write(id, value); // the fragment is saved ...
      return { ok: false, error: "fragment written but re-projection failed: disk full (test)" }; // ... and projecting it fails
    } });
    modes.save("alex", { name: "out-of-office", availability: { value: "off" } }, "op");
    const app = modes.apply("alex", "out-of-office", {}, "op").application!;
    expect(app.effects[0]).toMatchObject({ consumer: "availability", state: "failed", changeIdentity: { availability: "off" }, detail: expect.stringMatching(/re-projection failed/) });
    expect(f.availability()).toBe("off"); // live on the next load
    const ended = modes.end("alex", "back", "op")!;
    expect(ended.effects[0]).toMatchObject({ consumer: "availability", state: "ended" });
    expect(f.availability()).toBe("available");
  });

  it("review F3 switch: an availability restore still owed at a switch is handed to the new mode, which restores the original value", async () => {
    const f = fixture(); // alex: available
    const real = registryAvailability(f.home);
    let failReads = 0;
    const modes = service(f, { read: (id) => (failReads-- > 0 ? { ok: false, error: "registry unreadable (test)" } : real.read(id)), write: real.write });
    modes.save("alex", { name: "asleep", availability: { value: "off" } }, "op");
    modes.save("alex", { name: "away-from-desk", availability: { value: "away" } }, "op");
    const asleep = modes.apply("alex", "asleep", {}, "op").application!;
    failReads = 1; // the switch's end can't read the registry once: asleep's restore is owed
    const away = modes.apply("alex", "away-from-desk", {}, "op").application!;
    expect(away.effects[0]).toMatchObject({ consumer: "availability", state: "active", prior: { availability: "available" } });
    expect(modes.get(asleep.applicationId)!.effects[0]).toMatchObject({ state: "handed-off",
      detail: `handed to away-from-desk (${away.applicationId}), which restores availability available when it ends` });
    expect(modes.unresolved("alex")).toEqual([]);
    modes.end("alex", "back", "op");
    expect(f.availability()).toBe("available"); // the original value, not asleep's off
    expect(stateOf(modes.get(away.applicationId)!, "availability")).toBe("ended");
    expect(stateOf(modes.get(asleep.applicationId)!, "availability")).toBe("handed-off");
  });

  it("review F3 switch: a quiet restore that failed at a switch is handed to the new mode, so asleep's nightly rule doesn't come back", async () => {
    const f = fixture(); // no quiet hours before
    const modes = service(f, registryAvailability(f.home));
    modes.save("alex", { name: "asleep", delivery: { quiet: { kind: "daily", start: "22:00", end: "07:00", timezone: "UTC" }, account: null } }, "op");
    modes.save("alex", { name: "away-from-desk", delivery: { quiet: { kind: "daily", start: "23:00", end: "05:00", timezone: "UTC" }, account: null } }, "op");
    const asleep = modes.apply("alex", "asleep", {}, "op").application!;
    const clear = vi.spyOn(HumanQuietStore.prototype, "clear").mockImplementationOnce(() => { throw new Error("database is locked (test)"); });
    let away: ReturnType<typeof modes.get>;
    try { away = modes.apply("alex", "away-from-desk", {}, "op").application; } finally { clear.mockRestore(); }
    expect(away!.effects[0]).toMatchObject({ consumer: "quiet", state: "active", prior: null });
    expect(modes.get(asleep.applicationId)!.effects[0]).toMatchObject({ state: "handed-off",
      detail: `handed to away-from-desk (${away!.applicationId}), which restores no quiet hours when it ends` });
    modes.end("alex", "back", "op");
    expect(f.quiet.show("alex"), "neither mode's rule is left behind").toBeNull();
    expect(modes.unresolved("alex")).toEqual([]);
  });

  it("a restore that fails is failed, not ended", async () => {
    const f = fixture();
    const real = registryAvailability(f.home);
    let writes = 0;
    const modes = service(f, { read: real.read, write: (id, value) => (++writes === 1 ? real.write(id, value) : { ok: false, error: "disk full (test)" }) });
    modes.save("alex", { name: "away-from-desk", availability: { value: "away" } }, "op");
    modes.apply("alex", "away-from-desk", {}, "op");
    const ended = modes.end("alex", "back", "op")!;
    expect(ended.effects[0]).toMatchObject({ consumer: "availability", state: "failed", detail: expect.stringMatching(/disk full/) });
    expect(f.availability()).toBe("away");
  });

  it("an availability that can't be read at the end is pending, and ending again retries it", async () => {
    const f = fixture();
    const real = registryAvailability(f.home);
    let readable = true;
    const modes = service(f, { read: (id) => (readable ? real.read(id) : { ok: false, error: "registry unreadable (test)" }), write: real.write });
    modes.save("alex", { name: "away-from-desk", availability: { value: "away" } }, "op");
    modes.apply("alex", "away-from-desk", {}, "op");
    readable = false;
    const ended = modes.end("alex", "back", "op")!;
    expect(ended).toMatchObject({ endReason: "back" });
    expect(stateOf(ended, "availability")).toBe("pending");
    expect(modes.current("alex")).toBeNull();
    expect(modes.unresolved("alex")).toEqual([expect.objectContaining({ applicationId: ended.applicationId, effect: expect.objectContaining({ state: "pending" }) })]);
    readable = true;
    expect(modes.end("alex", "back", "op")).toBeNull(); // no mode on: the earlier pending restore is tried again
    expect(stateOf(modes.get(ended.applicationId)!, "availability")).toBe("ended");
    expect(modes.unresolved("alex")).toEqual([]);
    expect(f.availability()).toBe("available");
  });

  it("review F3: an older pending restore stays listed while a later mode is on, and that mode's end retries it", async () => {
    const f = fixture();
    const real = registryAvailability(f.home);
    let readable = true;
    const modes = service(f, { read: (id) => (readable ? real.read(id) : { ok: false, error: "registry unreadable (test)" }), write: real.write });
    modes.save("alex", { name: "away-from-desk", availability: { value: "away" } }, "op");
    modes.save("alex", { name: "asleep", decisionRoom: { words: "the usual", exclusions: [] } }, "op");
    const first = modes.apply("alex", "away-from-desk", {}, "op").application!;
    readable = false;
    modes.end("alex", "back", "op"); // its availability restore is pending
    const second = modes.apply("alex", "asleep", {}, "op").application; // a switch isn't refused
    expect(second).not.toBeNull();
    expect(modes.current("alex")?.applicationId).toBe(second!.applicationId);
    expect(modes.unresolved("alex")).toEqual([expect.objectContaining({ applicationId: first.applicationId, modeName: "away-from-desk",
      effect: expect.objectContaining({ consumer: "availability", state: "pending" }) })]);
    readable = true;
    modes.end("alex", "back", "op"); // ending the later mode tries the older restore again
    expect(stateOf(modes.get(first.applicationId)!, "availability")).toBe("ended");
    expect(modes.unresolved("alex")).toEqual([]);
    expect(f.availability()).toBe("available");
  });
});

describe("what a mode never touches", () => {
  const legacy = (scope: string): OperatorContextModeRecord => ({
    autonomy_scope: "bounded_continuation", heartbeat_cadence: "fast", inspection_depth: "forensic", update_detail: "verbose",
    escalation_threshold: "low", concurrency_limit: "serial", permission_prompt_posture: "normal", scope: scope as OperatorContextModeRecord["scope"],
    expiry_or_stale_rule: "re_confirm_on_long_gap", evidence_citation: "seeded legacy binding",
  });
  // Every table except the modes' own, the quiet window they write and the job that ends a mode at its time: seat
  // permissions, posture, lifecycle and the legacy bindings all live outside them.
  const snapshot = (db: Database.Database) => {
    const own = new Set(["human_saved_modes", "human_mode_applications", "human_mode_effects", "human_quiet_windows"]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
      .map((t) => t.name).filter((t) => !own.has(t));
    return Object.fromEntries(tables.map((t) => [t, db.prepare(t === "watchdog_jobs" ? `SELECT * FROM "${t}" WHERE policy != 'mode-scheduled-end'` : `SELECT * FROM "${t}"`).all()]));
  };

  it("applying and ending a mode leaves the legacy bindings, posture and every other table as they were", async () => {
    const f = fixture();
    const store = new RigModeStore(f.db);
    expect(store.setBinding("global_host", null, "sleep", legacy("global_host")).ok).toBe(true); // a legacy saved mode
    expect(store.setBinding("rig", "demo", "focus", legacy("rig")).ok).toBe(true);
    const before = snapshot(f.db);
    expect((before.operator_context_mode_bindings as unknown[]).length).toBeGreaterThan(0);
    const fragmentBefore = readFileSync(join(f.home, "gateway", "humans", "alex.yaml"), "utf8");
    await f.call("PUT", "alex/modes/asleep", asleep);
    await f.call("POST", "alex/modes/asleep/apply", { until: "07:00", timezone: "UTC" });
    await f.call("POST", "alex/modes/out-of-office/apply", {}).catch(() => undefined); // not saved: refused, nothing changes
    await f.call("POST", "alex/modes/at-desk/apply", {});
    expect(snapshot(f.db)).toEqual(before);
    expect(readFileSync(join(f.home, "gateway", "humans", "alex.yaml"), "utf8")).toBe(fragmentBefore); // availability restored as it was
    expect(store.getBinding("global_host", null)).toMatchObject({ mode: "sleep" });
  });
});
