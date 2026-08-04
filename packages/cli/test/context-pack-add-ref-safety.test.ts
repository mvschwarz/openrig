// Slice-03 rig-context ATOM 2 (STORE) — the WRITE/ADD trust boundary: the CLI
// add path must reject an unsafe install ref BEFORE any filesystem mutation
// (spec §2 path-like refs; sealed Atom-1 per-segment contract, mirrored at
// the CLI trust boundary like the existing manifest hardening). PM watch: the
// matrix pins the ACTUAL reject + no-write behavior verbatim, per clause.
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { contextCommand } from "../src/commands/context.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import { DaemonClient } from "../src/client.js";
import type { StatusDeps } from "../src/commands/status.js";

function runningDeps(): StatusDeps {
  const lifecycleDeps: LifecycleDeps = {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) =>
      p === STATE_FILE
        ? JSON.stringify({ pid: 123, port: 1, db: "test.sqlite", startedAt: "2026-05-04T00:00:00Z" } as DaemonState)
        : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
  return { lifecycleDeps, clientFactory: (baseUrl) => new DaemonClient(baseUrl) };
}

function makeCmd(): Command {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(contextCommand(runningDeps()));
  return prog;
}

function validSourcePack(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctx-add-src-"));
  writeFileSync(join(dir, "manifest.yaml"), `
name: goodpack
version: 1
purpose: test
files:
  - path: notes.md
    role: notes
`);
  writeFileSync(join(dir, "notes.md"), "# notes\n");
  return dir;
}

describe("ATOM 2 — `context add` write boundary rejects unsafe install refs BEFORE any fs mutation", () => {
  const tmpHomes: string[] = [];
  const tmpSrcs: string[] = [];
  const origHome = process.env["OPENRIG_HOME"];

  afterEach(() => {
    for (const d of [...tmpHomes, ...tmpSrcs]) rmSync(d, { recursive: true, force: true });
    tmpHomes.length = 0;
    tmpSrcs.length = 0;
    if (origHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = origHome;
  });

  function isolatedHome(): string {
    const home = mkdtempSync(join(tmpdir(), "ctx-add-home-"));
    tmpHomes.push(home);
    process.env["OPENRIG_HOME"] = home;
    return home;
  }

  it.each([
    ["traversal segment", "../escape"],
    ["interior traversal", "packs/../escape"],
    ["absolute path", "/abs"],
    ["empty interior segment", "a//b"],
    ["whitespace in segment", "bad name"],
    ["colon injection", "a:b"],
  ])("rejects unsafe --name %s (`%s`) with NO write — the store root is never even created", async (_label, name) => {
    const home = isolatedHome();
    const src = validSourcePack();
    tmpSrcs.push(src);
    let failed = false;
    const origErr = console.error;
    const errLogs: string[] = [];
    console.error = (...args: unknown[]) => { errLogs.push(args.map(String).join(" ")); };
    const origExit = process.exitCode;
    try {
      await makeCmd().parseAsync(["node", "rig", "context", "add", src, "--name", name]);
    } catch { /* commander exitOverride */ }
    failed = process.exitCode === 1;
    console.error = origErr;
    process.exitCode = origExit;
    expect(failed, "add must fail").toBe(true);
    expect(errLogs.join("\n")).toMatch(/unsafe/);
    // the REAL pin: rejection happened BEFORE any fs mutation — the target
    // store root was never created, nothing was copied anywhere under HOME
    expect(existsSync(join(home, "context-packs")), "no store root created").toBe(false);
    expect(readdirSync(home), "isolated HOME untouched").toEqual([]);
  });

  it("accepts the spec §2 path-like example `packs/compaction-restore` as an install ref (write proceeds past the guard)", async () => {
    const home = isolatedHome();
    const src = validSourcePack();
    tmpSrcs.push(src);
    const origErr = console.error;
    const origLog = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await makeCmd().parseAsync(["node", "rig", "context", "add", src, "--name", "packs/compaction-restore"]);
    } catch { /* daemon sync may fail against the mock-less port — the WRITE has already happened */ }
    console.error = origErr;
    console.log = origLog;
    expect(existsSync(join(home, "context-packs", "packs", "compaction-restore", "manifest.yaml"))).toBe(true);
  });
});
