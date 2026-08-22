// Slice-17 mini-req 7 — BARE-RIG FRONT DOOR (founder + arch reinforcements).
// bare `rig` (no args): BOTH stdin+stdout TTY → launch the TUI; a pipe or
// redirect on EITHER stream → fall through to the normal usage path with a
// fast exit (never hang a script); daemon-down / TUI-init-fail → helpful
// usage, NEVER a stack trace; --help/--version/subcommands are args and
// behave unchanged. New file; shipped CLI floors untouched.
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFrontDoor, resolveTuiPath, probeFrontDoor, type FrontDoorIo } from "../src/front-door.js";
import { DaemonConnectionError, DaemonResponseError, DaemonTimeoutError } from "../src/client.js";

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
  it("BLOCKER 1: transport connect (daemon DOWN) LAUNCHES the crash-cart TUI, not a degrade-and-exit", async () => {
    const deps = io({
      probeDaemon: async () => ({
        state: "diagnostic" as const,
        diagnostic: {
          transport: { state: "connect" as const },
          cwdRead: { state: "unknown" as const },
          commandPath: { state: "unknown" as const },
          enforcement: { axis: "not_applicable" as const, state: "unknown" as const, expected: null, effective: null, sourcePath: null, reason: "transport_unavailable" },
          observedAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    });
    const handled = await runFrontDoor(["node", "rig"], deps);
    expect(handled).toBe(true);
    // The daemon-down state is exactly what the crash-cart cockpit exists for — bare `rig` must REACH it.
    expect(deps.launches).toBe(1);
    expect(deps.exits).toEqual([0]); // exits with the TUI's code, not a forced degrade exit(1)
    const text = deps.errLines.join("\n");
    expect(text).not.toMatch(/runtime posture: TRANSPORT_CONNECT/); // no degrade-and-exit for daemon-down
  });

  it("BLOCKER 1 PRODUCTION PATH: bare rig + daemon down via the REAL probeFrontDoor → the crash-cart TUI launches", async () => {
    // Not a mocked probe result — the real probeFrontDoor classification runs; only the socket is stubbed
    // to the daemon-down failure (ECONNREFUSED → DaemonConnectionError). The whole front-door composition
    // (probe → normalize → openMissionControl launch decision) is exercised, which is the seam that hid
    // the defect: the prior tests injected a probe RESULT and asserted launches:0.
    const stubClient = {
      get: async () => {
        throw new DaemonConnectionError("connect ECONNREFUSED 127.0.0.1:7433");
      },
    };
    const deps = io({ probeDaemon: () => probeFrontDoor({ client: stubClient, env: {} }) });
    const handled = await runFrontDoor(["node", "rig"], deps);
    expect(handled).toBe(true);
    expect(deps.launches).toBe(1); // bare-rig + daemon-down → TUI launched into the crash-cart path
    expect(deps.errLines.join("\n")).not.toMatch(/runtime posture/); // not a degrade-and-exit
  });

  it.each([
    ["cwd denied", "visible", "available", "aligned", "CWD_READ_DENIED"],
    ["command missing", "visible", "missing", "aligned", "COMMAND_PATH_MISSING"],
    ["permission drift", "visible", "available", "drift", "PERMISSION_DRIFT"],
    ["permission unknown", "visible", "available", "unknown", "UNKNOWN_EFFECTIVE"],
  ] as const)("renders an axis-specific verdict for %s", async (_label, _healthyCwd, commandState, enforcementState, verdict) => {
    const cwdState = _label === "cwd denied" ? "denied" as const : "visible" as const;
    const deps = io({
      probeDaemon: async () => ({
        state: "diagnostic" as const,
        diagnostic: {
          transport: { state: "healthy" as const },
          cwdRead: { state: cwdState },
          commandPath: { state: commandState },
          enforcement: {
            axis: "permission" as const,
            state: enforcementState,
            expected: "acceptEdits",
            effective: enforcementState === "unknown" ? null : { defaultMode: enforcementState === "drift" ? "manual" : "acceptEdits" },
            sourcePath: "/work/.claude/settings.local.json",
            ...(enforcementState === "unknown" ? { reason: "settings_unparseable" } : {}),
          },
          observedAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    });
    await runFrontDoor(["node", "rig"], deps);
    const text = deps.errLines.join("\n");
    expect(text).toContain(`runtime posture: ${verdict}`);
    expect(text).not.toMatch(/daemon not running/i);
  });

  it("front-door unreadable settings stays UNKNOWN_EFFECTIVE and never becomes daemon-down", async () => {
    const deps = io({
      probeDaemon: async () => ({
        state: "diagnostic" as const,
        diagnostic: {
          transport: { state: "healthy" as const },
          cwdRead: { state: "visible" as const },
          commandPath: { state: "available" as const },
          enforcement: { axis: "permission" as const, state: "unknown" as const, expected: "acceptEdits", effective: null, sourcePath: "/work/.claude/settings.local.json", reason: "settings_unreadable" },
          observedAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    });
    await runFrontDoor(["node", "rig"], deps);
    const text = deps.errLines.join("\n");
    expect(text).toContain("runtime posture: UNKNOWN_EFFECTIVE");
    expect(text).toContain("reason=settings_unreadable");
    expect(text).not.toMatch(/daemon not running/i);
  });

  it("permission drift renders all four axes plus expected/effective/source and never launches", async () => {
    const deps = io({
      probeDaemon: async () => ({
        state: "diagnostic" as const,
        diagnostic: {
          transport: { state: "healthy" as const },
          cwdRead: { state: "visible" as const },
          commandPath: { state: "available" as const },
          enforcement: {
            axis: "permission" as const,
            state: "drift" as const,
            expected: "acceptEdits",
            effective: { defaultMode: "denyAll", allow: [], ask: [], deny: ["Read(/outside/**)"] },
            sourcePath: "/work/.claude/settings.local.json",
          },
          observedAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    });
    await runFrontDoor(["node", "rig"], deps);
    const text = deps.errLines.join("\n");
    expect(text).toContain("transport: healthy");
    expect(text).toContain("cwd/read: visible");
    expect(text).toContain("command/PATH: available");
    expect(text).toContain("permission: DRIFT");
    expect(text).toContain("expected=acceptEdits");
    expect(text).toContain("effective=denyAll");
    expect(text).toContain("source=/work/.claude/settings.local.json");
    expect(text).not.toMatch(/daemon not running/i);
    expect(deps.launches).toBe(0);
    expect(deps.exits).toEqual([1]);
  });

  it.each(["timeout", "response"] as const)("BLOCKER 1: transport %s (daemon not ready) LAUNCHES the TUI (its probe makes the down/unverified call)", async (state) => {
    const deps = io({
      probeDaemon: async () => ({
        state: "diagnostic" as const,
        diagnostic: {
          transport: { state, detail: `${state} detail` },
          cwdRead: { state: "unknown" as const },
          commandPath: { state: "unknown" as const },
          enforcement: { axis: "not_applicable" as const, state: "unknown" as const, expected: null, effective: null, sourcePath: null, reason: "transport_unavailable" },
          observedAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    });
    await runFrontDoor(["node", "rig"], deps);
    expect(deps.launches).toBe(1); // not-ready → the TUI; its own crash-cart probe renders down vs unverified
    expect(deps.errLines.join("\n")).not.toMatch(/runtime posture/); // no degrade-and-exit
  });

  it("normalizes the legacy `false` probe (daemon down) → LAUNCHES the crash-cart TUI", async () => {
    const deps = io({ probeDaemon: async () => false });
    await runFrontDoor(["node", "rig"], deps);
    expect(deps.launches).toBe(1); // false → connect diagnostic → daemon-down → the cockpit, not a degrade
    expect(deps.errLines.join("\n")).not.toMatch(/runtime posture/);
  });

  it("normalizes a legacy transport-only timeout result (not ready) → LAUNCHES the TUI", async () => {
    const deps = io({ probeDaemon: async () => ({ state: "timeout", message: "legacy timeout detail" }) });
    await runFrontDoor(["node", "rig"], deps);
    expect(deps.launches).toBe(1); // timeout → not ready → TUI (its probe renders unverified)
    expect(deps.errLines.join("\n")).not.toMatch(/runtime posture/);
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

describe("front-door probe routing", () => {
  it("uses explicit current-seat whoami diagnostics for a managed seat", async () => {
    const paths: string[] = [];
    const result = await probeFrontDoor({
      env: { OPENRIG_NODE_ID: "node/1" },
      client: {
        get: async (path: string) => {
          paths.push(path);
          return {
            status: 200,
            data: {
              permissionDrift: {
                transport: { state: "healthy" },
                cwdRead: { state: "visible" },
                commandPath: { state: "available" },
                enforcement: { axis: "sandbox", state: "aligned", expected: "workspace-write", effective: "workspace-write", sourcePath: null },
                observedAt: "2026-08-08T00:00:00.000Z",
              },
            },
          };
        },
      },
    });
    expect(result).toEqual({ state: "ready" });
    expect(paths).toEqual(["/api/whoami?nodeId=node%2F1&compact=1&diagnostics=permission"]);
  });

  it("uses cheap health for an unmanaged shell", async () => {
    const paths: string[] = [];
    const result = await probeFrontDoor({
      env: {},
      client: { get: async (path: string) => { paths.push(path); return { status: 200, data: { status: "ok" } }; } },
    });
    expect(result).toEqual({ state: "ready" });
    expect(paths).toEqual(["/healthz"]);
  });

  it("normalizes a non-2xx daemon response into a complete four-axis diagnostic", async () => {
    const result = await probeFrontDoor({
      env: { OPENRIG_NODE_ID: "node-1" },
      client: { get: async () => ({ status: 503, data: {} }) },
    });
    expect(result).toMatchObject({
      state: "diagnostic",
      diagnostic: {
        transport: { state: "response" },
        cwdRead: { state: "unknown" },
        commandPath: { state: "unknown" },
        enforcement: { state: "unknown", reason: "transport_unavailable" },
      },
    });
  });

  it("never reports ready when transport is not healthy even if every local axis aligns", async () => {
    const result = await probeFrontDoor({
      env: { OPENRIG_NODE_ID: "node-1" },
      client: {
        get: async () => ({
          status: 200,
          data: {
            permissionDrift: {
              transport: { state: "timeout", detail: "upstream timed out" },
              cwdRead: { state: "visible" },
              commandPath: { state: "available" },
              enforcement: { axis: "permission", state: "aligned", expected: "acceptEdits", effective: "acceptEdits", sourcePath: null },
              observedAt: "2026-08-08T00:00:00.000Z",
            },
          },
        }),
      },
    });
    expect(result).toMatchObject({ state: "diagnostic", diagnostic: { transport: { state: "timeout", detail: "upstream timed out" } } });
  });

  it.each([
    ["connect", new DaemonConnectionError("refused")],
    ["timeout", new DaemonTimeoutError("slow")],
    ["response", new DaemonResponseError(502, "bad")],
  ] as const)("normalizes a %s exception into the same complete four-axis diagnostic", async (state, error) => {
    const result = await probeFrontDoor({
      env: { OPENRIG_NODE_ID: "node-1" },
      client: { get: async () => { throw error; } },
    });
    expect(result).toMatchObject({
      state: "diagnostic",
      diagnostic: {
        transport: { state },
        cwdRead: { state: "unknown" },
        commandPath: { state: "unknown" },
        enforcement: { state: "unknown", reason: "transport_unavailable" },
      },
    });
    expect((result as { diagnostic: { transport: { detail?: string } } }).diagnostic.transport.detail).toContain(error.message);
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

describe("PUBLIC bin ownership (guard finding 1 — the wrapper is the real front door)", () => {
  const binWrapper = join(__dirname, "..", "dist", "bin-wrapper.js");
  const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
  it.skipIf(!existsSync(binWrapper) || !hasTmux)("bare PUBLIC bin under a REAL PTY reaches the crash-cart COCKPIT when the daemon is down (BLOCKER 1 ownership + reachability)", () => {
    // tmux gives the process a real TTY on BOTH streams. A dead daemon URL is exactly the crash-cart's
    // state: post-fix the front door LAUNCHES the TUI, which renders the daemon-down cockpit
    // ("daemon not running") — stronger ownership proof than the old degrade message (it reaches the
    // actual feature). Commander's usage bypass would mean the front door did NOT own the invocation.
    // Isolated OPENRIG_HOME so the launched TUI never reads the live rig (fully contained + read-only).
    const session = `frontdoor-pin-${process.pid}`;
    const home = mkdtempSync(join(tmpdir(), "fd-tmux-home-"));
    spawnSync("tmux", ["kill-session", "-t", session], { encoding: "utf-8" });
    const run = spawnSync(
      "tmux",
      ["new-session", "-d", "-s", session, "-x", "120", "-y", "30",
        `OPENRIG_HOME=${home} OPENRIG_URL=http://127.0.0.1:9 ${process.execPath} ${binWrapper}; sleep 15`],
      { encoding: "utf-8", timeout: 10000 },
    );
    expect(run.status).toBe(0);
    let text = "";
    for (let i = 0; i < 20 && !/EXPLORER|mission control could not start|Usage: rig/.test(text); i++) {
      spawnSync("sleep", ["0.5"]);
      text = spawnSync("tmux", ["capture-pane", "-t", session, "-p"], { encoding: "utf-8", timeout: 5000 }).stdout ?? "";
    }
    spawnSync("tmux", ["kill-session", "-t", session], { encoding: "utf-8" });
    rmSync(home, { recursive: true, force: true });
    // The daemon being unreachable, the front door LAUNCHED the TUI (its universal chrome — the EXPLORER
    // pane — renders), or degraded honestly if the TUI is not installed. Either proves the PUBLIC bin ran
    // the front-door path; commander's usage bypass would mean it did NOT. (The crash-cart cockpit render
    // itself is covered by the TUI's own tests; the launch decision by the deterministic production-path test.)
    expect(text).toMatch(/EXPLORER|mission control could not start/);
    expect(text).not.toMatch(/Usage: rig \[options\] \[command\]/);
  });

  // (Removed the in-process forced-TTY "reaches the degrade branch" belt: its premise was a FAST
  //  daemon-down DEGRADE, which BLOCKER 1's fix replaces with launching the crash-cart TUI. Forcing a
  //  TTY in-process would spawn an INTERACTIVE TUI child (no clean exit) — not a safe/deterministic unit
  //  test. Compiled-wrapper ownership is covered by the tmux cockpit test above (contained + killed) and
  //  the piped-baseline test below; the front-door LAUNCH decision is covered deterministically by the
  //  "PRODUCTION PATH … REAL probeFrontDoor" test earlier, with no real TUI spawned.)

  it.skipIf(!existsSync(binWrapper))("piped PUBLIC bin keeps the commander usage baseline (no TUI, fast exit)", () => {
    const result = spawnSync(process.execPath, [binWrapper], {
      input: "x\n",
      timeout: 5000,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/Usage: rig/);
  });

  it.skipIf(!existsSync(binWrapper))("PUBLIC bin subcommands are untouched (rig --version via wrapper)", () => {
    const result = spawnSync(process.execPath, [binWrapper, "--version"], { timeout: 5000, encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
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
