import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { declaredRuntimeHomes, effectiveRuntimeHome, seatRuntimeHome } from "../src/domain/seat-runtime-home.js";

// A seat's own runtime home comes from its stored `env:`: the member's value, else the rig's.
const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function db(rows: { rig?: object; members: Record<string, object | undefined> }) {
  const d = new Database(":memory:"); open.push(d);
  d.exec("CREATE TABLE rigs(id TEXT, env_json TEXT); CREATE TABLE nodes(id TEXT, rig_id TEXT, env_json TEXT);");
  d.prepare("INSERT INTO rigs VALUES ('rig', ?)").run(rows.rig ? JSON.stringify(rows.rig) : null);
  for (const [id, env] of Object.entries(rows.members)) {
    d.prepare("INSERT INTO nodes VALUES (?, 'rig', ?)").run(id, env ? JSON.stringify(env) : null);
  }
  return d;
}

describe("seatRuntimeHome", () => {
  it("takes the member's value over the rig's, per runtime", () => {
    const d = db({ rig: { CLAUDE_CONFIG_DIR: "/homes/rig-claude", CODEX_HOME: "/homes/rig-codex" },
      members: { a: { CODEX_HOME: "/homes/a-codex" }, b: undefined } });
    expect(seatRuntimeHome(d, "a", "codex")).toEqual({ home: "/homes/a-codex", source: "member" });
    expect(seatRuntimeHome(d, "a", "claude-code")).toEqual({ home: "/homes/rig-claude", source: "rig" });
    expect(seatRuntimeHome(d, "b", "codex")).toEqual({ home: "/homes/rig-codex", source: "rig" });
  });

  it("reports a value that isn't an absolute path instead of using it, and a member's ignored value still shadows the rig's", () => {
    const d = db({ rig: { CODEX_HOME: "/homes/rig-codex" }, members: { a: { CODEX_HOME: "relative/codex" } } });
    expect(seatRuntimeHome(d, "a", "codex")).toEqual({ ignored: { source: "member", value: "relative/codex" } });
    expect(effectiveRuntimeHome(d, "a", "codex", "/daemon/codex")).toBe("/daemon/codex");
  });

  it("is empty for a seat that declares nothing, an unknown node or no node", () => {
    const d = db({ members: { a: { FOO: "bar" } } });
    expect(seatRuntimeHome(d, "a", "claude-code")).toEqual({});
    expect(seatRuntimeHome(d, "missing", "claude-code")).toEqual({});
    expect(seatRuntimeHome(d, undefined, "claude-code")).toEqual({});
    expect(effectiveRuntimeHome(d, "a", "claude-code", undefined)).toBeUndefined();
    expect(effectiveRuntimeHome(d, "a", "claude-code", "/daemon/claude")).toBe("/daemon/claude");
  });

  it("normalizes a declared home", () => {
    const d = db({ members: { a: { CLAUDE_CONFIG_DIR: "/homes//seat/./claude/" } } });
    expect(seatRuntimeHome(d, "a", "claude-code").home).toBe("/homes/seat/claude/");
  });

  it("reads nothing from a database without stored env", () => {
    const d = new Database(":memory:"); open.push(d);
    d.exec("CREATE TABLE rigs(id TEXT); CREATE TABLE nodes(id TEXT, rig_id TEXT);");
    expect(seatRuntimeHome(d, "a", "codex")).toEqual({});
    expect(declaredRuntimeHomes(d, "codex")).toEqual([]);
  });
});

describe("declaredRuntimeHomes", () => {
  it("lists each distinct absolute home declared on members and rigs, once", () => {
    const d = db({ rig: { CODEX_HOME: "/homes/shared" },
      members: { a: { CODEX_HOME: "/homes/shared" }, b: { CODEX_HOME: "/homes/b" }, c: { CODEX_HOME: "rel" }, d: { CLAUDE_CONFIG_DIR: "/homes/claude" } } });
    expect(declaredRuntimeHomes(d, "codex").sort()).toEqual(["/homes/b", "/homes/shared"]);
    expect(declaredRuntimeHomes(d, "claude-code")).toEqual(["/homes/claude"]);
  });
});
