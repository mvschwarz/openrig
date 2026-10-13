import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { execArgvCommand, execCommand, resolveOnPath } from "../src/adapters/tmux-exec.js";

// Fake `tmux` binaries in private directories: each prints its own directory, so a call shows which one ran.
// PATH holds only these directories: a real tmux later on PATH would answer for a fake that has gone.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-tmux-resolve-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

function dir(name: string, tmux?: "exec" | "plain" | "directory"): string {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  const bin = path.join(d, "tmux");
  if (tmux === "directory") fs.mkdirSync(bin);
  else if (tmux) fs.writeFileSync(bin, `#!/bin/sh\necho "${name} $*"\n`, { mode: tmux === "exec" ? 0o755 : 0o644 });
  return d;
}

/** The same tmux call on the shell transport, as main runs it, and on the argv transport: output or failure. */
async function bothTransports(argv: string[], legacy: string): Promise<{ shell: string | { failed: true }; argv: string | { failed: true } }> {
  const settle = (p: Promise<string>) => p.then((out) => out, () => ({ failed: true as const }));
  return { shell: await settle(execCommand(legacy)), argv: await settle(execArgvCommand(argv)) };
}

// dash goes on to the next PATH entry when a file's interpreter is missing; bash, sh on macOS, stops there.
const shellIsDash = process.platform !== "win32"
  && execFileSync("/bin/sh", ["-c", "echo ${BASH_VERSION:-none}"], { encoding: "utf8" }).trim() === "none"
  && fs.realpathSync("/bin/sh").endsWith("/dash");

// Each case spawns a few shells, which takes seconds on a loaded host.
describe.skipIf(process.platform === "win32")("tmux binary resolution", { timeout: 60_000 }, () => {
  it("takes the first regular executable in PATH order, as execvp does", () => {
    const first = dir("first", "exec"), second = dir("second", "exec");
    expect(resolveOnPath("tmux", `${first}:${second}`)).toBe(path.join(first, "tmux"));
    expect(resolveOnPath("tmux", `${second}:${first}`)).toBe(path.join(second, "tmux"));
  });

  it("skips a non-executable file, a directory and a missing entry", () => {
    const plain = dir("plain", "plain"), folder = dir("folder", "directory"), empty = dir("empty"), real = dir("real", "exec");
    expect(resolveOnPath("tmux", `${empty}:${plain}:${folder}:${real}`)).toBe(path.join(real, "tmux"));
    expect(resolveOnPath("tmux", `${empty}:${plain}`)).toBeNull();
    expect(resolveOnPath("tmux", undefined)).toBeNull();
  });

  it("leaves the lookup to the spawn when an earlier entry depends on the cwd", () => {
    const real = dir("cwd-real", "exec");
    expect(resolveOnPath("tmux", `relative/bin:${real}`)).toBeNull();
    expect(resolveOnPath("tmux", `:${real}`)).toBeNull();
    expect(resolveOnPath("tmux", `${real}:relative/bin`)).toBe(path.join(real, "tmux"));
  });

  it("runs the resolved binary with the argv unchanged, and follows a PATH change", async () => {
    const a = dir("run-a", "exec"), b = dir("run-b", "exec");
    vi.stubEnv("PATH", `${a}:${b}`);
    expect(await execArgvCommand(["tmux", "list-sessions", "-F", "#{session_name} x"])).toBe("run-a list-sessions -F #{session_name} x\n");
    vi.stubEnv("PATH", `${b}:${a}`);
    expect(await execArgvCommand(["tmux", "-V"])).toBe("run-b -V\n");
  });

  it("falls back to the shell when the cached binary has gone, and the shell finds the next one", async () => {
    const a = dir("gone-a", "exec"), b = dir("gone-b", "exec");
    vi.stubEnv("PATH", `${a}:${b}`);
    expect(await execArgvCommand(["tmux", "-V"])).toBe("gone-a -V\n");
    fs.rmSync(path.join(a, "tmux"));
    expect(await execArgvCommand(["tmux", "-V"])).toBe("gone-b -V\n");
    // Only a non-executable one is left: the shell reports it, as on the shell transport.
    fs.chmodSync(path.join(b, "tmux"), 0o644);
    await expect(execArgvCommand(["tmux", "-V"])).rejects.toMatchObject({ code: 126 });
  });

  it("fails like the shell transport when no PATH entry has the binary", async () => {
    vi.stubEnv("PATH", `${dir("none")}:/nonexistent`);
    await expect(execArgvCommand(["tmux", "-V"])).rejects.toMatchObject({ code: 127, message: expect.stringMatching(/tmux: .*not found/) });
  });

  it("runs a first tmux without a #! line as a script, as the shell transport does", async () => {
    const plain = dir("noshebang"), later = dir("noshebang-later", "exec");
    fs.writeFileSync(path.join(plain, "tmux"), `echo "noshebang $*"\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${plain}:${later}:/usr/bin:/bin`);
    expect(await execArgvCommand(["tmux", "-V"])).toBe("noshebang -V\n");
  });

  it("agrees with the shell transport when the first tmux's interpreter is missing", async () => {
    const broken = dir("no-interpreter"), later = dir("interpreter-later", "exec");
    fs.writeFileSync(path.join(broken, "tmux"), `#!${path.join(root, "missing-interpreter")}\necho broken\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${broken}:${later}:/usr/bin:/bin`);
    const got = await bothTransports(["tmux", "list-sessions", "-F", "#{session_name} x"], "tmux list-sessions -F '#{session_name} x'");
    expect(got.argv).toEqual(got.shell);
    if (shellIsDash) expect(got.argv).toBe("interpreter-later list-sessions -F #{session_name} x\n");
  });

  it("runs each command at most once after a spawn error, as often as the shell transport, and never again after tmux itself failed", async () => {
    const broken = dir("once-broken"), counted = dir("once-counted"), log = path.join(root, "once.log");
    const runs = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    fs.writeFileSync(path.join(broken, "tmux"), `#!${path.join(root, "missing-interpreter")}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(counted, "tmux"), `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = fail ] && { echo "tmux failed" >&2; exit 1; }\necho ok\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${broken}:${counted}:/usr/bin:/bin`);
    // The shell transport alone: the runs main makes on this host's shell, one or none.
    const shellOut = await execCommand("tmux send-keys shell").catch(() => null);
    const shellRuns = runs().length;
    expect(shellRuns).toBe(shellOut === null ? 0 : 1);
    const argvOut = await execArgvCommand(["tmux", "send-keys", "argv"]).catch(() => null);
    expect(argvOut).toBe(shellOut);
    expect(runs().slice(shellRuns)).toEqual(shellRuns ? ["send-keys argv"] : []);

    // A cached tmux removed after its first call: the spawn error goes to the shell, which every shell sends on to the next entry.
    const gone = dir("once-gone", "exec");
    vi.stubEnv("PATH", `${gone}:${counted}:/usr/bin:/bin`);
    expect(await execArgvCommand(["tmux", "-V"])).toBe("once-gone -V\n");
    fs.rmSync(path.join(gone, "tmux"));
    const before = runs().length;
    expect(await execArgvCommand(["tmux", "send-keys", "after-gone"])).toBe("ok\n");
    expect(runs().slice(before)).toEqual(["send-keys after-gone"]);

    // tmux ran and failed: never run again.
    vi.stubEnv("PATH", `${counted}:/usr/bin:/bin`);
    await expect(execArgvCommand(["tmux", "fail"])).rejects.toMatchObject({ code: 1 });
    expect(runs().slice(before + 1)).toEqual(["fail"]);
  });

  // Accepted: a tmux installed earlier on PATH is seen when PATH changes, the cached one fails, or the daemon restarts.
  it("keeps the cached binary while it still runs, until PATH changes", async () => {
    const early = dir("stale-early"), late = dir("stale-late", "exec");
    vi.stubEnv("PATH", `${early}:${late}`);
    expect(await execArgvCommand(["tmux", "-V"])).toBe("stale-late -V\n");
    fs.writeFileSync(path.join(early, "tmux"), `#!/bin/sh\necho "stale-early $*"\n`, { mode: 0o755 });
    expect(await execArgvCommand(["tmux", "-V"])).toBe("stale-late -V\n");
    vi.stubEnv("PATH", `${early}:${late}:/nonexistent`);
    expect(await execArgvCommand(["tmux", "-V"])).toBe("stale-early -V\n");
  });
});
