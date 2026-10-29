import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  it.each(["same-name", "same-id", "name-id"])("reports %s collisions instead of choosing the first scope", mode => {
    const f = fixture();
    f.addSlice("another", mode === "same-name" ? "03-build" : mode === "name-id" ? "OPR.3" : "other", mode === "same-id" ? "OPR.3" : "different");
    expect(f.read()).toMatchObject({ code: "scope_ambiguous" });
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
    expect(f.read()).toMatchObject({ code: "scope_unavailable" });
  });
  it("bounds active queue enumeration rather than scanning each qitem family", () => {
    const f = fixture();
    f.db.transaction(() => { for (let i = 0; i < 50001; i++) f.add(`unrelated-${i}`, "other", "pending", []); })();
    f.add("real-member", "a");
    expect(f.read()).toMatchObject({ task: { complete: false } });
  });
});
