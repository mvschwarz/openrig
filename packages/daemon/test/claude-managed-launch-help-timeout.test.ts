// #260: the managed Claude capability query (`claude --help`) must tolerate a slow but
// valid help under load, and still end a hung query at a bounded timeout. Drives the real
// ClaudeManagedLaunch.prepare() and real execFile against private fake executables; no
// provider, tmux, daemon or credentials. Minimal tables as in s03-bound-launch.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";

const CHOICES = '  --permission-mode <mode>   Permission mode to use for the session (choices: "acceptEdits", "auto", "default", "plan")';
const WITHOUT_AUTO = '  --permission-mode <mode>   Permission mode to use for the session (choices: "acceptEdits", "default", "plan")';
const QUERY_FAILED = "Claude managed capability query failed; no fallback was selected.";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function fixture(script: string) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "claude-help-timeout-")));
  const cwd = path.join(root, "seat"); const bin = path.join(root, "bin"); const calls = path.join(root, "calls");
  mkdirSync(cwd); mkdirSync(bin); mkdirSync(path.join(root, "home"));
  writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho call >> '${calls}'\n${script}\n`);
  chmodSync(path.join(bin, "claude"), 0o755);
  const db = new Database(":memory:"); open.push(db);
  db.exec(`CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
  db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(cwd);
  db.exec("INSERT INTO bindings VALUES ('binding','node','seat','%1'); INSERT INTO occupant_tenures VALUES ('node','generation-1',1)");
  const managed = new ClaudeManagedLaunch(db, { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(root, "home") }, {});
  const helpCalls = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0;
  return { managed, helpCalls };
}

async function prepare(script: string, mode = "auto", target: { cwd?: string } = {}) {
  const f = fixture(script);
  const started = Date.now();
  try {
    await f.managed.prepare({ nodeId: "node", ...target }, mode);
    return { ok: true as const, ms: Date.now() - started, helpCalls: f.helpCalls() };
  } catch (error) {
    return { ok: false as const, ms: Date.now() - started, helpCalls: f.helpCalls(), message: (error as Error).message };
  }
}

describe("ClaudeManagedLaunch capability query timeout (#260)", () => {
  it("accepts a valid help that takes longer than one second", async () => {
    const result = await prepare(`sleep 1.5; printf '%s\\n' '${CHOICES}'`);
    expect(result).toMatchObject({ ok: true, helpCalls: 1 });
    expect(result.ms).toBeGreaterThanOrEqual(1400);
  }, 15_000);

  it("still ends a hung help at the bounded timeout with the same refusal", async () => {
    const result = await prepare("exec sleep 30");
    expect(result).toMatchObject({ ok: false, message: QUERY_FAILED, helpCalls: 1 });
    // Waited for the 5 s bound, and ended long before the fake's 30 s sleep. The ceiling is
    // deliberately loose: it proves the query was cut off, not a scheduling-time bound.
    expect(result.ms).toBeGreaterThanOrEqual(4800);
    expect(result.ms).toBeLessThan(25_000);
  }, 40_000);

  it("refuses an immediate non-zero exit without waiting", async () => {
    const result = await prepare("exit 1");
    expect(result).toMatchObject({ ok: false, message: QUERY_FAILED });
    expect(result.ms).toBeLessThan(1000);
  });

  it("refuses an empty successful help as unavailable options", async () => {
    expect(await prepare("exit 0")).toMatchObject({ ok: false, message: "Claude permission options are unavailable; selection was not changed." });
  });

  it("refuses a requested mode the installed help does not advertise", async () => {
    expect(await prepare(`printf '%s\\n' '${WITHOUT_AUTO}'`)).toMatchObject({
      ok: false, message: "Claude permission mode 'auto' is not supported by the installed harness." });
  });

  it("refuses a target that disagrees with the current binding before querying help", async () => {
    const result = await prepare(`printf '%s\\n' '${CHOICES}'`, "auto", { cwd: "/not/the/bound/cwd" });
    expect(result).toMatchObject({ ok: false, helpCalls: 0,
      message: "Claude managed launch target disagrees with the current binding; no input or selection changed." });
  });
});
