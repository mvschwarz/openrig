import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as scopeReader from "../src/domain/terminal/scope-task-terminal-view.js";
import { readScopedTaskTerminalView } from "../src/domain/terminal/scope-task-terminal-view.js";
import type { TaskSeat } from "../src/domain/terminal/task-terminal-view.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture(projectId?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "scope-terminals-"));
  const db = new Database(":memory:");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("CREATE TABLE queue_items(qitem_id TEXT PRIMARY KEY,destination_session TEXT,state TEXT,tags TEXT,chain_of_record TEXT); CREATE INDEX idx_queue_items_state ON queue_items(state)");
  const addSlice = (mission: string, name: string, id = name, title = name) => {
    const dir = path.join(root, mission, "slices", name); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SPEC.md"), `---\nid: ${id}\ntitle: ${title}\n---\n# ${title}\n`); return dir;
  };
  const index = { slicesRoot: root, additionalSliceRoots: [path.join(root, "absent-legacy")], projectId };
  // Keep the absent compatibility root outside the primary root's namespace.
  index.additionalSliceRoots = [root + "-absent-legacy"];
  const seats = new Map<string, TaskSeat>(["a", "b", "stopped", "hosted", "missing"].map(name => [name,
    { hostId: "local", nodeId: name, seat: name, tmuxSession: name === "missing" ? null : name,
      attachmentType: name === "hosted" ? "external_cli" : "tmux", stopped: name === "stopped" }]));
  const add = (id: string, owner = "a", state = "pending", tags: unknown = ["slice:03-build"], chain: string[] = []) =>
    db.prepare("INSERT INTO queue_items VALUES(?,?,?,?,?)").run(id, owner, state, JSON.stringify(tags), JSON.stringify(chain));
  addSlice("release", "03-build", "OPR.3", "Build the feature");
  const read = (selector = "slice:03-build") => readScopedTaskTerminalView(db, selector, index, address => seats.get(address) ?? null);
  return { root, db, index, seats, addSlice, add, read };
}

describe("authoritative scoped terminal membership", () => {
  it("selects exact name and unique id tags, active states, and every current obligation", () => {
    const f = fixture();
    f.add("two", "a", "blocked", ["slice:OPR.3"]); f.add("one", "a", "in-progress");
    f.add("review", "b", "pending", ["other,slice:03-build"]);
    for (const state of ["done", "canceled", "handed-off"]) f.add(state, "old", state);
    f.add("not-substring", "other", "pending", ["slice:03-build-extra"]);
    f.add("mission-only", "other", "pending", ["mission:release"]);
    const result = f.read("slice:OPR.3"); if ("code" in result) throw new Error(result.error);
    expect(result.task).toMatchObject({ kind: "slice", id: "OPR.3", name: "Build the feature", complete: true,
      members: [{ seat: "a", obligations: [{ qitemId: "one", state: "in-progress" }, { qitemId: "two", state: "blocked" }] }, { seat: "b" }] });
    expect(result.task).not.toHaveProperty("qitemId");
    expect(result.members.every(member => member.readOnly === true)).toBe(true);
    expect(f.read()).toEqual(result);
  });
  it("follows handoff tag inheritance and completion without importing untagged descendants", () => {
    const f = fixture(); f.add("old"); f.add("unassociated-child", "other", "pending", [], ["old"]);
    f.db.prepare("UPDATE queue_items SET state='handed-off' WHERE qitem_id='old'").run();
    f.add("new", "b", "pending");
    expect(f.read()).toMatchObject({ task: { complete: true, members: [{ seat: "b" }] } });
    f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id='new'").run();
    expect(f.read()).toMatchObject({ task: { complete: true, members: [] } });
    f.add("later"); expect(f.read()).toMatchObject({ task: { complete: true, members: [{ seat: "a" }] } });
  });
  it("keeps stopped, hosted, missing and distinct unresolved owners without making enumeration incomplete", () => {
    const f = fixture();
    for (const seat of ["stopped", "hosted", "missing", "unknown-one", "unknown-two"]) f.add(seat, seat);
    const result = f.read(); if ("code" in result) throw new Error(result.error);
    expect(result.task.complete).toBe(true); expect(result.task.members).toHaveLength(5);
    expect(result.task.members.map(m => m.availability).sort()).toEqual(["hosted", "missing", "stopped", "unresolved", "unresolved"]);
    expect(result.members).toEqual([]);
  });
  it("keeps the selected project association separate from equal scope tags", () => {
    const f = fixture("chosen");
    f.add("ours", "a", "pending", ["project:chosen", "slice:OPR.3"]);
    f.add("theirs", "b", "pending", ["project:other", "slice:OPR.3"]);
    f.add("unqualified", "other");
    expect(f.read()).toMatchObject({ task: { complete: true, members: [{ seat: "a", obligations: [{ qitemId: "ours" }] }] } });
  });
  it.each(["same-name", "same-id", "name-id"])("reports bare %s collisions instead of choosing the first scope", mode => {
    const f = fixture();
    f.addSlice("another", mode === "same-name" ? "03-build" : mode === "name-id" ? "OPR.3" : "other", mode === "same-id" ? "OPR.3" : "different");
    expect(f.read(mode === "same-name" ? "slice:03-build" : "slice:OPR.3")).toMatchObject({ code: "scope_ambiguous" });
  });
  it("honors SPEC precedence and exact Unicode, plus, internal-space and percent-literal ids", () => {
    const f = fixture(), dir = f.addSlice("another", "04-other", "révision + 50%", "Other scope");
    writeFileSync(path.join(dir, "README.md"), "---\nid: stale\n---\n");
    f.add("unicode", "b", "pending", ["slice:révision + 50%"]);
    expect(f.read("slice:révision + 50%")).toMatchObject({ task: { complete: true, id: "révision + 50%", members: [{ seat: "b" }] } });
    expect(f.read("slice:stale")).toMatchObject({ code: "scope_not_found" });
  });
  it("distinguishes known empty, missing scope, unsupported kind and unavailable primary index", () => {
    const f = fixture();
    expect(f.read()).toMatchObject({ task: { complete: true, members: [] } });
    expect(f.read("slice:absent")).toMatchObject({ code: "scope_not_found" });
    expect(f.read("mission:release")).toMatchObject({ code: "scope_unsupported" });
    f.index.slicesRoot += "-missing"; expect(f.read()).toMatchObject({ code: "scope_unavailable" });
  });
  it("does not turn malformed or over-budget active tags into complete empty", () => {
    const f = fixture(); f.add("bad", "a", "pending", {});
    expect(f.read()).toMatchObject({ task: { complete: false } });
    f.db.prepare("UPDATE queue_items SET tags=?").run("not JSON");
    expect(f.read()).toMatchObject({ task: { complete: false } });
    f.db.prepare("UPDATE queue_items SET tags=?").run(JSON.stringify(["x".repeat(16385)]));
    expect(f.read()).toMatchObject({ task: { complete: false } });
    f.db.prepare("UPDATE queue_items SET state='done'").run();
    expect(f.read()).toMatchObject({ task: { complete: true, members: [] } });
  });
  it("does not certify unknown aliases through an unreadable or oversized selected header", () => {
    const f = fixture(), dir = f.addSlice("another", "04-other");
    writeFileSync(path.join(dir, "SPEC.md"), "---\nid: " + "x".repeat(17000) + "\n---\n");
    expect(f.read()).toMatchObject({ code: "scope_unavailable", error: expect.stringContaining("too large") });
  });
  it("bounds active queue enumeration rather than scanning each qitem family", () => {
    const f = fixture();
    f.db.transaction(() => { for (let i = 0; i < 50001; i++) f.add(`unrelated-${i}`, "other", "pending", []); })();
    f.add("real-member", "a");
    expect(f.read()).toMatchObject({ task: { complete: false } });
  });
});


it("keeps an unplaced inverse-alias row incomplete when selected through a unique id", () => {
  const f = fixture(); f.addSlice("other-mission", "other", "03-build");
  f.add("wrong-owner", "b", "pending", ["slice:03-build"]);
  expect(f.read("slice:OPR.3")).toMatchObject({ task: { complete: false, members: [] } });
});

function cachedFixture() {
  const f = fixture(); let observed = true;
  type Resolver = { resolve: (view: string) => ReturnType<typeof f.read>; invalidate(): void };
  const create = (scopeReader as unknown as { createScopedTaskResolver?: (db: Database.Database, index: typeof f.index,
    resolveSeat: (address: string) => TaskSeat | null, observed: () => boolean) => Resolver }).createScopedTaskResolver;
  // Before the cache fix, exercise the same always-fresh reader; its next
  // identity read exposes the missing generation reuse, rather than an import failure.
  const resolver = create ? create(f.db, f.index, address => f.seats.get(address) ?? null, () => observed)
    : { resolve: (view: string) => f.read(view), invalidate() {} };
  const changeId = (id: string) => writeFileSync(path.join(f.root, "release/slices/03-build/SPEC.md"), `---\nid: ${id}\n---\n`);
  return { ...f, resolver, changeId, unobserved: () => { observed = false; } };
}
it("reuses a watched identity generation, rereads queue owners, and invalidates on scope changes", () => {
  const f = cachedFixture(); expect(f.resolver.resolve("slice:03-build")).toMatchObject({ task: { id: "OPR.3", members: [] } });
  f.changeId("next-id"); f.add("fresh-owner", "b");
  expect(f.resolver.resolve("slice:03-build")).toMatchObject({ task: { id: "OPR.3", members: [{ seat: "b" }] } });
  f.resolver.invalidate();
  expect(f.resolver.resolve("slice:03-build")).toMatchObject({ task: { id: "next-id", members: [{ seat: "b" }] } });
});
it("rereads identities when watcher coverage is unavailable", () => {
  const f = cachedFixture(); f.resolver.resolve("slice:03-build"); f.unobserved(); f.changeId("changed");
  expect(f.resolver.resolve("slice:03-build")).toMatchObject({ task: { id: "changed" } });
});
it("rereads identities for an existing unwatched legacy root and after a scope error", () => {
  const f = cachedFixture(); const extra = mkdtempSync(path.join(tmpdir(), "legacy-scope-")); cleanup.push(() => rmSync(extra, { recursive: true, force: true }));
  f.resolver.resolve("slice:03-build"); f.index.additionalSliceRoots.push(extra); f.changeId("changed");
  expect(f.resolver.resolve("slice:03-build")).toMatchObject({ task: { id: "changed" } });
  f.index.additionalSliceRoots.pop();
  expect(f.resolver.resolve("slice:new")).toMatchObject({ code: "scope_not_found" });
  f.addSlice("another", "new");
  expect(f.resolver.resolve("slice:new")).toMatchObject({ task: { complete: true } });
});


describe("mission placement of colliding slice aliases", () => {
  it("follows repeated release template names by their unique IDs without mixing owners", () => {
    const f = fixture();
    f.addSlice("release-0.7.6", "01-regression-checks", "OPR.0.7.6.1");
    f.addSlice("release-0.6.13", "01-regression-checks", "OPR.0.6.13.1");
    f.add("current", "a", "pending", ["mission:release-0.7.6", "slice:01-regression-checks"]);
    f.add("older", "b", "blocked", ["mission:release-0.6.13", "slice:01-regression-checks"]);
    f.add("by-id", "a", "in-progress", ["slice:OPR.0.7.6.1"]);
    expect(f.read("slice:OPR.0.7.6.1")).toMatchObject({ task: { complete: true, members: [
      { seat: "a", obligations: [{ qitemId: "by-id" }, { qitemId: "current" }] }] } });
    expect(f.read("slice:OPR.0.6.13.1")).toMatchObject({ task: { complete: true, members: [{ seat: "b" }] } });
    expect(f.read("slice:01-regression-checks")).toMatchObject({ code: "scope_ambiguous" });
    f.db.prepare("UPDATE queue_items SET state='done'").run();
    expect(f.read("slice:OPR.0.7.6.1")).toMatchObject({ task: { complete: true, members: [] } });
  });
  it.each(["id-name", "name-id", "id-id"])("places a %s alias only through its one indexed mission", mode => {
    const f = fixture();
    f.addSlice("other-mission", mode === "id-name" ? "OPR.3" : "other", mode === "name-id" ? "03-build" : mode === "id-id" ? "OPR.3" : "OTHER");
    const alias = mode === "name-id" ? "03-build" : "OPR.3";
    const selector = mode === "name-id" ? "slice:OPR.3" : "slice:03-build";
    f.add("ours", "a", "pending", ["mission:release", `slice:${alias}`]);
    f.add("theirs", "b", "pending", ["mission:other-mission", `slice:${alias}`]);
    expect(f.read(selector)).toMatchObject({ task: { complete: true, members: [{ seat: "a" }] } });
    expect(f.read(`slice:${alias}`)).toMatchObject({ code: "scope_ambiguous" });
  });
  it.each([
    { label: "no mission", tags: [] },
    { label: "contradictory missions", tags: ["mission:release", "mission:other-mission"] },
    { label: "non-claimant mission", tags: ["mission:not-a-claimant"] },
  ])("retains known owners and reports an unplaceable colliding row with $label", ({ tags }) => {
    const f = fixture(); f.addSlice("other-mission", "03-build", "OTHER");
    f.add("known", "a", "pending", ["slice:OPR.3"]);
    f.add("unplaced", "b", "blocked", ["slice:03-build", ...tags]);
    const result = f.read("slice:OPR.3"); if ("code" in result) throw new Error(result.error);
    expect(result.task).toMatchObject({ complete: false, members: [{ seat: "a" }] });
    expect(result.task.issues.join(" ")).toContain("unplaced");
  });
  it("does not choose between two same-mission claimants or contradictory alias placements", () => {
    const f = fixture(); f.addSlice("release", "other", "03-build");
    f.add("same-mission", "b", "pending", ["slice:03-build", "mission:release"]);
    expect(f.read("slice:OPR.3")).toMatchObject({ task: { complete: false, members: [] } });
    f.db.prepare("DELETE FROM queue_items").run();
    f.addSlice("other-mission", "03-build", "OTHER");
    f.add("contradictory", "b", "pending", ["slice:OPR.3", "slice:03-build", "mission:other-mission"]);
    expect(f.read("slice:OPR.3")).toMatchObject({ task: { complete: false, members: [] } });
  });
  it("does not invent a mission context for colliding flat legacy slices", () => {
    const f = fixture();
    const dir = path.join(f.root, "legacy"); mkdirSync(dir); writeFileSync(path.join(dir, "SPEC.md"), "---\nid: 03-build\n---\n");
    expect(f.read("slice:legacy")).toMatchObject({ code: "scope_ambiguous" });
  });
});
