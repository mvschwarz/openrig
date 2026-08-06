import { describe, it, expect, afterEach } from "vitest";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  prepareHermeticEnv,
  HermeticEnvError,
  DAEMON_TARGET_ENV_VARS,
  type HermeticScaffold,
} from "./helpers/hermetic-env.js";

// Slice 51-02 — the hermetic scaffold layer on top of the fail-closed guard.
// prepareHermeticEnv() builds a per-run scratch HOME/OPENRIG_HOME scaffold and a
// CLEAN child-process env (scrubbed daemon-target vars + scratch paths), WITHOUT
// mutating the runner process's own environment. It fails closed FIRST (a foreign
// daemon target aborts before any scaffold is created).
describe("prepareHermeticEnv scaffold", () => {
  const scaffolds: HermeticScaffold[] = [];
  afterEach(() => {
    for (const s of scaffolds.splice(0)) s.cleanup();
  });
  const make = (baseEnv?: Record<string, string | undefined>) => {
    const s = prepareHermeticEnv({ baseEnv });
    scaffolds.push(s);
    return s;
  };

  it("fails closed BEFORE creating any scaffold when a foreign daemon target is present", () => {
    let thrown: unknown;
    try {
      prepareHermeticEnv({ baseEnv: { OPENRIG_URL: "http://foreign:9999", HOME: "/real" } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HermeticEnvError);
    expect((thrown as Error).message).toContain("OPENRIG_URL");
  });

  it("creates an isolated scratch scaffold (root + home + openrigHome + stateDir all exist under root)", () => {
    const s = make({ HOME: "/real-home", PATH: "/usr/bin" });
    expect(existsSync(s.root)).toBe(true);
    for (const dir of [s.home, s.openrigHome, s.stateDir]) {
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(dir.startsWith(s.root)).toBe(true);
    }
  });

  it("returns a CLEAN child env: daemon-target vars scrubbed, scratch paths set", () => {
    const base = {
      HOME: "/real-home",
      PATH: "/usr/bin",
      OPENRIG_URL: undefined, // absent -> fine
      OPENRIG_AUTH_BEARER_TOKEN: "secret",
    };
    const s = make(base);
    for (const v of DAEMON_TARGET_ENV_VARS) {
      expect(s.env[v]).toBeUndefined();
    }
    // credential also scrubbed
    expect(s.env.OPENRIG_AUTH_BEARER_TOKEN).toBeUndefined();
    // scratch paths point INTO the scaffold
    expect(s.env.HOME).toBe(s.home);
    expect(s.env.OPENRIG_HOME).toBe(s.openrigHome);
    expect(s.env.OPENRIG_NO_KERNEL).toBe("1");
    // PATH preserved (non-target var passes through)
    expect(s.env.PATH).toBe("/usr/bin");
  });

  it("does NOT mutate the caller's env object nor process.env", () => {
    const base: Record<string, string | undefined> = { HOME: "/real-home", PATH: "/usr/bin" };
    const beforeHome = process.env.HOME;
    const s = make(base);
    // caller's base object untouched
    expect(base.HOME).toBe("/real-home");
    expect(base.OPENRIG_HOME).toBeUndefined();
    // process.env untouched
    expect(process.env.HOME).toBe(beforeHome);
    expect(process.env.OPENRIG_NO_KERNEL).not.toBe("1");
    // the scaffold's env is a distinct object
    expect(s.env).not.toBe(base);
  });

  it("cleanup removes the scaffold root", () => {
    const s = prepareHermeticEnv({ baseEnv: { HOME: "/real-home" } });
    const root = s.root;
    expect(existsSync(root)).toBe(true);
    s.cleanup();
    expect(existsSync(root)).toBe(false);
  });

  it("the scratch child env is itself hermetic (no foreign target survives)", () => {
    // The clean env must pass its own fail-closed guard — proving the scrub is complete.
    const s = make({ OPENRIG_HOST: undefined, HOME: "/real", RIGGED_URL: undefined });
    expect(() => {
      // re-run the guard over the produced env
      for (const v of DAEMON_TARGET_ENV_VARS) {
        if (s.env[v]) throw new Error(`leaked ${v}`);
      }
    }).not.toThrow();
  });
});
