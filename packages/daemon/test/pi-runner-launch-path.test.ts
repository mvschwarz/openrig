// A seat's runtime binary must be the one the daemon checked. The pane's login shell can reorder PATH (macOS
// path_helper puts /etc/paths.d, such as /opt/homebrew/bin, first), so the runner looks the runtime up on the daemon's
// PATH, carried as OPENRIG_LAUNCH_PATH, before its own. Its child keeps the pane's PATH for its tools.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPiRunnerCommand, piSeatPaths, PI_RUNNER_LAUNCH_PATH_ENV } from "../src/adapters/pi-runner-protocol.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import { OmpResumeAdapter } from "../src/adapters/omp-resume.js";
import { PiCommunityRuntimeAdapter } from "../src/adapters/pi-community-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const RUNNER = nodePath.join(__dirname, "..", "src", "adapters", "pi-runner.ts");

let root: string | null = null;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null; });

/** Run the real runner once. Each PATH directory not in `without` gets a fake `name` that records its directory and PATH, then exits. */
function runRunner(opts: { name: string; runnerArgs: string[]; pane: string[]; launch?: string[]; without?: string[] }) {
  root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-launch-path-")));
  const ran = nodePath.join(root, "ran.json");
  const dir = (label: string) => nodePath.join(root!, label);
  for (const label of new Set([...opts.pane, ...(opts.launch ?? [])])) {
    fs.mkdirSync(dir(label), { recursive: true });
    if (opts.without?.includes(label)) continue;
    fs.writeFileSync(nodePath.join(dir(label), opts.name),
      `#!/bin/sh\nprintf '{"dir":"%s","path":"%s","launchPath":"%s"}' '${label}' "$PATH" "\${OPENRIG_LAUNCH_PATH-}" > '${ran}'\nexit 3\n`, { mode: 0o755 });
  }
  const panePath = [...opts.pane.map(dir), "/usr/bin", "/bin"].join(":");
  const env: Record<string, string> = { PATH: panePath, HOME: root, TMPDIR: os.tmpdir() };
  if (opts.launch) env[PI_RUNNER_LAUNCH_PATH_ENV] = [...opts.launch.map(dir), "/usr/bin", "/bin"].join(":");
  const result = spawnSync(process.execPath, ["--import", "tsx", RUNNER,
    "--session-name", "dev@rig", "--state-root", nodePath.join(root, "state"), "--cwd", root, "--launch-id", "launch-1",
    ...opts.runnerArgs], { env, input: "", encoding: "utf8", timeout: 30_000 });
  const output = `${result.stdout}${result.stderr}`;
  return { ran: fs.existsSync(ran) ? JSON.parse(fs.readFileSync(ran, "utf8")) as { dir: string; path: string; launchPath: string } : undefined, output, panePath };
}

const kinds = [
  { kind: "pi", name: "pi", runnerArgs: ["--no-approve"] },
  { kind: "omp", name: "omp", runnerArgs: ["--runtime", "omp", "--approval-mode", "always-ask"] },
  { kind: "pi-rpc fork", name: "omo", runnerArgs: ["--runtime", "omo", "--no-approve", "--command", "omo"] },
] as const;

describe("runner runtime lookup uses the daemon's PATH first", () => {
  it.each(kinds)("$kind runs the binary on the daemon's PATH, not the pane's earlier one; its child keeps the pane PATH", ({ name, runnerArgs }) => {
    const { ran, output, panePath } = runRunner({ name, runnerArgs, pane: ["host-bin", "daemon-bin"], launch: ["daemon-bin"] });
    expect(ran?.dir, output).toBe("daemon-bin");
    expect(ran?.path).toBe(panePath);
    expect(ran?.launchPath).toBe("");
  }, 40_000);

  it.each(kinds)("$kind falls back to the pane's PATH when the daemon's PATH lacks it", ({ name, runnerArgs }) => {
    const { ran, output } = runRunner({ name, runnerArgs, pane: ["host-bin"], launch: ["other-bin"], without: ["other-bin"] });
    expect(ran?.dir, output).toBe("host-bin");
  }, 40_000);

  it("without a daemon PATH, Pi keeps the pane's lookup", () => {
    const { ran, output } = runRunner({ name: "pi", runnerArgs: ["--no-approve"], pane: ["host-bin", "daemon-bin"] });
    expect(ran?.dir, output).toBe("host-bin");
  }, 40_000);
});

describe("launch sites carry the daemon's PATH to the runner", () => {
  const daemonPath = "/daemon/bin:/Applications/Some App.app/bin";
  const prefix = `env '${PI_RUNNER_LAUNCH_PATH_ENV}=${daemonPath}' node `;
  const base = { runnerEntryPath: "/r.js", sessionName: "s@rig", stateRoot: "/sr", cwd: "/work", trust: "no-approve" as const, launchId: "L1" };

  it("prefixes the command only when a launch PATH is given", () => {
    expect(buildPiRunnerCommand({ ...base, launchPath: daemonPath })).toBe(`env '${PI_RUNNER_LAUNCH_PATH_ENV}=${daemonPath}' ${buildPiRunnerCommand(base)}`);
    expect(buildPiRunnerCommand(base).startsWith("node ")).toBe(true);
  });

  function fakeSeat(stateRoot: string, seat: string) {
    const files: Record<string, string> = {};
    const sessionFile = nodePath.join(piSeatPaths(stateRoot, seat).sessionsDir, "current.jsonl");
    files[sessionFile] = "history";
    const fsOps = {
      readFile: (p: string) => files[p]!, writeFile: (p: string, c: string) => { files[p] = c; },
      exists: (p: string) => p in files, mkdirp: () => {},
    };
    const tmux = {
      sendShellCommand: vi.fn(async (_session: string, command: string) => {
        const launchId = /--launch-id '([^']+)'/.exec(command)?.[1];
        files[piSeatPaths(stateRoot, seat).runnerStatePath] = JSON.stringify({ ready: true, launchId, sessionFile, updatedAt: "t" });
        return { ok: true };
      }),
      sendKeys: vi.fn(async () => ({ ok: true })),
      capturePaneContent: vi.fn(async () => ""),
      getSessionEnv: vi.fn(async () => undefined),
    } as unknown as TmuxAdapter;
    return { fsOps, tmux, sessionFile, typed: () => vi.mocked(tmux.sendShellCommand).mock.calls[0]?.[1] };
  }

  const preset = {
    name: "omo", command: "omo", maintainer: "fixture", limits: [], protocol: "pi-rpc" as const, launchResult: false, namesConversation: false,
    resume: true, startupAssisted: false, firstInput: false, runner: false, passesModel: false, launchWrapper: false, path: "/fake/omo.yaml",
  };

  it.each(["pi", "omp", "pi-rpc fork"] as const)("%s launch", async (kind) => {
    const seat = "dev@rig", stateRoot = "/state";
    const { fsOps, tmux, typed } = fakeSeat(stateRoot, seat);
    const deps = { fsOps, tmux, stateRoot, runnerEntryPath: "/daemon/pi-runner.js", launchPath: daemonPath, sleep: async () => {} };
    const adapter = kind === "omp" ? new OmpRuntimeAdapter(deps)
      : kind === "pi" ? new PiRuntimeAdapter(deps)
      : PiCommunityRuntimeAdapter.fromPiAdapter(new PiRuntimeAdapter(deps), "omo", preset as never);
    const result = await adapter.launchHarness({ tmuxSession: seat, cwd: "/work" } as never, { name: seat });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(typed()).toMatch(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'/daemon/pi-runner.js' `));
  });

  it.each(["pi", "omp"] as const)("%s resume", async (kind) => {
    const seat = "dev@rig", stateRoot = "/state";
    const { fsOps, tmux, typed, sessionFile } = fakeSeat(stateRoot, seat);
    const Adapter = kind === "omp" ? OmpResumeAdapter : PiResumeAdapter;
    const result = await new Adapter(tmux, fsOps, { stateRoot, runnerEntryPath: "/daemon/pi-runner.js" }, { launchPath: daemonPath, sleep: async () => {} })
      .resume(seat, `${kind}_session_file`, sessionFile, "/work");
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(typed()?.startsWith(`${prefix}'/daemon/pi-runner.js' `)).toBe(true);
  });
});
