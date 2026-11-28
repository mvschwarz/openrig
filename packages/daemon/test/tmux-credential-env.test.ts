import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withoutTmuxCredentialEnv } from "../src/adapters/tmux-credential-env.js";

// Every file the helper reads, so a test can count the host registry's reads; a file in `failing` fails its next read,
// and a file in `frozen` keeps the stat it has there (a rewrite within one coarse timestamp tick).
const reads = vi.hoisted(() => [] as string[]);
const failing = vi.hoisted(() => new Set<string>());
const frozen = vi.hoisted(() => new Map<string, unknown>());
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: ((file: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
    reads.push(String(file));
    if (failing.delete(String(file))) throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
    return (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFileSync, statSync: ((file: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) =>
    frozen.get(String(file)) ?? (actual.statSync as (...args: unknown[]) => unknown)(file, ...rest)) as typeof actual.statSync };
});

/** Sets the clock `ms` after the registry file's last change (the later of its modified and changed times). */
function clockAfterChange(file: string, ms: number): void {
  const s = statSync(file, { bigint: true });
  vi.setSystemTime(Number((s.mtimeNs > s.ctimeNs ? s.mtimeNs : s.ctimeNs) / 1_000_000n) + ms);
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "tmux credential env "));
  vi.stubEnv("OPENRIG_HOME", home);
  reads.length = 0;
  failing.clear();
  frozen.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

// Synthetic values only.
it("filters a whole environment reading the host registry once, and leaves the given environment as it was", () => {
  const registry = path.join(home, "hosts.yaml");
  writeFileSync(registry, "hosts:\n  - id: remote-a\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: SYNTH_REMOTE_A_BEARER\n");
  const ordinary = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`SYNTH_ORDINARY_${i}`, `value-${i}`]));
  const env = { ...ordinary, ANTHROPIC_API_KEY: "synthetic-provider", SLACK_BOT_TOKEN: "synthetic-bot", SYNTH_REMOTE_A_BEARER: "synthetic-bearer" };

  const kept = withoutTmuxCredentialEnv(env);

  expect(reads.filter(file => file === registry)).toHaveLength(1);
  expect(kept).toEqual({ ...ordinary, ANTHROPIC_API_KEY: "synthetic-provider" });
  expect(env.SLACK_BOT_TOKEN).toBe("synthetic-bot");
  expect(env.SYNTH_REMOTE_A_BEARER).toBe("synthetic-bearer");
});

it("a host registry that does not parse names no bearer_env, and filtering still drops the fixed names without throwing", () => {
  writeFileSync(path.join(home, "hosts.yaml"), "hosts:\n  - id: remote-a\n    bearer_env: SYNTH_REMOTE_A_BEARER\n   - [unclosed\n");
  expect(withoutTmuxCredentialEnv({ SYNTH_REMOTE_A_BEARER: "synthetic-bearer", SLACK_APP_TOKEN: "synthetic-app" }))
    .toEqual({ SYNTH_REMOTE_A_BEARER: "synthetic-bearer" });
});

it("reuses the parsed bearer_env names until the registry file changes, and a same-size edit is read again", () => {
  const registry = path.join(home, "hosts.yaml");
  writeFileSync(registry, "hosts:\n  - id: remote-a\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: SYNTH_REMOTE_A_BEARER\n");
  const env = { SYNTH_REMOTE_A_BEARER: "synthetic-a", SYNTH_REMOTE_B_BEARER: "synthetic-b" };

  clockAfterChange(registry, 3_000);
  expect(withoutTmuxCredentialEnv(env)).toEqual({ SYNTH_REMOTE_B_BEARER: "synthetic-b" });
  expect(withoutTmuxCredentialEnv(env)).toEqual({ SYNTH_REMOTE_B_BEARER: "synthetic-b" });
  expect(reads.filter(file => file === registry)).toHaveLength(1);

  writeFileSync(registry, "hosts:\n  - id: remote-b\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: SYNTH_REMOTE_B_BEARER\n");
  // the modified time an edit gets once the file system's timestamp tick has passed, so both writes never share a stamp
  const later = new Date(Date.now() + 60_000);
  utimesSync(registry, later, later);
  clockAfterChange(registry, 3_000);
  expect(withoutTmuxCredentialEnv(env)).toEqual({ SYNTH_REMOTE_A_BEARER: "synthetic-a" });
  expect(reads.filter(file => file === registry)).toHaveLength(2);
});

it("a registry changed in the last two seconds is read on every call, even when a same-size rewrite keeps its stat, and is reused once it settles", () => {
  const registry = path.join(home, "hosts.yaml");
  writeFileSync(registry, "hosts:\n  - id: remote-a\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: SYNTH_REMOTE_A_BEARER\n");
  frozen.set(registry, statSync(registry, { bigint: true }));
  const env = { SYNTH_REMOTE_A_BEARER: "synthetic-a", SYNTH_REMOTE_B_BEARER: "synthetic-b" };

  clockAfterChange(registry, 1_000);
  expect(withoutTmuxCredentialEnv(env)).toEqual({ SYNTH_REMOTE_B_BEARER: "synthetic-b" });
  // the same device, inode, size and times: a rewrite that landed within the same timestamp tick
  writeFileSync(registry, "hosts:\n  - id: remote-b\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: SYNTH_REMOTE_B_BEARER\n");
  expect(withoutTmuxCredentialEnv(env)).toEqual({ SYNTH_REMOTE_A_BEARER: "synthetic-a" });
  expect(reads.filter(file => file === registry)).toHaveLength(2);

  clockAfterChange(registry, 3_000);
  withoutTmuxCredentialEnv(env);
  expect(withoutTmuxCredentialEnv(env)).toEqual({ SYNTH_REMOTE_A_BEARER: "synthetic-a" });
  expect(reads.filter(file => file === registry)).toHaveLength(3);
});

it("a registry read that fails is not reused: the next call on the untouched file reads it again and drops the name", () => {
  const registry = path.join(home, "hosts.yaml");
  writeFileSync(registry, "hosts:\n  - id: remote-a\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: SYNTH_REMOTE_A_BEARER\n");
  const env = { SYNTH_REMOTE_A_BEARER: "synthetic-a", SYNTH_ORDINARY: "ordinary" };

  clockAfterChange(registry, 3_000);
  failing.add(registry);
  withoutTmuxCredentialEnv(env);
  expect(withoutTmuxCredentialEnv(env)).toEqual({ SYNTH_ORDINARY: "ordinary" });
  expect(reads.filter(file => file === registry)).toHaveLength(2);
});

it("a registry with an old modified time but a changed time under two seconds old is still read on every call", () => {
  const registry = path.join(home, "hosts.yaml");
  writeFileSync(registry, "hosts:\n  - id: remote-a\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: SYNTH_REMOTE_A_BEARER\n");
  // a rewrite that put back an old modified time (touch -m, a restore): only the changed time says it is fresh
  const earlier = new Date(Date.now() - 60_000);
  utimesSync(registry, earlier, earlier);
  clockAfterChange(registry, 1_000);
  const env = { SYNTH_REMOTE_A_BEARER: "synthetic-a" };

  withoutTmuxCredentialEnv(env);
  withoutTmuxCredentialEnv(env);
  expect(reads.filter(file => file === registry)).toHaveLength(2);
});

it("never takes PATH, HOME, SHELL or TMUX_TMPDIR as a bearer_env, so a typo can't stop tmux clients from starting", () => {
  writeFileSync(path.join(home, "hosts.yaml"), ["hosts:", ...["PATH", "HOME", "SHELL", "TMUX_TMPDIR", "SYNTH_REMOTE_A_BEARER"]
    .map((name, i) => `  - id: remote-${i}\n    transport: http\n    url: http://127.0.0.1:9\n    bearer_env: ${name}`), ""].join("\n"));
  const env = { PATH: "/usr/bin", HOME: "/home/synthetic", SHELL: "/bin/sh", TMUX_TMPDIR: "/tmp/synthetic", SYNTH_REMOTE_A_BEARER: "synthetic" };
  expect(withoutTmuxCredentialEnv(env)).toEqual({ PATH: "/usr/bin", HOME: "/home/synthetic", SHELL: "/bin/sh", TMUX_TMPDIR: "/tmp/synthetic" });
});
