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
