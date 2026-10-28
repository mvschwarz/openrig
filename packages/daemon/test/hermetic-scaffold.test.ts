import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
    vi.unstubAllEnvs();
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
    // The private tmux wrapper wins command resolution, then the runtime stubs (codex and claude); the
    // caller's PATH is preserved after them so every other executable resolves as before.
    expect(s.env.PATH).toBe(
      `${join(s.root, "bin")}${delimiter}${join(s.root, ".openrig-test-runtime-stubs")}${delimiter}/usr/bin`,
    );
  });

  it("does NOT mutate the caller's env object nor process.env", () => {
    const base: Record<string, string | undefined> = { HOME: "/real-home", PATH: "/usr/bin" };
    const beforeHome = process.env.HOME;
    // Capture BEFORE — the invariant is "process.env is UNCHANGED", not an absolute value. A bare
    // `not.toBe("1")` was env-SENSITIVE: it false-fails when the ambient seat env already carries
    // OPENRIG_NO_KERNEL="1" (the scaffold copies baseEnv via {...baseEnv} and never touches process.env;
    // the old assertion assumed a clean ambient env — the very env-sensitivity this scaffold exists to cure).
    const beforeNoKernel = process.env.OPENRIG_NO_KERNEL;
    const s = make(base);
    // caller's base object untouched
    expect(base.HOME).toBe("/real-home");
    expect(base.OPENRIG_HOME).toBeUndefined();
    // process.env untouched (compared to its OWN before-value → insensitive to the ambient env)
    expect(process.env.HOME).toBe(beforeHome);
    expect(process.env.OPENRIG_NO_KERNEL).toBe(beforeNoKernel);
    // the scaffold's env is a distinct object
    expect(s.env).not.toBe(base);
  });

  it.each(["exit", "signal"])("forwards socket, arguments, stdio and %s without Node on the saved PATH", (termination) => {
    const commands = mkdtempSync(join(tmpdir(), "tmux-wrapper-"));
    // Exercise quoting of the saved PATH, including characters that must not execute.
    const commandDir = join(commands, "bin ' $() `");
    mkdirSync(commandDir);
    writeFileSync(join(commandDir, "tmux"), `#!/bin/sh
printf '%s\\n' "$PATH" "$OPENRIG_HOME" "$TMUX_TMPDIR" "$@"
/bin/cat
printf 'tmux stderr\\n' >&2
if [ "$FIXTURE_TERMINATION" = signal ]; then kill -TERM "$$"; fi
exit 23
`, { mode: 0o755 });
    try {
      const s = make({ PATH: commandDir, FIXTURE_TERMINATION: termination });
      const args = ["send-keys", "", "space ' quote", "$(exit 99)", "`exit 98`", "line\nbreak"];
      const result = spawnSync(join(s.root, "bin", "tmux"), args, {
        env: s.env as NodeJS.ProcessEnv, input: "stdin payload\n", encoding: "utf8", timeout: 2_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(termination === "exit" ? 23 : null);
      expect(result.signal).toBe(termination === "signal" ? "SIGTERM" : null);
      expect(result.stdout).toBe([
        commandDir, s.openrigHome, s.tmuxTmpDir, "-S", s.tmuxSocketPath, ...args, "stdin payload", "",
      ].join("\n"));
      expect(result.stderr).toBe("tmux stderr\n");
    } finally {
      rmSync(commands, { recursive: true, force: true });
    }
  });

  it("scrubs inherited provider roots and the native opt-in from scenario children", () => {
    vi.stubEnv("CODEX_HOME", "/synthetic-host-codex");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/synthetic-host-claude");
    vi.stubEnv("OPENRIG_E2E_REAL_CODEX", "1");
    const s = make();
    expect(s.env.HOME).toBe(s.home);
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENRIG_E2E_REAL_CODEX"]) {
      expect(s.env[key]).toBeUndefined();
    }
    expect(process.env.CODEX_HOME).toBe("/synthetic-host-codex");
    expect(process.env.CLAUDE_CONFIG_DIR).toBe("/synthetic-host-claude");
    expect(process.env.OPENRIG_E2E_REAL_CODEX).toBe("1");
  });

  it("preserves explicit provider roots but still scrubs the native opt-in", () => {
    const base = {
      HOME: "/synthetic-host-home", CODEX_HOME: "/synthetic-host-codex",
      CLAUDE_CONFIG_DIR: "/synthetic-host-claude", OPENRIG_E2E_REAL_CODEX: "1",
    };
    const s = make(base);
    expect(s.env.HOME).toBe(s.home);
    expect(s.env.CODEX_HOME).toBe(base.CODEX_HOME);
    expect(s.env.CLAUDE_CONFIG_DIR).toBe(base.CLAUDE_CONFIG_DIR);
    expect(s.env.OPENRIG_E2E_REAL_CODEX).toBeUndefined();
    expect(base.CODEX_HOME).toBe("/synthetic-host-codex");
    expect(base.CLAUDE_CONFIG_DIR).toBe("/synthetic-host-claude");
    expect(base.OPENRIG_E2E_REAL_CODEX).toBe("1");
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
