import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { stageTopologyRoot } from "./helpers/scenario-stage.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareHermeticEnv,
  assertNoAmbientTmux,
  detectAmbientTmuxHazard,
  AmbientTmuxHazardError,
  TMUX_ATTACHMENT_ENV_VARS,
  type HermeticScaffold,
} from "./helpers/hermetic-env.js";

// 51-02 delta D5 (advisor-ruled, guard precision pins) — TMUX ISOLATION.
//
// A scenario `up` stands up REAL tmux seats. TMUX_TMPDIR alone is not an
// identity: once its directory disappears a later command can resolve elsewhere.
// The helper therefore wraps every child invocation with one explicit private
// socket and refuses an ambient attachment before creating anything.

const scaffolds: HermeticScaffold[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of scaffolds.splice(0)) s.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cleanBase = () => ({ HOME: "/tmp/whatever", PATH: process.env.PATH, TERM: "xterm" });

describe("D5 p1 — an ambient TMUX attachment refuses BEFORE any side effect", () => {
  it("detects TMUX as its own named hazard category (not a daemon target, not a clock)", () => {
    expect(TMUX_ATTACHMENT_ENV_VARS as readonly string[]).toContain("TMUX");
    const h = detectAmbientTmuxHazard({ TMUX: "/private/tmp/tmux-501/default,12345,0" });
    expect(h).not.toBeNull();
    expect(h!.name).toBe("TMUX");
    expect(() => assertNoAmbientTmux({ TMUX: "/tmp/x,1,0" })).toThrow(AmbientTmuxHazardError);
    expect(detectAmbientTmuxHazard(cleanBase())).toBeNull();
    expect(detectAmbientTmuxHazard({ TMUX: "" })).toBeNull(); // exported-but-empty is absent
  });

  it("refuses with a message naming the fleet hazard and creates NO scaffold dir", () => {
    // Measure in a PRIVATE temp root: scaffolds are created under os.tmpdir(),
    // which reads TMPDIR per call, so pointing it at our own dir makes the
    // pre-effect assertion immune to whatever other suites are doing in the
    // shared /tmp (counting shared dirs is a self-induced contention flake).
    const priv = mkdtempSync(join(tmpdir(), "tmux-preeffect-"));
    dirs.push(priv);
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = priv;
    let msg = "";
    try {
      expect(() => {
        try {
          prepareHermeticEnv({ baseEnv: { ...cleanBase(), TMUX: "/private/tmp/tmux-501/default,999,0" } });
        } catch (e) {
          msg = (e as Error).message;
          throw e;
        }
      }).toThrow(AmbientTmuxHazardError);
      // pre-effect: the private root is still EMPTY — no scaffold was created
      expect(readdirSync(priv)).toEqual([]);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    }
    expect(msg).toContain("TMUX");
    expect(msg.toLowerCase()).toContain("server");
  });
});

describe("D5 p2 — an inherited TMUX_TMPDIR is ABSENT from the child and REPLACED by the scaffold's own", () => {
  it("proves both halves independently", () => {
    const inherited = mkdtempSync(join(tmpdir(), "ambient-tmux-"));
    try {
      const s = prepareHermeticEnv({ baseEnv: { ...cleanBase(), TMUX_TMPDIR: inherited } });
      scaffolds.push(s);
      // (a) the inherited value is gone
      expect(s.env.TMUX_TMPDIR).not.toBe(inherited);
      // (b) it is replaced by a scaffold-OWNED, existing directory
      expect(s.env.TMUX_TMPDIR).toBe(s.tmuxTmpDir);
      expect(s.tmuxTmpDir.startsWith(s.root)).toBe(true);
      expect(existsSync(s.tmuxTmpDir)).toBe(true);
    } finally {
      rmSync(inherited, { recursive: true, force: true });
    }
  });

  it("sets an owned TMUX_TMPDIR even when the base env carries none", () => {
    const s = prepareHermeticEnv({ baseEnv: cleanBase() });
    scaffolds.push(s);
    expect(s.env.TMUX_TMPDIR).toBe(s.tmuxTmpDir);
    expect(s.tmuxTmpDir.startsWith(s.root)).toBe(true);
    expect(existsSync(s.tmuxTmpDir)).toBe(true);
    // cleanup removes the scaffold-owned server dir with everything else
    s.cleanup();
    expect(existsSync(s.tmuxTmpDir)).toBe(false);
  });

  it("keeps the socket path SHORT enough for sun_path (~104 bytes)", () => {
    const s = prepareHermeticEnv({ baseEnv: cleanBase() });
    scaffolds.push(s);
    expect(Buffer.byteLength(s.tmuxSocketPath)).toBeLessThan(104);
  });

  it.each([false, true])("waits for a pane's delayed child writer before removing scratch HOME (repeated HUP: %s)", async (repeatedHup) => {
    const { execFile } = await import("node:child_process");
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const evidence = mkdtempSync(join(tmpdir(), "late-writer-"));
    dirs.push(evidence);
    const ready = join(evidence, "ready"), done = join(evidence, "done");
    const s = prepareHermeticEnv({ baseEnv: cleanBase() });
    scaffolds.push(s);
    const writer = join(evidence, "writer.cjs");
    writeFileSync(writer, `
const { writeFileSync, mkdirSync } = require("node:fs");
if (process.argv[2] === "child") {
  let hups = 0;
  // The terminal's hangup and the parent's forwarding can both reach this child.
  process.on("SIGHUP", () => {
    if (++hups === 1) process.send?.("hup");
    if (hups !== ${repeatedHup ? 2 : 1}) return;
    setTimeout(() => {
      mkdirSync(${JSON.stringify(s.home)}, { recursive: true });
      writeFileSync(${JSON.stringify(join(s.home, "late-write"))}, "last write");
      writeFileSync(${JSON.stringify(done)}, JSON.stringify({ hups }));
      process.exit(0);
    }, 150);
  });
  writeFileSync(${JSON.stringify(ready)}, String(process.pid));
} else {
  const child = require("node:child_process").spawn(process.execPath, [__filename, "child"], { stdio: ${repeatedHup ? '["ignore", "ignore", "ignore", "ipc"]' : '"ignore"'} });
  // Handshake guarantees the second HUP follows the child's first handler, rather than coalescing.
  if (${repeatedHup}) child.once("message", () => { child.kill("SIGHUP"); process.exit(0); });
  process.once("SIGHUP", () => { child.kill("SIGHUP"); if (!${repeatedHup}) process.exit(0); });
}
setInterval(() => {}, 1000);
`);
    await run("tmux", ["-S", s.tmuxSocketPath, "new-session", "-d", "-s", "writer",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(writer)}`], {
      env: s.env as NodeJS.ProcessEnv,
    });
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 2_000, interval: 10 });
    const childPid = Number(readFileSync(ready, "utf8"));
    try {
      s.cleanup();
      // The parent pane exits immediately; the child has a controlled final write.
      // Teardown must wait for that child, rather than racing recursive removal.
      await vi.waitFor(() => expect(existsSync(done)).toBe(true), { timeout: 2_000, interval: 10 });
      expect(JSON.parse(readFileSync(done, "utf8")).hups).toBeGreaterThanOrEqual(repeatedHup ? 2 : 1);
      expect(existsSync(s.root)).toBe(false);
    } finally {
      try { process.kill(childPid, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  });

  it.each([false, true])("settles the timeout fixture even if readiness fails (%s)", async (failReadiness) => {
    const { execFile } = await import("node:child_process");
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const evidence = mkdtempSync(join(tmpdir(), "cleanup-timeout-"));
    dirs.push(evidence);
    const ready = join(evidence, "ready"), stopped = join(evidence, "stopped");
    const s = prepareHermeticEnv({ baseEnv: cleanBase() });
    const writer = join(evidence, "writer.cjs");
    writeFileSync(writer, `
const { writeFileSync } = require("node:fs");
if (process.argv[2] === "child") {
  process.once("SIGHUP", () => writeFileSync(${JSON.stringify(stopped)}, "still alive"));
  writeFileSync(${JSON.stringify(ready)}, String(process.pid));
} else {
  let child;
  process.once("SIGHUP", () => child?.kill("SIGHUP"));
  process.once("SIGTERM", () => { if (child) child.kill("SIGTERM"); else process.exit(0); });
  child = require("node:child_process").spawn(process.execPath, [__filename, "child"], { stdio: "ignore" });
  child.once("exit", () => process.exit(0));
}
setInterval(() => {}, 1000);
`);
    const at = (args: string[]) => run("tmux", ["-S", s.tmuxSocketPath, ...args], {
      env: s.env as NodeJS.ProcessEnv, timeout: 2_000,
    });
    let panePid: number | undefined, serverPid: number | undefined;
    const exercise = async () => {
      try {
        const started = await at(["new-session", "-d", "-P", "-F", "#{pid} #{pane_pid}", "-s", "writer",
          process.execPath, writer]);
        [serverPid, panePid] = started.stdout.trim().split(/\s+/).map(Number);
        await vi.waitFor(() => {
          expect(existsSync(ready)).toBe(true);
          if (failReadiness) throw new Error("forced readiness failure");
        }, { timeout: 2_000, interval: 10 });
        const childPid = Number(readFileSync(ready, "utf8"));
        expect(() => s.cleanup()).toThrow("Private scenario processes did not exit");
        expect(existsSync(stopped)).toBe(true);
        expect(process.kill(childPid, 0)).toBe(true);
        expect(existsSync(s.root)).toBe(true);
        expect(() => s.cleanup()).toThrow("Private scenario processes did not exit");
        expect(existsSync(s.home)).toBe(true);
      } finally {
        // A partially started session is still owned, even before the ready-file PID is read.
        if (panePid === undefined && existsSync(s.tmuxSocketPath)) {
          [serverPid, panePid] = (await at(["display-message", "-p", "-t", "writer", "#{pid} #{pane_pid}"]))
            .stdout.trim().split(/\s+/).map(Number);
        }
        if (panePid !== undefined) {
          if (!Number.isInteger(panePid) || panePid <= 1) throw new Error("Fixture pane identity unavailable");
          try { process.kill(panePid, "SIGTERM"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          // The fixture parent exits only after its child, including on partial startup.
          await vi.waitFor(() => expect(() => process.kill(panePid!, 0)).toThrow(), { timeout: 2_000, interval: 10 });
        }
        // Normal teardown may remove the socket; successful startup may already have latched failure.
        if (existsSync(s.tmuxSocketPath)) {
          try { await at(["kill-server"]); }
          catch (error) {
            if ((error as { code?: unknown }).code !== 1 || !String(error).includes("no server running")) throw error;
          }
        }
        if (serverPid !== undefined) {
          if (!Number.isInteger(serverPid) || serverPid <= 1) throw new Error("Fixture server identity unavailable");
          await vi.waitFor(() => expect(() => process.kill(serverPid!, 0)).toThrow(), { timeout: 2_000, interval: 10 });
        }
        rmSync(s.root, { recursive: true, force: true });
      }
    };
    if (failReadiness) await expect(exercise()).rejects.toThrow("forced readiness failure");
    else await exercise();
    expect(existsSync(s.root)).toBe(false);
    expect(existsSync(s.tmuxSocketPath)).toBe(false);
    if (panePid !== undefined) expect(() => process.kill(panePid!, 0)).toThrow();
    const childPid = Number(readFileSync(ready, "utf8"));
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("cleanup terminates repeated scaffold-owned tmux servers without touching an unrelated server", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const sentinelDir = mkdtempSync(join(tmpdir(), "sent-cleanup-"));
    const sentinelSocketPath = join(sentinelDir, "sentinel.sock");
    dirs.push(sentinelDir);

    const directEnv = () => {
      const env = { ...process.env } as NodeJS.ProcessEnv;
      delete env.TMUX;
      delete env.TMUX_TMPDIR;
      return env;
    };
    const at = (socketPath: string, args: string[]) =>
      run("tmux", ["-S", socketPath, ...args], { env: directEnv() });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await at(sentinelSocketPath, ["new-session", "-d", "-s", "unrelated", "sleep 600"]);
    const sentinelPid = Number(
      (await at(sentinelSocketPath, ["display-message", "-p", "-t", "unrelated", "#{pid}"])).stdout.trim(),
    );
    try {
      for (const runNumber of [1, 2]) {
        const s = prepareHermeticEnv({
          baseEnv: { ...cleanBase(), TMUX_TMPDIR: sentinelDir },
        });
        scaffolds.push(s);
        const session = `scenario-${runNumber}`;
        await run("tmux", ["new-session", "-d", "-s", session, "sleep 600"], {
          env: s.env as NodeJS.ProcessEnv,
        });
        const server = await run("tmux", ["display-message", "-p", "-t", session, "#{pid}"], {
          env: s.env as NodeJS.ProcessEnv,
        });
        const serverPid = Number(server.stdout.trim());

        s.cleanup();
        s.cleanup();
        expect(existsSync(s.root)).toBe(false);
        await vi.waitFor(() => {
          expect(alive(serverPid)).toBe(false);
        }, { timeout: 2_000, interval: 25 });
        const sentinel = await at(sentinelSocketPath, ["list-sessions", "-F", "#{session_name}"]);
        expect(sentinel.stdout.trim()).toBe("unrelated");
        const sentinelServer = await at(sentinelSocketPath, [
          "display-message", "-p", "-t", "unrelated", "#{pid}",
        ]);
        expect(Number(sentinelServer.stdout.trim())).toBe(sentinelPid);
      }
    } finally {
      await at(sentinelSocketPath, ["kill-session", "-t", "unrelated"]).catch(() => {});
    }
  });
});

// Guard finding 4: the previous version snapshotted only top-level `tmux-*`
// DIRECTORY NAMES after a run that ends in `down` — so it could not detect the
// contamination it claimed to exclude (the scenario cleans up after itself, and
// a name-set is unchanged by connecting to or mutating an existing server). A
// falsification proved it toothless: with the TMUX_TMPDIR replacement DISABLED
// it still passed.
//
// This version observes WHILE SEATS ARE ALIVE and asserts BOTH directions:
// the inherited sentinel server gains nothing, and the explicit scaffold socket
// is where the seats actually are. The focused p2 cleanup proof separately
// detects removal of the socket shim by observing the owned server PID survive.
describe("D5 p3 (integration) — an INHERITED tmux server is replaced, proven while seats live", () => {
  it("seats land on the scaffold-owned server; the inherited sentinel server gains nothing", async () => {
    const { spawnScenarioDaemon, runRig } = await import("./helpers/scenario-daemon.js");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);

    const HERE = dirname(fileURLToPath(import.meta.url));
    const rigBin = resolve(HERE, "../../cli/dist/bin-wrapper.js");
    const sourceTopology = join(HERE, "fixtures", "scenarios", "topo-stub-baton.yaml");
    const pkgRoot = resolve(HERE, "..");

    const sentinelDir = mkdtempSync(join(tmpdir(), "sent-"));
    const sentinelDefaultDir = join(sentinelDir, `tmux-${process.getuid()}`);
    mkdirSync(sentinelDefaultDir, { recursive: true, mode: 0o700 });
    const sentinelSocketPath = join(sentinelDefaultDir, "default");
    dirs.push(sentinelDir);
    const directEnv = () => {
      const e = { ...process.env } as Record<string, string | undefined>;
      delete e.TMUX;
      delete e.TMUX_TMPDIR;
      return e as NodeJS.ProcessEnv;
    };
    const at = (socketPath: string, args: string[]) =>
      run("tmux", ["-S", socketPath, ...args], { env: directEnv() });
    const sessionsAt = async (socketPath: string): Promise<string> => {
      try {
        const { stdout } = await at(socketPath, ["list-sessions", "-F", "#{session_name}"]);
        return stdout.trim().split("\n").filter(Boolean).sort().join(",");
      } catch { return ""; } // no server = no sessions
    };

    await at(sentinelSocketPath, ["new-session", "-d", "-s", "sentinel-only", "sleep 600"]);
    const before = await sessionsAt(sentinelSocketPath);
    expect(before).toBe("sentinel-only"); // the sentinel is real and reachable

    // INHERIT the sentinel dir through the real helper.
    const scaffold = prepareHermeticEnv({
      baseEnv: { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm", TMUX_TMPDIR: sentinelDir },
    });
    scaffolds.push(scaffold);
    expect(scaffold.env.TMUX_TMPDIR).toBe(scaffold.tmuxTmpDir);
    expect(scaffold.env.TMUX_TMPDIR).not.toBe(sentinelDir);

    // Guard finding 2: the earlier version ran `up` on a topology whose seats
    // declare `cwd: .`, with no staged cwd and no --cwd — so the daemon resolved
    // seat cwd into the SOURCE TREE and the seats wrote AGENTS.md and
    // .openrig/stub/** into packages/daemon. A pin that proves tmux isolation
    // while corrupting the owner tree is not a hermeticity pin. Stage per-seat
    // scaffold cwds with the slice's OWN staging helper instead.
    const staged = stageTopologyRoot(sourceTopology, join(scaffold.root, "topology"));
    const managedInSource = () => [
      join(pkgRoot, "AGENTS.md"),
      join(pkgRoot, ".openrig"),
    ].filter((f) => existsSync(f));
    expect(managedInSource()).toEqual([]); // clean before

    const daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    try {
      const up = await runRig(["up", staged.topologyPath, "--json", "--yes"], daemon.readEnv, rigBin, 120_000);
      expect(up.code).toBe(0);

      // WHILE THE SEATS ARE ALIVE (no `down` yet) — both directions:
      const ownedNow = await sessionsAt(scaffold.tmuxSocketPath);
      const sentinelNow = await sessionsAt(sentinelSocketPath);
      expect(ownedNow).toContain("scn-baton");   // the seats are HERE...
      expect(sentinelNow).toBe(before);          // ...and the inherited server gained nothing
      expect(sentinelNow).not.toContain("scn-baton");

      // EFFECT PIN (guard finding 2): the source/launch tree received no managed
      // seat files — the seats' writes landed in the scaffold, where they belong.
      expect(managedInSource()).toEqual([]);
      const seatCwd = staged.seatCwds["dev-worker"]!;
      expect(existsSync(join(seatCwd, ".openrig", "stub", "state.json"))).toBe(true);
    } finally {
      await runRig(["down", "scn-baton", "--json", "--force"], daemon.readEnv, rigBin, 60_000).catch(() => {});
      await daemon.stop().catch(() => {});
      await at(sentinelSocketPath, ["kill-session", "-t", "sentinel-only"]).catch(() => {});
    }
  }, 300_000);
});
