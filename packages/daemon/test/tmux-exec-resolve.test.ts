import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { execArgvCommand, execCommand, execTmuxCommand, resolveOnPath, spawnTmuxClient } from "../src/adapters/tmux-exec.js";
import { resolveSecret } from "../src/domain/gateway/slack/secrets.js";
import { resolveBearer } from "../src/domain/hosts/remote-daemon-http.js";
import { notificationAdapterFromEnv } from "../src/domain/mission-control/notification-adapter-from-env.js";

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

  it("does not pass dynamic run-grant variables to production tmux clients", async () => {
    const fakeTmuxDir = dir("grant-env");
    fs.writeFileSync(path.join(fakeTmuxDir, "tmux"), [
      "#!/bin/sh",
      'if [ "${OPENRIG_RUN_GRANT_SYNTHETIC+x}" = x ]; then printf present; else printf absent; fi',
      "",
    ].join("\n"), { mode: 0o755 });
    vi.stubEnv("OPENRIG_RUN_GRANT_SYNTHETIC", "synthetic-only");
    vi.stubEnv("PATH", `${fakeTmuxDir}:/usr/bin:/bin`);

    const clientVisibility = [await execCommand("tmux -V"), await execArgvCommand(["tmux", "-V"])];
    expect(clientVisibility).toEqual(["absent", "absent"]);
  });

  // Synthetic values only. The daemon's Slack tokens (both names resolveSecret reads), its notification target and the
  // bearer_env names its host registry configures stay out of tmux clients; provider keys, ordinary configuration and
  // a token-like name nothing configures still arrive; and the daemon's own process keeps every value, which its
  // Slack secrets, its cross-host bearer and its notification adapter still read.
  it("keeps the daemon's Slack, notification and host-registry bearer credentials out of tmux clients, and nothing else", async () => {
    const home = dir("credential-home");
    const registry = path.join(home, "hosts.yaml");
    fs.writeFileSync(registry, "hosts:\n  - id: remote-a\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: SYNTH_REMOTE_A_BEARER\n");
    const excluded = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "OPENRIG_SLACK_BOT_TOKEN", "OPENRIG_SLACK_APP_TOKEN",
      "OPENRIG_NOTIFICATIONS_TARGET", "SYNTH_REMOTE_A_BEARER"];
    const kept = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENRIG_NOTIFICATIONS_MECHANISM", "SYNTH_ORDINARY_SETTING",
      "SYNTH_UNCONFIGURED_TOKEN", "SYNTH_REMOTE_B_BEARER"];
    const fakeTmuxDir = dir("credential-env");
    fs.writeFileSync(path.join(fakeTmuxDir, "tmux"), [
      "#!/bin/sh",
      ...[...excluded, ...kept].map(key => `if [ "\${${key}+x}" = x ]; then printf '${key} '; fi`),
      "",
    ].join("\n"), { mode: 0o755 });
    const values = Object.fromEntries([...excluded, ...kept].map(key => [key, `synthetic-${key.toLowerCase()}`]));
    for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
    vi.stubEnv("OPENRIG_NOTIFICATIONS_TARGET", "https://ntfy.example.invalid/synthetic-topic");
    vi.stubEnv("OPENRIG_NOTIFICATIONS_MECHANISM", "ntfy");
    vi.stubEnv("OPENRIG_HOME", home);
    vi.stubEnv("PATH", `${fakeTmuxDir}:/usr/bin:/bin`);
    const control = async () => {
      const child = await spawnTmuxClient(["-V"]);
      let out = "";
      child.stdout.on("data", chunk => { out += String(chunk); });
      await new Promise(resolve => child.on("close", resolve));
      return out;
    };
    // Every tmux client the daemon starts: the shell, the tmux-only shell and the argv transports, and the control client.
    const seen = async () => [await execCommand("tmux -V"), await execTmuxCommand("tmux -V"), await execArgvCommand(["tmux", "-V"]),
      await control()].map(out => out.trim().split(" ").sort());
    const each = (names: string[]) => Array.from({ length: 4 }, () => [...names].sort());

    expect(await seen()).toEqual(each(kept));

    // A registry edit applies to the next client start, even one of the same size once its modified time changes (set
    // here, so no clock is needed): the edit naming another bearer_env excludes it, and the one it no longer names arrives.
    fs.writeFileSync(registry, "hosts:\n  - id: remote-b\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: SYNTH_REMOTE_B_BEARER\n");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(registry, later, later);
    const afterChange = [...kept.filter(key => key !== "SYNTH_REMOTE_B_BEARER"), "SYNTH_REMOTE_A_BEARER"];
    expect(await seen()).toEqual(each(afterChange));

    // An entry the registry's validation rejects (here a second host with a reserved id) still keeps its name out.
    fs.writeFileSync(registry, "hosts:\n  - id: remote-a\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: SYNTH_REMOTE_A_BEARER\n"
      + "  - id: local\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: SYNTH_REMOTE_B_BEARER\n");
    expect(await seen()).toEqual(each(kept.filter(key => key !== "SYNTH_REMOTE_B_BEARER")));

    // The daemon's own paths read its process environment, which the filter never touches.
    expect(Object.fromEntries(excluded.map(key => [key, process.env[key]]))).toEqual(
      { ...Object.fromEntries(excluded.map(key => [key, values[key]])), OPENRIG_NOTIFICATIONS_TARGET: "https://ntfy.example.invalid/synthetic-topic" });
    expect(resolveSecret("SLACK_BOT_TOKEN")).toBe(values.SLACK_BOT_TOKEN);
    expect(resolveSecret("SLACK_APP_TOKEN")).toBe(values.SLACK_APP_TOKEN);
    expect(resolveBearer({ id: "remote-b", transport: "http", url: "http://127.0.0.1:9", bearer_env: "SYNTH_REMOTE_B_BEARER" }, {}))
      .toEqual({ ok: true, token: values.SYNTH_REMOTE_B_BEARER });
    // The notification adapter the daemon builds at startup still posts to its target.
    const posted: string[] = [];
    const notifier = notificationAdapterFromEnv(process.env, {
      fetchImpl: (async (url: RequestInfo | URL) => { posted.push(String(url)); return new Response(null, { status: 200 }); }) as typeof fetch,
    });
    expect(notifier?.mechanism).toBe("ntfy");
    expect((await notifier!.send({ title: "synthetic", body: "synthetic" })).ok).toBe(true);
    expect(posted).toEqual(["https://ntfy.example.invalid/synthetic-topic"]);
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
