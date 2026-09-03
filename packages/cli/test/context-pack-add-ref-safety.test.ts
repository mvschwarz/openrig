// Slice-03 rig-context ATOM 2 (STORE) — the WRITE/ADD trust boundary: the CLI
// add path must reject an unsafe install ref BEFORE any filesystem mutation
// (spec §2 path-like refs; sealed Atom-1 per-segment contract, mirrored at
// the CLI trust boundary like the existing manifest hardening). PM watch: the
// matrix pins the ACTUAL reject + no-write behavior verbatim, per clause.
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
taxonomy: world
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
  const origContextRoot = process.env["OPENRIG_CONTEXT_ROOT"];

  afterEach(() => {
    for (const d of [...tmpHomes, ...tmpSrcs]) rmSync(d, { recursive: true, force: true });
    tmpHomes.length = 0;
    tmpSrcs.length = 0;
    if (origHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = origHome;
    if (origContextRoot === undefined) delete process.env["OPENRIG_CONTEXT_ROOT"];
    else process.env["OPENRIG_CONTEXT_ROOT"] = origContextRoot;
  });

  function isolatedHome(): string {
    const home = mkdtempSync(join(tmpdir(), "ctx-add-home-"));
    tmpHomes.push(home);
    process.env["OPENRIG_HOME"] = home;
    process.env["OPENRIG_CONTEXT_ROOT"] = join(home, "context");
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
    expect(existsSync(join(home, "context")), "no store root created").toBe(false);
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
    expect(existsSync(join(home, "context", "packs", "compaction-restore", "manifest.yaml"))).toBe(true);
  });

  // Slice-03 lineage repair (R2 terminal HIGH-1): a lexically-safe path-like ref
  // whose parent namespace segment is a SYMLINK must not let the copy escape the
  // store. The destination namespace must be walked (lstat, reject symlink /
  // non-dir) BEFORE any mutation — mirroring the daemon compose containment.
  it("HIGH-1: rejects a symlinked destination namespace segment — `linked/escape` cannot write outside the store", async () => {
    const home = isolatedHome();
    const src = validSourcePack();
    tmpSrcs.push(src);
    const outside = mkdtempSync(join(tmpdir(), "ctx-add-outside-"));
    tmpSrcs.push(outside);
    const storeRoot = join(home, "context");
    mkdirSync(storeRoot, { recursive: true });
    symlinkSync(outside, join(storeRoot, "linked")); // attacker-planted namespace segment
    let failed = false;
    const origErr = console.error;
    const errLogs: string[] = [];
    console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };
    const origExit = process.exitCode;
    try {
      await makeCmd().parseAsync(["node", "rig", "context", "add", src, "--name", "linked/escape"]);
    } catch { /* commander exitOverride */ }
    failed = process.exitCode === 1;
    console.error = origErr;
    process.exitCode = origExit;
    expect(failed, "add must fail on a symlinked destination namespace").toBe(true);
    expect(errLogs.join("\n")).toMatch(/symlink|namespace|unsafe/i);
    // the REAL pin: nothing was copied THROUGH the symlink to the outside dir
    expect(existsSync(join(outside, "escape")), "no escape write outside the store").toBe(false);
    expect(readdirSync(outside), "outside dir untouched").toEqual([]);
  });

  it("HIGH-1: rejects a dangling destination leaf symlink through the normal CLI error path", async () => {
    const home = isolatedHome();
    const src = validSourcePack();
    tmpSrcs.push(src);
    const storeRoot = join(home, "context");
    const outside = join(home, "outside-missing");
    const leaf = join(storeRoot, "dangle");
    mkdirSync(storeRoot, { recursive: true });
    symlinkSync(outside, leaf);
    const origErr = console.error;
    const errLogs: string[] = [];
    console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };
    const origExit = process.exitCode;
    try {
      await makeCmd().parseAsync(["node", "rig", "context", "add", src, "--name", "dangle"]);
      expect(process.exitCode, "normal CLI rejection, never a signal/abort").toBe(1);
    } finally {
      console.error = origErr;
      process.exitCode = origExit;
    }
    expect(errLogs.join("\n")).toMatch(/symlink|already exists|unsafe/i);
    expect(lstatSync(leaf).isSymbolicLink(), "dangling leaf remains unchanged").toBe(true);
    expect(existsSync(outside), "outside target remains absent").toBe(false);
  });

  // Slice-03 lineage repair (R2 terminal HIGH-2): the install boundary must
  // enforce the bounded, delimiter-free version predicate BEFORE any write.
  it("HIGH-2: rejects an unsafe manifest version at the install boundary BEFORE any fs mutation", async () => {
    const home = isolatedHome();
    const src = mkdtempSync(join(tmpdir(), "ctx-add-badver-"));
    tmpSrcs.push(src);
    writeFileSync(join(src, "manifest.yaml"), "name: badver\nversion: '1:0:0'\nfiles:\n  - path: notes.md\n    role: notes\n");
    writeFileSync(join(src, "notes.md"), "# n\n");
    let failed = false;
    const origErr = console.error;
    const errLogs: string[] = [];
    console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };
    const origExit = process.exitCode;
    try {
      await makeCmd().parseAsync(["node", "rig", "context", "add", src, "--name", "badver"]);
    } catch { /* commander exitOverride */ }
    failed = process.exitCode === 1;
    console.error = origErr;
    process.exitCode = origExit;
    expect(failed, "add must fail on an unsafe version").toBe(true);
    expect(errLogs.join("\n")).toMatch(/version/i);
    expect(existsSync(join(home, "context")), "no store root created — rejected before write").toBe(false);
  });
});
