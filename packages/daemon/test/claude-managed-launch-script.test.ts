// #1477 section 1: a managed launch says whether the executable it froze is a `#!` script, so the
// proof of the launched process can allow for a wrapper that exec's the real binary. Drives the real
// ClaudeManagedLaunch.prepare() against private fake executables; no provider, tmux or daemon.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { ClaudeManagedLaunch, fileStartsWithShebang } from "../src/domain/claude-managed-launch.js";

const HELP = '  --permission-mode <mode>   Permission mode to use for the session (choices: "acceptEdits", "auto", "default", "plan")';
const exec = promisify(execFile);
const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

// `file` is the exact bytes of `claude` on the daemon's PATH; it must be a script, which runs on every platform.
async function prepared(file: string, link?: boolean, recordedExecutable?: boolean, isolatedHome?: boolean, launchWrapper?: string[]) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "claude-script-launch-")));
  const cwd = path.join(root, "seat"); const bin = path.join(root, "bin");
  mkdirSync(cwd); mkdirSync(bin); mkdirSync(path.join(root, "home"));
  const target = path.join(link || recordedExecutable ? root : bin, link || recordedExecutable ? "real-claude" : "claude");
  writeFileSync(target, file); chmodSync(target, 0o755);
  if (link) symlinkSync(target, path.join(bin, "claude"));
  // Records its own argv, so a test can prove the wrapper ran and received the native command.
  writeFileSync(path.join(bin, "managed-wrapper"), "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"${0%/*}/wrapper-argv\"\nif [ \"$1\" = --tag ]; then shift 2; fi\nif [ \"$1\" = -- ]; then shift; fi\nexec \"$@\"\n", { mode: 0o755 });
  const db = new Database(":memory:"); open.push(db);
  db.exec(`CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
  db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(cwd);
  db.exec("INSERT INTO bindings VALUES ('binding','node','seat','%1'); INSERT INTO occupant_tenures VALUES ('node','generation-1',1)");
  const managed = new ClaudeManagedLaunch(db, { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(root, "home") }, {});
  const selectedHome = path.join(root, "selected-account");
  if (isolatedHome) mkdirSync(selectedHome);
  return { managed: await managed.prepare({ nodeId: "node", ...(recordedExecutable ? { executable: target } : {}),
    ...(isolatedHome ? { accountHome: selectedHome } : {}), ...(launchWrapper ? { launchWrapper } : {}) }, "auto"), target, resolver: managed, selectedHome };
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

it.each([false, true])("continues with the recorded executable outside daemon PATH and isolated home=%s", async isolated => {
  const { managed, target, resolver, selectedHome } = await prepared(`#!/bin/sh\n${printsHelp}`, false, true, isolated);
  if (isolated) expect(managed.configDir).toBe(selectedHome);
  expect(managed.executable).toBe(target);
  expect(managed.command(["--resume", "same-conversation"])).toContain(target);
  await expect(resolver.prepare({ nodeId: "node" }, "auto")).rejects.toThrow("unavailable on the intended PATH");
  writeFileSync(target, `#!/bin/sh\n${printsHelp}\n# changed`);
  expect(() => managed.assertCurrent()).toThrow("context changed");
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

describe("managed launch_wrapper", () => {
  it.each([false, true])("runs the staged script with native argv and managed homes (isolated home=%s)", async isolated => {
    const file = `#!/bin/sh\nif [ "$1" = --help ]; then\n${printsHelp}else\nprintf '%s\\n' "$0" "$@" > "\${0%/*}/recorded-argv"\nprintf '%s\\n' "\${CLAUDE_CONFIG_DIR-unset}" "$HOME" > "\${0%/*}/recorded-env"\nfi\n`;
    const { managed, target, selectedHome } = await prepared(file, false, false, isolated, ["managed-wrapper", "--tag", "space arg", "--"]);
    const args = ["--resume", "same-conversation", "--session-id", "native-session", "space arg", "quote's", ""];
    const script = path.join(path.dirname(target), "managed-launch.sh");
    writeFileSync(script, `#!/bin/sh\n${managed.command(args)}\n`, { mode: 0o755 });
    await exec("/bin/sh", [script], { env: { HOME: "/wrong-home", CLAUDE_CONFIG_DIR: "/wrong-config", PATH: "/usr/bin:/bin" } });
    expect(readFileSync(path.join(path.dirname(target), "wrapper-argv"), "utf8").split("\n").slice(0, -1)).toEqual(["--tag", "space arg", "--", target, ...args]);
    expect(readFileSync(path.join(path.dirname(target), "recorded-argv"), "utf8").split("\n").slice(0, -1)).toEqual([target, ...args]);
    expect(readFileSync(path.join(path.dirname(target), "recorded-env"), "utf8").split("\n").slice(0, -1)).toEqual([isolated ? selectedHome : "unset", path.join(path.dirname(path.dirname(target)), "home")]);
  });
  it.each([false, true])("places the resolved wrapper after the environment clear and just before the frozen executable, keeping the home (isolated home=%s)", async isolated => {
    const { managed, target, selectedHome } = await prepared(`#!/bin/sh\n${printsHelp}`, false, false, isolated, ["managed-wrapper", "--tag", "space arg", "--"]);
    const command = managed.command(["--resume", "same-conversation"]);
    const wrapper = shellQuote(path.join(path.dirname(target), "managed-wrapper"));
    const tail = `exec /usr/bin/env "$@" ${wrapper} '--tag' 'space arg' '--' ${shellQuote(target)} '--resume' 'same-conversation'`;
    expect(command).toContain(tail);
    expect(command.indexOf('eval "$__openrig_remove"')).toBeLessThan(command.indexOf(tail));
    expect(command.endsWith(`${tail}\n}`)).toBe(true); // the real executable and args are the wrapper's argv, nothing between
    if (isolated) { expect(managed.configDir).toBe(selectedHome); expect(command).toContain(shellQuote(`CLAUDE_CONFIG_DIR=${selectedHome}`)); }
    expect(command).toContain("export 'HOME=");
  });
  it("is byte-identical without a wrapper, and an empty wrapper is none", async () => {
    const plain = (await prepared(`#!/bin/sh\n${printsHelp}`)).managed.command(["--x"]);
    const empty = (await prepared(`#!/bin/sh\n${printsHelp}`, false, false, false, [])).managed.command(["--x"]);
    expect(empty.replace(/claude-script-launch-\w+/g, "R")).toBe(plain.replace(/claude-script-launch-\w+/g, "R"));
    expect(plain).not.toContain("managed-wrapper");
  });
  it.each([["a missing wrapper", ["no-such-wrapper-xyz", "--"]], ["a path that is not an executable file", ["/usr/bin/"]]] as const)("refuses %s with no unwrapped fallback", async (_name, wrapper) => {
    await expect(prepared(`#!/bin/sh\n${printsHelp}`, false, false, false, [...wrapper])).rejects.toThrow(/launch_wrapper unavailable; no agent started\./);
  });
  it("resolves a relative PATH entry against the daemon cwd, as preflight and the classic launch do", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "claude-managed-rel-")));
    const daemon = path.join(root, "daemon"); const seat = path.join(root, "seat");
    for (const dir of [path.join(daemon, "rel"), path.join(seat, "rel"), path.join(root, "bin"), path.join(root, "home")]) mkdirSync(dir, { recursive: true });
    for (const dir of [path.join(daemon, "rel"), path.join(seat, "rel")]) { writeFileSync(path.join(dir, "rel-wrapper"), "#!/bin/sh\nexec \"$@\"\n"); chmodSync(path.join(dir, "rel-wrapper"), 0o755); }
    writeFileSync(path.join(root, "bin", "claude"), `#!/bin/sh\n${printsHelp}`); chmodSync(path.join(root, "bin", "claude"), 0o755);
    const db = new Database(":memory:"); open.push(db);
    db.exec(`CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT); CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
      CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
    db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(seat);
    db.exec("INSERT INTO bindings VALUES ('binding','node','seat','%1'); INSERT INTO occupant_tenures VALUES ('node','generation-1',1)");
    const original = process.cwd();
    try {
      process.chdir(daemon);
      const managed = await new ClaudeManagedLaunch(db, { PATH: `rel:${path.join(root, "bin")}:/usr/bin:/bin`, HOME: path.join(root, "home") }, {})
        .prepare({ nodeId: "node", launchWrapper: ["rel-wrapper", "--"] }, "auto");
      expect(managed.command(["--x"])).toContain(shellQuote(path.join(daemon, "rel", "rel-wrapper")));
      expect(managed.command(["--x"])).not.toContain(path.join(seat, "rel", "rel-wrapper"));
    } finally { process.chdir(original); rmSync(root, { recursive: true, force: true }); }
  });
});

it("a retained config selector and settings reach the actual script without unrelated captured values", async () => {
  const { target, resolver } = await prepared(`#!/bin/sh\nif [ "$1" = --help ]; then ${printsHelp}exit 0; fi\nprintf '%s\\n' "$CLAUDE_CONFIG_DIR" "$@"\n`);
  const root = path.dirname(path.dirname(target)), configDir = path.join(root, "custom config");
  mkdirSync(configDir);
  const settings = path.join(root, "custom settings.json"); writeFileSync(settings, '{"permissions":{"allow":["Read(/kept)"]}}');
  const managed = await resolver.prepare({ nodeId: "node", continuationConfigDir: configDir }, "auto");
  const args = ["--settings", settings, "--model", "opus", "--resume", "same-conversation"];
  const command = managed.command(args);
  expect(command).not.toContain("synthetic-unrelated-secret-2853");
  const { stdout: output } = await exec("/bin/sh", ["-c", command], { encoding: "utf8", env: { NPM_TOKEN: "synthetic-unrelated-secret-2853" } });
  expect(managed.configDir).toBe(configDir);
  expect(output.trimEnd().split("\n")).toEqual([configDir, ...args]);
});
