// Quiet hours for a person: the stored window and the resolver that says whether quiet is on now, for which occurrence
// and revision, and when the next boundary is. Real SQLite (the full test schema), an injected clock. Nothing here
// touches delivery: the resolver isn't called by any delivery decision yet.
import { describe, it, expect } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { HumanQuietStore, QuietWindowError, zonedLocalToInstant } from "../src/domain/gateway/human-quiet-windows.js";

const at = (iso: string) => new Date(iso);
function store() {
  const db = createFullTestDb();
  return { db, quiet: new HumanQuietStore(db) };
}

describe("a daily quiet window", () => {
  it("is on from the start until the end across midnight, with the actual next boundary", () => {
    const { quiet } = store();
    quiet.setDaily("alice", { start: "22:00", end: "07:00", timezone: "Europe/Berlin", setBy: "operator", now: at("2026-10-20T12:00:00Z") });
    // 21:59 Berlin (CEST, +02:00) is 19:59Z: not yet on; next boundary is tonight's start.
    expect(quiet.quietStateFor("alice", at("2026-10-20T19:59:00Z"))).toMatchObject({
      active: false, nextBoundary: { kind: "start", at: "2026-10-20T20:00:00.000Z" },
    });
    // 23:30 Berlin: on, tonight's occurrence, ending at 07:00 tomorrow.
    expect(quiet.quietStateFor("alice", at("2026-10-20T21:30:00Z"))).toMatchObject({
      active: true, occurrence: "2026-10-20", revision: 1, nextBoundary: { kind: "end", at: "2026-10-21T05:00:00.000Z" },
    });
    // 03:00 Berlin the next morning: still the occurrence that started on the 20th.
    expect(quiet.quietStateFor("alice", at("2026-10-21T01:00:00Z"))).toMatchObject({ active: true, occurrence: "2026-10-20" });
    // 07:00 exactly: off; the next start is that evening.
    expect(quiet.quietStateFor("alice", at("2026-10-21T05:00:00Z"))).toMatchObject({
      active: false, nextBoundary: { kind: "start", at: "2026-10-21T20:00:00.000Z" },
    });
  });

  it("a window inside one day works too", () => {
    const { quiet } = store();
    quiet.setDaily("alice", { start: "12:00", end: "13:00", timezone: "UTC", setBy: "operator", now: at("2026-10-20T08:00:00Z") });
    expect(quiet.quietStateFor("alice", at("2026-10-20T12:30:00Z"))).toMatchObject({ active: true, occurrence: "2026-10-20" });
    expect(quiet.quietStateFor("alice", at("2026-10-20T13:30:00Z"))).toMatchObject({
      active: false, nextBoundary: { kind: "start", at: "2026-10-21T12:00:00.000Z" },
    });
  });

  it("ending it ends tonight's occurrence only; tomorrow's rule stays", () => {
    const { quiet } = store();
    quiet.setDaily("alice", { start: "22:00", end: "07:00", timezone: "Europe/Berlin", setBy: "operator", now: at("2026-10-20T12:00:00Z") });
    const ended = quiet.end("alice", { endedBy: "operator", now: at("2026-10-21T02:00:00Z") });
    expect(ended).toMatchObject({ occurrence: "2026-10-20", revision: 1 });
    expect(quiet.quietStateFor("alice", at("2026-10-21T02:30:00Z"))).toMatchObject({
      active: false, nextBoundary: { kind: "start", at: "2026-10-21T20:00:00.000Z" },
    });
    expect(quiet.quietStateFor("alice", at("2026-10-21T21:00:00Z"))).toMatchObject({ active: true, occurrence: "2026-10-21", revision: 1 });
  });

  it("ending when quiet isn't on is refused with the reason, and changes nothing", () => {
    const { quiet } = store();
    quiet.setDaily("alice", { start: "22:00", end: "07:00", timezone: "Europe/Berlin", setBy: "operator", now: at("2026-10-20T12:00:00Z") });
    expect(() => quiet.end("alice", { endedBy: "operator", now: at("2026-10-20T12:00:00Z") })).toThrow(/isn't on now/);
    expect(quiet.quietStateFor("alice", at("2026-10-20T21:00:00Z"))).toMatchObject({ active: true });
  });

  it("extending or replacing bumps the revision and carries on under the new window", () => {
    const { quiet } = store();
    quiet.setDaily("alice", { start: "22:00", end: "07:00", timezone: "Europe/Berlin", setBy: "operator", now: at("2026-10-20T12:00:00Z") });
    const before = quiet.quietStateFor("alice", at("2026-10-21T04:30:00Z"));
    expect(before).toMatchObject({ active: true, revision: 1, nextBoundary: { at: "2026-10-21T05:00:00.000Z" } });
    // Extend tonight's window to 09:00 at 06:30 Berlin.
    quiet.setDaily("alice", { start: "22:00", end: "09:00", timezone: "Europe/Berlin", setBy: "operator", now: at("2026-10-21T04:30:00Z") });
    const after = quiet.quietStateFor("alice", at("2026-10-21T05:30:00Z"));
    expect(after).toMatchObject({ active: true, occurrence: "2026-10-20", revision: 2, windowId: before.windowId,
      nextBoundary: { kind: "end", at: "2026-10-21T07:00:00.000Z" } });
    // Replacing with an until-time is another revision of the same window.
    quiet.setUntil("alice", { until: at("2026-10-21T10:00:00Z"), timezone: "Europe/Berlin", setBy: "operator", now: at("2026-10-21T05:30:00Z") });
    expect(quiet.quietStateFor("alice", at("2026-10-21T08:00:00Z"))).toMatchObject({ active: true, revision: 3, windowId: before.windowId });
  });

  it("a new revision undoes an earlier end: the newer intent wins", () => {
    const { quiet } = store();
    quiet.setDaily("alice", { start: "22:00", end: "07:00", timezone: "UTC", setBy: "operator", now: at("2026-10-20T12:00:00Z") });
    quiet.end("alice", { endedBy: "operator", now: at("2026-10-20T23:00:00Z") });
    expect(quiet.quietStateFor("alice", at("2026-10-20T23:30:00Z")).active).toBe(false);
    quiet.setDaily("alice", { start: "22:00", end: "08:00", timezone: "UTC", setBy: "operator", now: at("2026-10-20T23:30:00Z") });
    expect(quiet.quietStateFor("alice", at("2026-10-20T23:31:00Z"))).toMatchObject({ active: true, revision: 2 });
  });
});

describe("an until-time quiet window", () => {
  it("is on now until the time, then off with no next boundary", () => {
    const { quiet } = store();
    quiet.setUntil("alice", { until: at("2026-10-20T18:00:00Z"), timezone: "America/New_York", setBy: "operator", now: at("2026-10-20T12:00:00Z") });
    expect(quiet.quietStateFor("alice", at("2026-10-20T17:59:00Z"))).toMatchObject({
      active: true, occurrence: "until", nextBoundary: { kind: "end", at: "2026-10-20T18:00:00.000Z" },
    });
    expect(quiet.quietStateFor("alice", at("2026-10-20T18:00:00Z"))).toMatchObject({ active: false, nextBoundary: null });
  });

  it("a time already passed is refused", () => {
    const { quiet } = store();
    expect(() => quiet.setUntil("alice", { until: at("2026-10-20T11:00:00Z"), timezone: "UTC", setBy: "operator", now: at("2026-10-20T12:00:00Z") }))
      .toThrow(QuietWindowError);
  });

  it("ending it ends it", () => {
    const { quiet } = store();
    quiet.setUntil("alice", { until: at("2026-10-20T18:00:00Z"), timezone: "UTC", setBy: "operator", now: at("2026-10-20T12:00:00Z") });
    quiet.end("alice", { endedBy: "operator", now: at("2026-10-20T13:00:00Z") });
    expect(quiet.quietStateFor("alice", at("2026-10-20T13:01:00Z"))).toMatchObject({ active: false, nextBoundary: null });
  });
});

describe("the stored window", () => {
  it("survives a restart: a new store over the same database reads the same state", () => {
    const { db, quiet } = store();
    quiet.setDaily("alice", { start: "22:00", end: "07:00", timezone: "Europe/Berlin", setBy: "operator", now: at("2026-10-20T12:00:00Z") });
    quiet.end("alice", { endedBy: "operator", now: at("2026-10-20T21:00:00Z") });
    const reopened = new HumanQuietStore(db);
    expect(reopened.quietStateFor("alice", at("2026-10-20T21:30:00Z"))).toMatchObject({ active: false, revision: 1 });
    expect(reopened.show("alice")).toMatchObject({ kind: "daily", start: "22:00", end: "07:00", timezone: "Europe/Berlin",
      source: "manual", setBy: "operator", revision: 1, ended: { occurrence: "2026-10-20", by: "operator" } });
  });

  it("clearing removes the rule, and a later set keeps counting revisions", () => {
    const { quiet } = store();
    quiet.setDaily("alice", { start: "22:00", end: "07:00", timezone: "UTC", setBy: "operator", now: at("2026-10-20T12:00:00Z") });
    quiet.clear("alice", { clearedBy: "operator", now: at("2026-10-20T13:00:00Z") });
    expect(quiet.quietStateFor("alice", at("2026-10-20T23:00:00Z"))).toMatchObject({ active: false, nextBoundary: null });
    expect(quiet.show("alice")).toBeNull();
    quiet.setDaily("alice", { start: "22:00", end: "07:00", timezone: "UTC", setBy: "operator", now: at("2026-10-20T14:00:00Z") });
    expect(quiet.quietStateFor("alice", at("2026-10-20T23:00:00Z"))).toMatchObject({ active: true, revision: 3 });
  });

  it("another person's window is untouched", () => {
    const { quiet } = store();
    quiet.setDaily("alice", { start: "22:00", end: "07:00", timezone: "UTC", setBy: "operator", now: at("2026-10-20T12:00:00Z") });
    quiet.setDaily("bob", { start: "20:00", end: "06:00", timezone: "UTC", setBy: "operator", now: at("2026-10-20T12:00:00Z") });
    quiet.end("alice", { endedBy: "operator", now: at("2026-10-20T23:00:00Z") });
    quiet.clear("alice", { clearedBy: "operator", now: at("2026-10-20T23:10:00Z") });
    expect(quiet.quietStateFor("bob", at("2026-10-20T23:20:00Z"))).toMatchObject({ active: true, revision: 1, occurrence: "2026-10-20" });
  });

  it("a person with no window is simply not quiet", () => {
    const { quiet } = store();
    expect(quiet.quietStateFor("nobody", at("2026-10-20T12:00:00Z"))).toEqual({ active: false, nextBoundary: null });
    expect(quiet.show("nobody")).toBeNull();
  });

  it("an unknown timezone, a malformed time and an empty window are refused with a clear message", () => {
    const { quiet } = store();
    const now = at("2026-10-20T12:00:00Z");
    expect(() => quiet.setDaily("alice", { start: "22:00", end: "07:00", timezone: "Mars/Olympus", setBy: "o", now })).toThrow(/unknown timezone "Mars\/Olympus"/);
    expect(() => quiet.setDaily("alice", { start: "25:00", end: "07:00", timezone: "UTC", setBy: "o", now })).toThrow(/HH:MM/);
    expect(() => quiet.setDaily("alice", { start: "7:00", end: "07:00", timezone: "UTC", setBy: "o", now })).toThrow(/HH:MM/);
    expect(() => quiet.setDaily("alice", { start: "07:00", end: "07:00", timezone: "UTC", setBy: "o", now })).toThrow(/start and end are the same/);
    expect(quiet.show("alice")).toBeNull();
  });
});

describe("daylight saving time", () => {
  // Europe/Berlin: 2026-03-29 02:00 → 03:00 (skipped hour), 2026-10-25 03:00 → 02:00 (repeated hour).
  it("a skipped local time starts at the next valid minute", () => {
    expect(zonedLocalToInstant("2026-03-29", "02:30", "Europe/Berlin").toISOString()).toBe("2026-03-29T01:00:00.000Z"); // 03:00 CEST
    expect(zonedLocalToInstant("2026-03-29", "01:30", "Europe/Berlin").toISOString()).toBe("2026-03-29T00:30:00.000Z"); // 01:30 CET
  });

  it("a repeated local time resolves to its first occurrence", () => {
    expect(zonedLocalToInstant("2026-10-25", "02:30", "Europe/Berlin").toISOString()).toBe("2026-10-25T00:30:00.000Z"); // 02:30 CEST
  });

  it("a window across the autumn change ends at the right instant, and the spring night is an hour shorter", () => {
    const { quiet } = store();
    quiet.setDaily("alice", { start: "22:00", end: "07:00", timezone: "Europe/Berlin", setBy: "o", now: at("2026-10-24T12:00:00Z") });
    // Saturday 24 Oct 22:00 CEST = 20:00Z; Sunday 25 Oct 07:00 CET = 06:00Z (a ten-hour night).
    expect(quiet.quietStateFor("alice", at("2026-10-24T20:00:00Z"))).toMatchObject({
      active: true, occurrence: "2026-10-24", nextBoundary: { kind: "end", at: "2026-10-25T06:00:00.000Z" },
    });
    quiet.setDaily("alice", { start: "22:00", end: "07:00", timezone: "Europe/Berlin", setBy: "o", now: at("2026-03-28T12:00:00Z") });
    // Saturday 28 Mar 22:00 CET = 21:00Z; Sunday 29 Mar 07:00 CEST = 05:00Z (an eight-hour night).
    expect(quiet.quietStateFor("alice", at("2026-03-28T21:00:00Z"))).toMatchObject({
      active: true, occurrence: "2026-03-28", nextBoundary: { kind: "end", at: "2026-03-29T05:00:00.000Z" },
    });
  });

  it("a night whose whole window falls in the skipped hour is empty: never on, and never advertised as the next start", () => {
    const { quiet } = store();
    // 02:10-02:20 on 2026-03-29 lies wholly in Berlin's skipped hour: both ends resolve to 03:00 CEST (01:00Z).
    quiet.setDaily("alice", { start: "02:10", end: "02:20", timezone: "Europe/Berlin", setBy: "o", now: at("2026-03-28T12:00:00Z") });
    const nextValid = { kind: "start", at: "2026-03-30T00:10:00.000Z" }; // 02:10 CEST the next night
    for (const reading of ["2026-03-29T00:59:00Z", "2026-03-29T01:00:00Z", "2026-03-29T01:30:00Z"]) {
      expect(quiet.quietStateFor("alice", at(reading)), reading).toMatchObject({ active: false, nextBoundary: nextValid });
    }
    expect(quiet.quietStateFor("alice", at("2026-03-30T00:15:00Z"))).toMatchObject({
      active: true, occurrence: "2026-03-30", nextBoundary: { kind: "end", at: "2026-03-30T00:20:00.000Z" },
    });
  });

  it("a window that starts in the skipped hour starts at the next valid minute that night", () => {
    const { quiet } = store();
    quiet.setDaily("alice", { start: "02:30", end: "06:00", timezone: "Europe/Berlin", setBy: "o", now: at("2026-03-28T12:00:00Z") });
    expect(quiet.quietStateFor("alice", at("2026-03-29T00:59:00Z"))).toMatchObject({
      active: false, nextBoundary: { kind: "start", at: "2026-03-29T01:00:00.000Z" },
    });
    expect(quiet.quietStateFor("alice", at("2026-03-29T01:00:00Z"))).toMatchObject({ active: true, occurrence: "2026-03-29" });
  });
});
