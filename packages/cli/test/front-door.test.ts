// Slice-17 mini-req 7 — BARE-RIG FRONT DOOR (founder + arch reinforcements).
// bare `rig` (no args): BOTH stdin+stdout TTY → launch the TUI; a pipe or
// redirect on EITHER stream → fall through to the normal usage path with a
// fast exit (never hang a script); daemon-down / TUI-init-fail → helpful
// usage, NEVER a stack trace; --help/--version/subcommands are args and
// behave unchanged. New file; shipped CLI floors untouched.
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runFrontDoor, resolveTuiPath, type FrontDoorIo } from "../src/front-door.js";

function io(overrides: Partial<FrontDoorIo> = {}): FrontDoorIo & {
  outLines: string[];
  errLines: string[];
  exits: number[];
  launches: number;
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const exits: number[] = [];
  const holder = { launches: 0 };
  return {
    outLines,
    errLines,
    exits,
    get launches() {
      return holder.launches;
    },
    stdinIsTTY: true,
    stdoutIsTTY: true,
    out: (l: string) => void outLines.push(l),
    err: (l: string) => void errLines.push(l),
    exit: (c: number) => void exits.push(c),
    probeDaemon: async () => true,
    launchTui: async () => {
      holder.launches += 1;
      return 0;
    },
    ...overrides,
  };
}

describe("bare-rig front door — ownership rules", () => {
  it("bare `rig` with BOTH streams TTY and the daemon up launches the TUI", async () => {
    const deps = io();
    const handled = await runFrontDoor(["node", "rig"], deps);
    expect(handled).toBe(true);
    expect(deps.launches).toBe(1);
    expect(deps.errLines.join("\n")).toBe("");
  });

  it("stdin piped (echo x | rig) → NOT owned: falls through to the normal usage path", async () => {
    const deps = io({ stdinIsTTY: false });
    expect(await runFrontDoor(["node", "rig"], deps)).toBe(false);
    expect(deps.launches).toBe(0);
  });

  it("stdout redirected (rig > file) → NOT owned: falls through to the normal usage path", async () => {
    const deps = io({ stdoutIsTTY: false });
    expect(await runFrontDoor(["node", "rig"], deps)).toBe(false);
    expect(deps.launches).toBe(0);
  });

  it("ANY argument (--help / --version / a subcommand) → NOT owned, regardless of TTY", async () => {
    for (const argv of [["node", "rig", "--help"], ["node", "rig", "--version"], ["node", "rig", "ps"], ["node", "rig", "context", "list"]]) {
      const deps = io();
      expect(await runFrontDoor(argv, deps), argv.join(" ")).toBe(false);
      expect(deps.launches).toBe(0);
    }
  });
});

describe("bare-rig front door — first-impression degrade (never a stack trace)", () => {
  it("daemon down → helpful usage naming `rig up`, exit 1, launch NOT attempted", async () => {
    const deps = io({ probeDaemon: async () => false });
    const handled = await runFrontDoor(["node", "rig"], deps);
    expect(handled).toBe(true);
    expect(deps.launches).toBe(0);
    const text = deps.errLines.join("\n");
    expect(text).toMatch(/daemon not running/i);
    expect(text).toMatch(/rig up/);
    expect(text).toMatch(/rig --help/);
    expect(text).not.toMatch(/\n\s+at /); // no stack frames
    expect(deps.exits).toEqual([1]);
  });

  it("TUI init failure → helpful usage with the failure line, exit 1, no stack trace", async () => {
    const deps = io({
      launchTui: async () => {
        throw new Error("tui entry not found at /nope/main.js");
      },
    });
    const handled = await runFrontDoor(["node", "rig"], deps);
    expect(handled).toBe(true);
    const text = deps.errLines.join("\n");
    expect(text).toMatch(/tui entry not found/);
    expect(text).toMatch(/rig --help/);
    expect(text).not.toMatch(/\n\s+at /);
    expect(deps.exits).toEqual([1]);
  });

  it("the TUI's own exit code propagates", async () => {
    const deps = io({ launchTui: async () => 3 });
    await runFrontDoor(["node", "rig"], deps);
    expect(deps.exits).toEqual([3]);
  });
});

describe("resolveTuiPath — monorepo-first, bundled fallback (the daemon resolver pattern)", () => {
  it("prefers the monorepo sibling dist, falls back to the bundled copy, null when neither", () => {
    const base = "/repo/packages/cli/dist";
    const mono = join("/repo/packages/cli/dist", "../../tui/dist/main.js");
    const bundled = join("/repo/packages/cli/dist", "../tui/dist/main.js");
    expect(resolveTuiPath(base, (p) => p === mono)).toBe(mono);
    expect(resolveTuiPath(base, (p) => p === bundled)).toBe(bundled);
    expect(resolveTuiPath(base, () => false)).toBeNull();
  });
});

describe("script-safety integration (the compiled front door)", () => {
  const cliEntry = join(__dirname, "..", "dist", "index.js");
  it.skipIf(!existsSync(cliEntry))("`echo x | rig` returns usage fast — no hang (exit code preserves today's clean-help baseline)", () => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [cliEntry], {
      input: "x\n",
      timeout: 5000,
      encoding: "utf-8",
      env: { ...process.env, OPENRIG_URL: "", OPENRIG_PORT: "" },
    });
    expect(Date.now() - started).toBeLessThan(5000);
    // pre-slice-17 baseline: commander's clean-help path prints usage and
    // exits 0 — the front door PRESERVES the piped path byte-for-byte
    expect(result.status).toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/Usage: rig/);
    expect(`${result.stderr}${result.stdout}`).not.toMatch(/\n\s+at /);
  });

  it.skipIf(!existsSync(cliEntry))("`rig --help` still exits 0 with the full usage (front-door regression)", () => {
    const result = spawnSync(process.execPath, [cliEntry, "--help"], { timeout: 5000, encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: rig/);
    expect(result.stdout).toMatch(/daemon/);
  });
});
