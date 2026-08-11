import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
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
// A scenario `up` stands up REAL tmux seats. Without an owned TMUX_TMPDIR the
// scenario shares the operator's tmux server: a live fleet-safety hazard (a
// kill-server from a seat reaps the whole fleet). The helper therefore OWNS the
// tmux server dir the same way it owns HOME and the daemon target — and refuses
// an ambient attachment rather than documenting "set it manually".

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
    // tmux appends `/tmux-<uid>/default` under TMUX_TMPDIR; budget for it.
    expect(Buffer.byteLength(join(s.tmuxTmpDir, "tmux-501", "default"))).toBeLessThan(104);
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
// the inherited sentinel server gains nothing, and the scaffold-owned server is
// where the seats actually are. Disable the replacement and both legs flip.
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
    const topology = join(HERE, "fixtures", "scenarios", "topo-stub-baton.yaml");

    const sentinelDir = mkdtempSync(join(tmpdir(), "sent-"));
    dirs.push(sentinelDir);
    const envFor = (tmpd: string) => {
      const e = { ...process.env, TMUX_TMPDIR: tmpd } as Record<string, string | undefined>;
      delete e.TMUX;
      return e as NodeJS.ProcessEnv;
    };
    const sessionsIn = async (tmpd: string): Promise<string> => {
      try {
        const { stdout } = await run("tmux", ["list-sessions", "-F", "#{session_name}"], { env: envFor(tmpd) });
        return stdout.trim().split("\n").filter(Boolean).sort().join(",");
      } catch { return ""; } // no server = no sessions
    };

    await run("tmux", ["new-session", "-d", "-s", "sentinel-only", "sleep 600"], { env: envFor(sentinelDir) });
    const before = await sessionsIn(sentinelDir);
    expect(before).toBe("sentinel-only"); // the sentinel is real and reachable

    // INHERIT the sentinel dir through the real helper.
    const scaffold = prepareHermeticEnv({
      baseEnv: { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm", TMUX_TMPDIR: sentinelDir },
    });
    scaffolds.push(scaffold);
    expect(scaffold.env.TMUX_TMPDIR).toBe(scaffold.tmuxTmpDir);
    expect(scaffold.env.TMUX_TMPDIR).not.toBe(sentinelDir);

    const daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    try {
      const up = await runRig(["up", topology, "--json", "--yes"], daemon.readEnv, rigBin, 120_000);
      expect(up.code).toBe(0);

      // WHILE THE SEATS ARE ALIVE (no `down` yet) — both directions:
      const ownedNow = await sessionsIn(scaffold.tmuxTmpDir);
      const sentinelNow = await sessionsIn(sentinelDir);
      expect(ownedNow).toContain("scn-baton");   // the seats are HERE...
      expect(sentinelNow).toBe(before);          // ...and the inherited server gained nothing
      expect(sentinelNow).not.toContain("scn-baton");
    } finally {
      await runRig(["down", "scn-baton", "--json", "--force"], daemon.readEnv, rigBin, 60_000).catch(() => {});
      await run("tmux", ["kill-server"], { env: envFor(scaffold.tmuxTmpDir) }).catch(() => {});
      await daemon.stop().catch(() => {});
      await run("tmux", ["kill-server"], { env: envFor(sentinelDir) }).catch(() => {});
    }
  }, 300_000);
});
