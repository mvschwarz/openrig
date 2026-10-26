// #1477 section 1: a managed launch says whether the executable it froze is a `#!` script, so the
// proof of the launched process can allow for a wrapper that exec's the real binary. Drives the real
// ClaudeManagedLaunch.prepare() against private fake executables; no provider, tmux or daemon.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeManagedLaunch, fileStartsWithShebang } from "../src/domain/claude-managed-launch.js";

const HELP = '  --permission-mode <mode>   Permission mode to use for the session (choices: "acceptEdits", "auto", "default", "plan")';
const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

// `file` is the exact bytes of `claude` on the daemon's PATH; it must be a script, which runs on every platform.
async function prepared(file: string, link?: boolean) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "claude-script-launch-")));
  const cwd = path.join(root, "seat"); const bin = path.join(root, "bin");
  mkdirSync(cwd); mkdirSync(bin); mkdirSync(path.join(root, "home"));
  const target = path.join(link ? root : bin, link ? "real-claude" : "claude");
  writeFileSync(target, file); chmodSync(target, 0o755);
  if (link) symlinkSync(target, path.join(bin, "claude"));
  const db = new Database(":memory:"); open.push(db);
  db.exec(`CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
  db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(cwd);
  db.exec("INSERT INTO bindings VALUES ('binding','node','seat','%1'); INSERT INTO occupant_tenures VALUES ('node','generation-1',1)");
  const managed = new ClaudeManagedLaunch(db, { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(root, "home") }, {});
  return { managed: await managed.prepare({ nodeId: "node" }, "auto"), target };
}
const printsHelp = `printf '%s\\n' '${HELP}'\n`;

it("reports a frozen executable that starts with #! as a script", async () => {
  const { managed, target } = await prepared(`#!/bin/sh\n${printsHelp}`);
  expect(managed.executable).toBe(target);
  expect(managed.executableIsScript).toBe(true);
});

it("reports it through a symlink, whose realpath is the frozen executable", async () => {
  const { managed, target } = await prepared(`#!/bin/sh\n${printsHelp}`, true);
  expect(managed.executable).toBe(target);
  expect(managed.executableIsScript).toBe(true);
});

// Not through prepare(): it runs `--help` on the file first, and a file with no #! at byte 0 can't be exec'd on every
// platform (Linux's execvp hands it to /bin/sh, macOS returns ENOEXEC), so such a fixture would pass only on some hosts.
// prepare() reports exactly this function's answer for the file it froze.
describe("fileStartsWithShebang", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-shebang-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const check = (bytes: string | Buffer) => { const file = path.join(dir, `f${Math.random().toString(36).slice(2)}`); writeFileSync(file, bytes); return fileStartsWithShebang(file); };

  it("is true only for #! at byte 0", () => {
    expect(check("#!/bin/sh\n")).toBe(true);
    expect(check("#!")).toBe(true);
    expect(check("#!/usr/bin/env node\n")).toBe(true);
  });
  it.each([
    ["a leading newline", "\n#!/bin/sh\n"],
    ["a leading space", " #!/bin/sh\n"],
    ["no #! line", "printf help\n"],
    ["a one-byte file", "#"],
    ["an empty file", ""],
    ["an ELF binary", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])],
    ["a Mach-O binary", Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00])],
  ] as const)("is false for %s", (_name, bytes) => { expect(check(bytes as string | Buffer)).toBe(false); });
  it("is false for a missing path and a directory", () => {
    expect(fileStartsWithShebang(path.join(dir, "missing"))).toBe(false);
    expect(fileStartsWithShebang(dir)).toBe(false);
  });
});
