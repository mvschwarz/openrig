import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { setupCommand, type SetupDeps, type SetupResult } from "../src/commands/setup.js";

// Exercise the real command/result path without probing or changing this host. A case can set the doctor checks.
const doctor = vi.hoisted(() => ({ checks: [] as Array<Record<string, unknown>> }));
vi.mock("../src/commands/doctor.js", () => ({
  runDoctorChecks: () => ({ checks: doctor.checks, asyncChecks: [] }),
}));
vi.mock("../src/config-store.js", () => ({
  ConfigStore: class {
    resolve() { return { daemon: { host: "127.0.0.1", port: 1 } }; }
  },
}));

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(failed: boolean): SetupDeps {
  return {
    platform: "darwin",
    env: {},
    exec: vi.fn((cmd: string) => {
      if (cmd === "claude auth status" && failed) throw new Error("fixture login missing");
      if (cmd === "cmux capabilities --json") return '{"capabilities":[]}';
      return "available";
    }),
    readFile: () => null,
    exists: () => false,
    writeFile: vi.fn(),
    mkdirp: vi.fn(),
  };
}

function expectConversationRoute(text: string): void {
  expect(text).toContain("Show the person OpenRig: open the OpenRig TUI and operator for them now");
  expect(text).toContain("On a Mac, offer Ghostty once");
  expect(text).toContain("rig setup --ghostty");
  expect(text).toContain("--no-ghostty");
  expect(text).toContain("preserve earlier choices such as --no-herdr");
  expect(text).toContain("rig terminal open saved:kernel");
  expect(text).toContain("rig terminal open saved:kernel --window --json");
  expect(text).toContain("On a desktop, no copying or typing for the person; check the result notes, not just CLI success");
  expect(text).toContain("Over headless SSH: ask the person to open a new terminal/tab and give the exact connection/attach command");
  expect(text).toContain("then hand them to the ready operator");
  expect(text).toContain("Do not implement the person's project yourself");
  expect(text).toContain("Started is not ready");
  expect(text).toContain("rig context get reference/getting-started.md#incomplete-setup-and-restart");
}

describe("setup conversation handoff output", () => {
  for (const mode of ["dry-run", "failed", "ready"] as const) {
    for (const json of [false, true]) {
      it(`${mode} retains its outcome and offers the operator route in ${json ? "JSON" : "human output"}`, async () => {
        process.exitCode = undefined;
        vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
        const logs: string[] = [];
        vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.map(String).join(" ")); });
        const deps = fixture(mode === "failed");
        const program = new Command().addCommand(setupCommand(deps));
        await program.parseAsync(["node", "rig", "setup", ...(mode === "dry-run" ? ["--dry-run"] : []), ...(json ? ["--json"] : [])]);

        const output = logs.join("\n");
        expect(process.exitCode).toBe(mode === "failed" ? 1 : undefined);
        if (json) {
          expect(logs).toHaveLength(1);
          const result = JSON.parse(output) as SetupResult & { nextSteps: string[] };
          expect(result.ready).toBe(mode === "ready");
          expect(result.profile).toBe("core");
          expect(result.platform).toBe("darwin");
          expect(result.runtimeConfig.length).toBeGreaterThan(0);
          expectConversationRoute(result.nextSteps?.join("\n") ?? "");
          if (mode === "failed") {
            expect(result.steps).toContainEqual(expect.objectContaining({ id: "claude_auth", status: "fail", message: expect.stringContaining("fixture login missing") }));
          } else if (mode === "dry-run") {
            expect(result.steps.every((step) => step.status === "skipped")).toBe(true);
          }
        } else {
          expectConversationRoute(output);
          expect(output.includes("Setup complete.")).toBe(mode === "ready");
          expect(output).toContain("Permission policy (optional");
          if (mode === "failed") expect(output).toContain("fixture login missing");
          if (mode === "dry-run") {
            expect(output).toContain("Plan only: no setup changes were made; readiness was not checked.");
            // A short installer read must still reach the conversation handoff.
            expectConversationRoute(output.split("\n").slice(0, 80).join("\n"));
          }
        }
        if (mode === "dry-run") {
          expect(deps.exec).not.toHaveBeenCalled();
          expect(deps.writeFile).not.toHaveBeenCalled();
          expect(deps.mkdirp).not.toHaveBeenCalled();
          expect(fetch).not.toHaveBeenCalled();
        }
      });
    }
  }
});


it.each([
  [[], "offers Ghostty once"],
  [["--ghostty"], "installation would be attempted"],
  [["--no-ghostty"], "declined"],
] as const)("keeps the Ghostty choice in dry-run JSON: %j", async (flags, expected) => {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.map(String).join(" ")));
  const program = new Command().exitOverride().addCommand(setupCommand(fixture(false)));
  await program.parseAsync(["node", "rig", "setup", "--dry-run", "--json", ...flags]);
  const result = JSON.parse(logs[0]!) as SetupResult;
  expect(result.steps.find(step => step.id === "ghostty_install")?.message).toContain(expected);
});

// The installer's step 4 consumes only `rig setup`'s exit status and prints setup's own output. These five
// cases pin that boundary: an incomplete setup exits 1 and lists what is left (each with its Fix) under
// "Some steps need attention"; a ready one exits 0 with "Setup complete.". A failed provider probe is listed
// as "not ready to launch" with the probe's own error, whatever the cause, so the installer names no sign-in.
describe("the installer's setup boundary", () => {
  const run = async (exec: (cmd: string) => string, flags: string[] = []) => {
    process.exitCode = undefined;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.map(String).join(" ")); });
    const deps: SetupDeps = { platform: "darwin", env: {}, exec: vi.fn(exec), readFile: () => null, exists: () => false, writeFile: vi.fn(), mkdirp: vi.fn() };
    await new Command().addCommand(setupCommand(deps)).parseAsync(["node", "rig", "setup", ...flags]);
    const output = logs.join("\n");
    return { exitCode: process.exitCode, output, attention: output.slice(output.indexOf("Some steps need attention:")) };
  };
  const ok = (cmd: string) => cmd === "cmux capabilities --json" ? '{"capabilities":[]}' : "available";

  it("a sign-in only: exit 1, the provider listed with its Fix", async () => {
    const r = await run((cmd) => { if (cmd === "claude auth status") throw new Error("Not logged in"); return ok(cmd); });
    expect(r.exitCode).toBe(1);
    expect(r.attention).toContain("claude_auth: Claude Code is installed but not ready to launch: Not logged in");
    expect(r.attention).toContain("Fix: Run `claude auth login`");
  });

  it("a real failure beside a sign-in: exit 1, both listed", async () => {
    const r = await run((cmd) => {
      if (cmd === "claude auth status") throw new Error("Not logged in");
      if (cmd === "codex --version" || cmd === "npm install -g @openai/codex") throw new Error("npm ERR! network");
      return ok(cmd);
    });
    expect(r.exitCode).toBe(1);
    expect(r.attention).toContain("claude_auth:");
    expect(r.attention).toContain("codex_install:");
  });

  it("ready: exit 0 and Setup complete", async () => {
    const r = await run(ok);
    expect(r.exitCode).toBeUndefined();
    expect(r.output).toContain("Setup complete.");
    expect(r.output).not.toContain("Some steps need attention:");
  });

  it("an unselected provider is not a failure: exit 0 with only the chosen provider checked", async () => {
    const r = await run((cmd) => { if (cmd.startsWith("codex")) throw new Error("codex absent"); return ok(cmd); }, ["--providers", "claude"]);
    expect(r.exitCode).toBeUndefined();
    expect(r.output).toContain("Setup complete.");
    expect(r.output).toContain("codex_auth: Not selected");
    // Ready for Claude alone, and still told that a built-in team's Codex seat needs that login, as doctor says.
    expect(r.output).toContain("A built-in team can use one you didn't select: starter runs its reviewer on Codex.");
  });

  it("an uncertain probe is listed with its own error, not as a confirmed missing login", async () => {
    const r = await run((cmd) => { if (cmd === "claude auth status") throw new Error("Command timed out after 10000ms"); return ok(cmd); });
    expect(r.exitCode).toBe(1);
    expect(r.attention).toContain("claude_auth: Claude Code is installed but not ready to launch: Command timed out after 10000ms");
    expect(r.attention).not.toMatch(/not logged in/i);
  });

  // A failed doctor check leaves setup not ready, so it's listed too. A provider check is a reused step, so it isn't
  // listed twice.
  it("a failed doctor check: exit 1, listed with its Fix, and a reused provider step listed once", async () => {
    doctor.checks = [
      { name: "port", status: "fail", message: "Port 127.0.0.1:7433 is in use by another process.",
        fix: "Stop the process using port 7433, or start the daemon on a different port with: rig daemon start --port <port>" },
      { name: "claude_auth", status: "fail", message: "Claude Code is installed but not ready to launch: Not logged in" },
    ];
    try {
      const r = await run((cmd) => { if (cmd === "claude auth status") throw new Error("Not logged in"); return ok(cmd); });
      expect(r.exitCode).toBe(1);
      expect(r.attention).toContain("port: Port 127.0.0.1:7433 is in use by another process.");
      expect(r.attention).toContain("Fix: Stop the process using port 7433");
      expect(r.attention.split("claude_auth:").length - 1).toBe(1);
    } finally {
      doctor.checks = [];
    }
  });

  // A first user on a shared machine whose configured port is served by another OS user's OpenRig daemon, or a share set
  // up through config alone: setup stays ready and exits 0, and still shows whose daemon it is and the way on.
  it("another user's daemon on the configured port: exit 0, Setup complete, and the warning listed with its Fix", async () => {
    doctor.checks = [
      { name: "port", status: "warn",
        message: "Port 127.0.0.1:7433 is in use by an OpenRig daemon of another OS user: the endpoint reports euid 1001; your euid is 1002.",
        fix: "To run your own, give this OpenRig home a free port and start its daemon there." },
      { name: "cmux", status: "warn", message: "cmux is not installed." },
    ];
    try {
      const r = await run(ok);
      expect(r.exitCode).toBeUndefined();
      expect(r.output).toContain("Setup complete.");
      expect(r.attention).toContain("port: Port 127.0.0.1:7433 is in use by an OpenRig daemon of another OS user: the endpoint reports euid 1001");
      expect(r.attention).toContain("Fix: To run your own, give this OpenRig home a free port and start its daemon there.");
      expect(r.attention).not.toContain("cmux:");
    } finally {
      doctor.checks = [];
    }
  });
});

// A whole setup run, where the person asked for one: --router-line beside another setup option, a --json run that says
// what it's doing while it works, and the daemon's default address on a machine with Tailscale.
describe("setup's whole run: the router line beside other options, --json progress, the daemon address", () => {
  const ok = (cmd: string) => cmd === "cmux capabilities --json" ? '{"capabilities":[]}' : "available";
  const run = async (flags: string[], extra: Partial<SetupDeps> = {}) => {
    process.exitCode = undefined;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.map(String).join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args.map(String).join(" ")); });
    const saved: string[] = [];
    const deps: SetupDeps = {
      platform: "darwin", env: {}, exec: vi.fn(ok), readFile: () => null, exists: () => false, writeFile: vi.fn(), mkdirp: vi.fn(),
      routerLineStore: { resolveWithSource: () => ({ value: false, source: "default", defaultValue: false }), set: (key: string, value: string) => { saved.push(`${key}=${value}`); } },
      daemonBind: () => ({ explicit: false, tailscaleIp: null }),
      ...extra,
    };
    await new Command().addCommand(setupCommand(deps)).parseAsync(["node", "rig", "setup", ...flags]);
    return { exitCode: process.exitCode, logs, errors, output: logs.join("\n"), deps, saved };
  };

  it("--router-line beside another setup option still runs the whole setup and saves the answer as one of its steps", async () => {
    const r = await run(["--providers", "claude", "--router-line", "yes"]);
    expect(r.exitCode).toBeUndefined();
    expect(r.deps.exec).toHaveBeenCalled();
    expect(r.output).toMatch(/\] tmux_install: /);
    expect(r.output).toContain("  [APPLIED] router_line: Saved: yes.");
    expect(r.output).toContain("Setup complete.");
    expect(r.saved).toEqual(["skills.router_line.enabled=true"]);
  });

  it("--json says on stderr what it's doing while it runs, and stdout stays one JSON result", async () => {
    const r = await run(["--json", "--providers", "claude"]);
    expect(r.exitCode).toBeUndefined();
    expect(r.logs).toHaveLength(1);
    const result = JSON.parse(r.logs[0]!) as SetupResult;
    expect(result.ready).toBe(true);
    expect(r.errors[0]).toBe("rig setup: running every setup step (installs and checks can take a few minutes); the JSON result prints when they finish.");
    // Each step says so as it lands, so a long install or check never looks like a hang.
    for (const step of result.steps) expect(r.errors).toContain(`rig setup: ${step.id}: ${step.status}`);
    expect(r.errors).toContain("rig setup: verification: running the doctor checks");
  });

  it("without --json, or in a dry run, it prints no progress lines", async () => {
    expect((await run(["--providers", "claude"])).errors.filter((line) => line.startsWith("rig setup:"))).toEqual([]);
    expect((await run(["--json", "--dry-run"])).errors.filter((line) => line.startsWith("rig setup:"))).toEqual([]);
  });

  it("with Tailscale active and no bind chosen, it says the daemon also listens on the Tailscale address, why, and how to keep it local", async () => {
    const bind = { daemonBind: () => ({ explicit: false, tailscaleIp: "100.101.102.103" }) };
    const text = await run(["--providers", "claude"], bind);
    expect(text.output).toContain("Daemon address: Tailscale is active on this machine, so by default `rig daemon start` listens on 127.0.0.1 and on its Tailscale address, 100.101.102.103: your other OpenRig machines and the web UI can then reach it over your tailnet.");
    expect(text.output).toContain("  To keep it on this machine only: rig config set daemon.host 127.0.0.1 (it applies from the daemon's next start).");
    const json = JSON.parse((await run(["--json", "--providers", "claude"], bind)).logs[0]!) as SetupResult;
    expect(json.daemonBind).toMatchObject({ hosts: ["127.0.0.1", "100.101.102.103"], change: expect.stringContaining("rig config set daemon.host 127.0.0.1") });
    const plan = JSON.parse((await run(["--json", "--dry-run"], bind)).logs[0]!) as SetupResult;
    expect(plan.daemonBind?.hosts).toEqual(["127.0.0.1", "100.101.102.103"]);
  });

  it("says nothing about the address when the bind is chosen, or Tailscale isn't active; the default bind itself is unchanged", async () => {
    for (const facts of [{ explicit: true, tailscaleIp: null }, { explicit: false, tailscaleIp: null }]) {
      const r = await run(["--providers", "claude"], { daemonBind: () => facts });
      expect(r.output).not.toContain("Daemon address:");
      expect((JSON.parse((await run(["--json", "--providers", "claude"], { daemonBind: () => facts })).logs[0]!) as SetupResult).daemonBind).toBeUndefined();
    }
  });
});
