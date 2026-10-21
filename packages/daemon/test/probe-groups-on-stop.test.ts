import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { ProbeStoppedError, boundedProbeExec, endRunningProbeGroups } from "../src/adapters/bounded-probe-exec.js";
import { execPreflightCommand, runtimeProbeFailure } from "../src/adapters/preflight-exec.js";

// A runtime probe runs in its own detached process group, so nothing ends it when the daemon stops first.
const roots: string[] = [];
function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-groups-"));
  roots.push(root);
  return root;
}
// Every probe child a test saw, whichever module instance started it (vi.resetModules gives the test its own
// registry, which the afterEach below cannot reach): a failing test must not leave one running.
const seenPids = new Set<number>();
// Cleanups for probes a test started outside the shared module instance.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await endRunningProbeGroups(200);
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const pid of seenPids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  seenPids.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim() : "";
    if (text) { seenPids.add(Number(text)); return Number(text); }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no pid written to ${file}`);
}
/** Resolves when the daemon child prints "ready"; fails the test if it doesn't within the bound. */
function waitFor(isReady: Promise<void>, what: string, ms = 30_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} not ready within ${ms} ms`)), ms); });
  return Promise.race([isReady, bound]).finally(() => clearTimeout(timer));
}
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe.skipIf(process.platform === "win32")("runtime probe groups end when the daemon stops", () => {
  it("ends a hung probe and the child it spawned", async () => {
    const pidFile = path.join(scratch(), "child.pid");
    const probe = boundedProbeExec()(`sleep 600 & echo $! > ${pidFile}; wait`);
    const settled = probe.then(() => "answered", () => "rejected");
    const child = await readPid(pidFile);
    expect(alive(child)).toBe(true);

    await endRunningProbeGroups(200);

    expect(await settled).toBe("rejected");
    expect(await gone(child)).toBe(true);
  });

  it("starts no probe once the daemon is stopping", async () => {
    vi.resetModules();
    const fresh = await import("../src/adapters/bounded-probe-exec.js");
    cleanups.push(() => fresh.endRunningProbeGroups(200));
    const marker = path.join(scratch(), "ran");
    await fresh.stopRuntimeProbes(200);
    await expect(fresh.boundedProbeExec()(`touch ${marker}`)).rejects.toThrow(/daemon is stopping/);
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("leaves a probe that finished alone", async () => {
    await expect(boundedProbeExec()("echo 1.2.3")).resolves.toContain("1.2.3");
    await expect(endRunningProbeGroups(200)).resolves.toBeUndefined();
  });

  it("ends the group of a hung runtime version preflight", async () => {
    const root = scratch();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nsleep 600 &\necho $! > ${path.join(root, "child.pid")}\nwait\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    try {
      const settled = execPreflightCommand("codex --version").then(() => "answered", () => "rejected");
      const child = await readPid(path.join(root, "child.pid"));

      await endRunningProbeGroups(200);

      expect(await settled).toBe("rejected");
      expect(await gone(child)).toBe(true);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("reports a probe the daemon's stop ended as cut short, not as a failed runtime", () => {
    expect(runtimeProbeFailure(new ProbeStoppedError("codex --version", "ended"))).toBe("check cut short: the daemon is stopping");
  });

  it("keeps the preflight failure details for a missing runtime", async () => {
    const root = scratch();
    const savedPath = process.env.PATH;
    process.env.PATH = root;
    try {
      const err = await execPreflightCommand("pi --version").catch((e: unknown) => e);
      expect(runtimeProbeFailure(err)).toBe("exit status 127; executable not found on PATH");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("ends a probe's group when the daemon is signalled before it listens", async () => {
    const pidFile = path.join(scratch(), "child.pid");
    const daemon = spawn(process.execPath, [
      "--import", createRequire(import.meta.url).resolve("tsx"),
      path.join(import.meta.dirname, "fixtures/probe-startup-signal.ts"), pidFile,
    ], { stdio: ["ignore", "pipe", "inherit"] });
    const closed = new Promise<NodeJS.Signals | null>((resolve) => daemon.once("close", (_code, signal) => resolve(signal)));
    try {
      const child = await readPid(pidFile);
      expect(alive(child)).toBe(true);

      daemon.kill("SIGTERM");

      expect(await closed).toBe("SIGTERM");
      expect(await gone(child)).toBe(true);
    } finally {
      daemon.kill("SIGKILL");
      const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf-8").trim()) : 0;
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("ends the group when the daemon process exits on its own", async () => {
    const pidFile = path.join(scratch(), "child.pid");
    const daemon = spawn(process.execPath, [
      "--import", createRequire(import.meta.url).resolve("tsx"),
      path.join(import.meta.dirname, "fixtures/probe-exit-hook.ts"), pidFile,
    ], { stdio: "ignore" });
    const closed = new Promise<number | null>((resolve) => daemon.once("close", (code) => resolve(code)));
    try {
      const child = await readPid(pidFile);
      expect(alive(child)).toBe(true);

      expect(await closed).toBe(0);
      expect(await gone(child)).toBe(true);
    } finally {
      daemon.kill("SIGKILL");
      const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf-8").trim()) : 0;
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("a listening daemon ends the probe group in its shutdown, and still shuts down cleanly", async () => {
    const root = scratch();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    // The startup Codex probe on a fresh database answers at once.
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 0.139.0'\n", { mode: 0o755 });
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, "openrig"), { recursive: true });
    const pidFile = path.join(root, "child.pid");
    const termMarker = path.join(root, "got-term");
    const daemon = spawn(process.execPath, [
      "--import", createRequire(import.meta.url).resolve("tsx"),
      path.join(import.meta.dirname, "fixtures/listening-daemon-with-probe.ts"), pidFile, termMarker,
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, TMPDIR: os.tmpdir(), VITEST: "true", OPENRIG_NO_KERNEL: "1",
        OPENRIG_HOME: path.join(home, "openrig"), OPENRIG_DB: path.join(home, "openrig", "test.sqlite"),
        CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
        TMUX_TMPDIR: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
      },
    });
    let ready: (v: void) => void;
    const isReady = new Promise<void>((resolve) => { ready = resolve; });
    let output = "";
    daemon.stdout!.on("data", (chunk: Buffer) => { output += String(chunk); if (output.includes("ready")) ready(); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => daemon.once("close", (code, signal) => resolve({ code, signal })));
    try {
      await waitFor(isReady, "the listening daemon");
      expect(JSON.parse(output.split("\n").find((line) => line.startsWith("{"))!)).toEqual({ addedSIGINT: 1, addedSIGTERM: 1 });
      const child = await readPid(pidFile);
      expect(alive(child)).toBe(true);

      daemon.kill("SIGTERM");

      // Exit 0 and a clean receipt: the real shutdown handler ran. If the startup handler were still armed it
      // would re-raise SIGTERM and the daemon would die of the signal instead.
      expect(await closed).toEqual({ code: 0, signal: null });
      expect(JSON.parse(fs.readFileSync(path.join(home, "openrig", "daemon-shutdown.json"), "utf-8"))).toMatchObject({ outcome: "clean" });
      expect(await gone(child)).toBe(true);
      // The "runtime-probes" shutdown phase TERMed the group; the exit hook alone would only KILL it.
      expect(fs.existsSync(termMarker)).toBe(true);
    } finally {
      daemon.kill("SIGKILL");
      const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf-8").trim()) : 0;
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("a daemon that stops during a runtime probe", () => {
  it.each(["stopRuntimeProbes", "endRunningProbeGroups"] as const)("keeps the verified row, tries no --help, and records nothing (%s)", async (ending) => {
    vi.resetModules();
    const fresh = await import("../src/adapters/bounded-probe-exec.js");
    const { boundedProbeExec: bounded } = fresh;
    cleanups.push(() => fresh.endRunningProbeGroups(200));
    const { RuntimeVerifier } = await import("../src/domain/runtime-verifier.js");
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const root = scratch();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const helpMarker = path.join(root, "help-ran");
    fs.writeFileSync(path.join(bin, "codex"),
      `#!/bin/sh\ncase "$1" in --help) touch ${helpMarker} ;; esac\nsleep 600 &\necho $! > ${path.join(root, "child.pid")}\nwait\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    try {
      // A verified row from an earlier start.
      await new RuntimeVerifier({ exec: async () => "codex-cli 0.139.0", db }).verifyCodex();
      const before = db.prepare("SELECT * FROM runtime_verifications WHERE runtime = 'codex'").all();
      expect(before).toHaveLength(1);

      process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
      const verifying = new RuntimeVerifier({ exec: async () => { throw new Error("unused"); }, db, probeExec: bounded() }).verifyCodex();
      const outcome = verifying.then(() => undefined, (err: unknown) => err);
      await readPid(path.join(root, "child.pid"));

      await fresh[ending](200);

      expect(await outcome).toBeInstanceOf(fresh.ProbeStoppedError);
      expect(fs.existsSync(helpMarker)).toBe(false);
      expect(db.prepare("SELECT * FROM runtime_verifications WHERE runtime = 'codex'").all()).toEqual(before);
    } finally {
      process.env.PATH = savedPath;
      db.close();
    }
  });

  it.each(["stopRuntimeProbes", "endRunningProbeGroups"] as const)("a probe the stop ended is no answer even if it exits 0 with a version (%s)", async (ending) => {
    vi.resetModules();
    const fresh = await import("../src/adapters/bounded-probe-exec.js");
    cleanups.push(() => fresh.endRunningProbeGroups(200));
    const { RuntimeVerifier } = await import("../src/domain/runtime-verifier.js");
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const root = scratch();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    // Traps TERM, prints a different version and exits 0: what the stop does to it is its own business.
    fs.writeFileSync(path.join(bin, "codex"),
      `#!/bin/sh\ntrap 'echo codex-cli 9.9.9; exit 0' TERM\nsleep 600 &\necho $! > ${path.join(root, "ready")}.$$\nwait\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    try {
      await new RuntimeVerifier({ exec: async () => "codex-cli 1.0.0", db }).verifyCodex();
      const before = db.prepare("SELECT * FROM runtime_verifications WHERE runtime = 'codex'").all();
      expect(before).toHaveLength(1);

      process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
      const direct = fresh.boundedProbeExec()("codex --version").then((out) => ({ out }), (err: unknown) => ({ err }));
      const verifying = new RuntimeVerifier({ exec: async () => { throw new Error("unused"); }, db, probeExec: fresh.boundedProbeExec() }).verifyCodex();
      const outcome = verifying.then(() => undefined, (err: unknown) => err);
      // Each probe writes its own marker once its trap is installed: stop only when both are up.
      const markers = () => fs.readdirSync(root).filter((name) => name.startsWith("ready.") && fs.readFileSync(path.join(root, name), "utf-8").trim());
      for (let i = 0; i < 400 && markers().length < 2; i++) await new Promise((r) => setTimeout(r, 25));
      expect(markers()).toHaveLength(2);
      for (const name of markers()) await readPid(path.join(root, name));

      await fresh[ending](500);

      expect(await outcome).toBeInstanceOf(fresh.ProbeStoppedError);
      const ended = await direct;
      expect("out" in ended).toBe(false);
      expect((ended as { err: unknown }).err).toBeInstanceOf(fresh.ProbeStoppedError);
      expect(db.prepare("SELECT * FROM runtime_verifications WHERE runtime = 'codex'").all()).toEqual(before);
    } finally {
      process.env.PATH = savedPath;
      db.close();
    }
  });
});
