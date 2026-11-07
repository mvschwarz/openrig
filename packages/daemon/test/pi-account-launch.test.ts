import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preparePiAccount } from "../src/adapters/pi-runner.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it("links only the selected account auth and removes its managed link when cleared", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-account-"));
  roots.push(root);
  const agent = path.join(root, "seat", "agent"), account = path.join(root, "account");
  fs.mkdirSync(account);
  fs.writeFileSync(path.join(account, "auth.json"), JSON.stringify({ mistral: { type: "api_key", key: "test-key" } }));
  preparePiAccount(agent, account);
  expect(fs.realpathSync(path.join(agent, "auth.json"))).toBe(fs.realpathSync(path.join(account, "auth.json")));
  preparePiAccount(agent, undefined);
  expect(fs.existsSync(path.join(agent, "auth.json"))).toBe(false);
  expect(fs.existsSync(path.join(account, "auth.json"))).toBe(true);
});

it.each([undefined, ["wrapper", "arg with spaces", "--"]])("preserves the selected account and wrapper when resuming a Pi seat (%j)", async wrapper => {
  const { PiResumeAdapter } = await import("../src/adapters/pi-resume.js");
  const { SeatLaunchEnvironment } = await import("../src/domain/seat-launch-environment.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resume-account-"));
  roots.push(root);
  const cli = path.join(root, "rig"), sessionFile = path.join(root, "session.jsonl"), account = path.join(root, "account");
  fs.writeFileSync(path.join(root, "wrapper"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(sessionFile, "{}");
  let launched = "";
  const identity: Record<string, string> = { OPENRIG_NODE_ID: "pi-node", OPENRIG_SESSION_NAME: "build@rig", OPENRIG_RUNTIME: "pi", OPENRIG_OCCUPANT_GENERATION: "generation" };
  const tmux = {
    getSessionEnv: async (_session: string, key: string) => identity[key],
    getPaneCommand: async () => "bash",
    sendShellCommand: async (_session: string, command: string) => {
      launched = command;
      fs.writeFileSync(path.join(root, "account-switches", "committed-generation", "build@rig/runner-state.json"), JSON.stringify({ ready: true, launchId: "attempt", sessionFile, updatedAt: "now" }));
      return { ok: true as const };
    },
  } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
  const resumedRoot = path.join(root, "account-switches", "committed-generation");
  const launch = new SeatLaunchEnvironment(tmux, { PATH: `${root}:/usr/bin`, OPENRIG_HOME: root }, root, cli, undefined,
    (node, runtime) => node === "pi-node" && runtime === "pi" ? account : undefined);
  const adapter = new PiResumeAdapter(tmux, {
    readFile: file => fs.readFileSync(file, "utf8"), writeFile: (file, text) => fs.writeFileSync(file, text),
    exists: fs.existsSync, mkdirp: file => fs.mkdirSync(file, { recursive: true }),
  }, { stateRoot: root, runnerEntryPath: "/runner.js" }, { stateRootForSession: () => resumedRoot, seatLaunchEnvironment: launch, newLaunchId: () => "attempt" });
  expect(await adapter.resume("build@rig", "pi_session_file", sessionFile, root, "mistral/devstral-latest", undefined, undefined, wrapper)).toMatchObject({ ok: true });
  expect(launched).toContain(`PI_CODING_AGENT_DIR=${account}`);
  expect(launched).toContain(`--state-root '${resumedRoot}'`);
  if (wrapper) expect(launched).toContain(`--launch-wrapper-arg '${root}/wrapper' --launch-wrapper-arg 'arg with spaces' --launch-wrapper-arg '--'`);
  let attempts = 0;
  tmux.sendShellCommand = async () => { attempts++; return { ok: false, code: "launch_path_too_long", message: "fixture bound" }; };
  expect(await adapter.resume("build@rig", "pi_session_file", sessionFile, root, "mistral/devstral-latest", undefined, undefined, wrapper))
    .toMatchObject({ ok: false, code: "resume_failed" });
  expect(attempts).toBe(1);
});

it("keeps the previous credentials when a selected account cannot be read, and leaves unselected seat auth alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-account-"));
  roots.push(root);
  const agent = path.join(root, "agent"), account = path.join(root, "account");
  fs.mkdirSync(agent);
  fs.mkdirSync(account);
  const auth = path.join(agent, "auth.json");
  fs.writeFileSync(auth, "seat-auth");
  preparePiAccount(agent, undefined);
  expect(fs.readFileSync(auth, "utf8")).toBe("seat-auth");
  expect(() => preparePiAccount(agent, account)).toThrow();
  expect(fs.readFileSync(auth, "utf8")).toBe("seat-auth");
  preparePiAccount(agent, agent);
  expect(fs.readFileSync(auth, "utf8")).toBe("seat-auth");
  const alias = path.join(root, "alias");
  fs.symlinkSync(agent, alias, "junction");
  preparePiAccount(agent, alias);
  expect(fs.readFileSync(auth, "utf8")).toBe("seat-auth");
});

it.each(["selected", "cleared"])("executes a %s Pi account environment without leaking inherited provider keys", async selection => {
  const { execFileSync } = await import("node:child_process");
  const { SeatLaunchEnvironment } = await import("../src/domain/seat-launch-environment.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-account-env-"));
  roots.push(root);
  const cli = path.join(root, "rig");
  fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const tmux = {
    getPaneCommand: async () => "bash",
    getSessionEnv: async (_session: string, key: string) => key === "OPENRIG_NODE_ID" ? "pi-node" : "seat@rig",
  } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
  const launch = new SeatLaunchEnvironment(tmux, { PATH: "/usr/bin:/bin", OPENRIG_HOME: root }, root, cli, undefined,
    (_node, _runtime, clearing) => clearing ? "/pi/configured" : "/pi/selected");
  const command = await launch.command("seat@rig", "/usr/bin/env", {
    nodeId: "pi-node", runtime: "pi", ...(selection === "cleared" ? { accountHome: null } : {}),
  });
  const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", env: {
    PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: "/pi/stale", MISTRAL_API_KEY: "fixture-mistral", GEMINI_API_KEY: "fixture-gemini", OPENROUTER_API_KEY: "fixture-openrouter", ZAI_API_KEY: "fixture-zai", KIMI_API_KEY: "fixture-kimi", MINIMAX_API_KEY: "fixture-minimax",
  } });
  expect(output).toContain(`PI_CODING_AGENT_DIR=/pi/${selection === "cleared" ? "configured" : "selected"}\n`);
  if (selection === "selected") {
    expect(output).not.toContain("fixture-");
  }
});
