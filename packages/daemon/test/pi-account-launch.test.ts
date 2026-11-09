import { afterEach, expect, it, vi } from "vitest";
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
  expect(launched).toContain(`--account-home '${account}'`);
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
  expect(output).not.toContain("fixture-");
});

it("refuses to replace a seat login or unowned link, and preserves a login created after selection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-account-owned-"));
  roots.push(root);
  const agent = path.join(root, "agent"), account = path.join(root, "account");
  fs.mkdirSync(agent); fs.mkdirSync(account);
  fs.writeFileSync(path.join(account, "auth.json"), "selected-auth");
  const auth = path.join(agent, "auth.json"), marker = path.join(agent, ".openrig-account");
  fs.writeFileSync(auth, "seat-login");
  expect(() => preparePiAccount(agent, account)).toThrow("not a managed account link");
  expect(fs.readFileSync(auth, "utf8")).toBe("seat-login");
  expect(fs.existsSync(marker)).toBe(false);
  fs.rmSync(auth); fs.symlinkSync(path.join(account, "auth.json"), auth);
  expect(() => preparePiAccount(agent, account)).toThrow("not a managed account link");
  expect(fs.lstatSync(auth).isSymbolicLink()).toBe(true);
  fs.rmSync(auth);
  preparePiAccount(agent, account);
  preparePiAccount(agent, account);
  expect(fs.readFileSync(auth, "utf8")).toBe("selected-auth");
  fs.rmSync(auth); fs.writeFileSync(auth, "new-seat-login");
  preparePiAccount(agent, undefined);
  expect(fs.readFileSync(auth, "utf8")).toBe("new-seat-login");
  expect(fs.existsSync(marker)).toBe(false);
});

it.each(["pi", "codex", "claude-code"])("scopes extra provider-key scrubbing to Pi and resets ambient selection (%s)", async runtime => {
  const { execFileSync } = await import("node:child_process");
  const { SeatLaunchEnvironment } = await import("../src/domain/seat-launch-environment.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-account-scope-"));
  roots.push(root);
  const cli = path.join(root, "rig");
  fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const tmux = {
    getPaneCommand: async () => "bash",
    getSessionEnv: async (_session: string, key: string) => key === "OPENRIG_NODE_ID" ? "node" : "seat@rig",
  } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
  const launch = new SeatLaunchEnvironment(tmux, { PATH: "/usr/bin:/bin", OPENRIG_HOME: root }, root, cli);
  const inherited = { PATH: "/usr/bin:/bin", OPENROUTER_API_KEY: "custom-provider-key", OPENAI_API_KEY: "existing-scrub", PI_CODING_AGENT_DIR: "/ambient", OPENRIG_PI_ACCOUNT_HOME: "/stale" };
  const command = await launch.command("seat@rig", "/usr/bin/env", { nodeId: "node", runtime, accountHome: "/selected" });
  const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", env: inherited });
  expect(output).not.toContain("existing-scrub");
  if (runtime === "pi") {
    expect(output).not.toContain("custom-provider-key");
    expect(output).toContain("OPENRIG_PI_ACCOUNT_HOME=/stale\n");
    const unselected = await launch.command("seat@rig", "/usr/bin/env", { nodeId: "node", runtime });
    const ambient = execFileSync("/bin/sh", ["-c", unselected], { encoding: "utf8", env: inherited });
    expect(ambient).toContain("OPENRIG_PI_ACCOUNT_HOME=/stale\n");
  } else expect(output).toContain("OPENROUTER_API_KEY=custom-provider-key\n");
});

it.each(["nu", "fish", "bash"])("retains the short account-free fallback (%s)", async shell => {
  const { execFileSync } = await import("node:child_process");
  const { SeatLaunchEnvironment } = await import("../src/domain/seat-launch-environment.js");
  const tmux = {
    getPaneCommand: async () => shell,
    getSessionEnv: async () => undefined,
  } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
  const launch = new SeatLaunchEnvironment(tmux, {}, "/tmp");
  const command = await launch.command("seat@rig", "/usr/bin/env", { runtime: "pi" });
  expect(command).toBe("/usr/bin/env");
  const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { OPENRIG_PI_ACCOUNT_HOME: "/unselected" } });
  expect(output).toContain("OPENRIG_PI_ACCOUNT_HOME=/unselected\n"); // The runner ignores this obsolete variable.
  expect(await launch.command("seat@rig", "/usr/bin/env", { runtime: "pi", accountHome: "/selected" })).toContain("no agent started");
});

it("retries an interrupted initial account link without treating it as a person's own link", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-account-interrupted-")); roots.push(root);
  const agent = path.join(root, "agent"), account = path.join(root, "account");
  fs.mkdirSync(account); fs.writeFileSync(path.join(account, "auth.json"), "synthetic-auth");
  const symlink = fs.symlinkSync;
  const interruption = vi.spyOn(fs, "symlinkSync").mockImplementation((...args) => {
    symlink(...args); throw new Error("simulated interruption immediately after linking");
  });
  try { expect(() => preparePiAccount(agent, account)).toThrow("simulated interruption"); }
  finally { interruption.mockRestore(); }
  preparePiAccount(agent, account);
  expect(fs.readFileSync(path.join(agent, "auth.json"), "utf8")).toBe("synthetic-auth");
  expect(fs.readFileSync(path.join(agent, ".openrig-account"), "utf8")).toBe(account);
});

it.each([false, true])("resume tolerates unavailable tmux identity only without a chosen account (%s)", async chosen => {
  const { PiResumeAdapter } = await import("../src/adapters/pi-resume.js");
  const { SeatLaunchEnvironment } = await import("../src/domain/seat-launch-environment.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resume-identity-")); roots.push(root);
  const sessionFile = path.join(root, "session.jsonl"); fs.writeFileSync(sessionFile, "{}");
  let dispatched = false;
  const tmux = {
    getSessionEnv: async () => { throw new Error("metadata unavailable"); },
    getPaneCommand: async () => "bash",
    sendShellCommand: async () => {
      dispatched = true;
      fs.writeFileSync(path.join(root, "seat@rig/runner-state.json"), JSON.stringify({ ready: true, launchId: "attempt", sessionFile, updatedAt: "now" }));
      return { ok: true as const };
    },
  } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
  const launch = new SeatLaunchEnvironment(tmux, {}, root);
  const adapter = new PiResumeAdapter(tmux, {
    readFile: file => fs.readFileSync(file, "utf8"), writeFile: fs.writeFileSync,
    exists: fs.existsSync, mkdirp: file => fs.mkdirSync(file, { recursive: true }),
  }, { stateRoot: root, runnerEntryPath: "/runner.js" }, {
    seatLaunchEnvironment: launch, accountHomeForSession: () => chosen ? "/chosen" : undefined, newLaunchId: () => "attempt",
  });
  expect(await adapter.resume("seat@rig", "pi_session_file", sessionFile, root)).toMatchObject({ ok: !chosen });
  expect(dispatched).toBe(!chosen);
});

it("reports the real cause and the seat's own login file when a declared home meets that login, and keeps it", async () => {
  const { main } = await import("../src/adapters/pi-runner.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-own-login-")); roots.push(root);
  const account = path.join(root, "account"), agent = path.join(root, "seat", "agent");
  fs.mkdirSync(account); fs.writeFileSync(path.join(account, "auth.json"), "declared-auth");
  fs.mkdirSync(agent, { recursive: true }); fs.writeFileSync(path.join(agent, "auth.json"), "seat-login");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitCode = process.exitCode;
  try {
    await main(["--session-name", "seat", "--state-root", root, "--cwd", root,
      "--launch-id", "attempt", "--no-approve", "--account-home", account]);
    expect(process.exitCode).toBe(2);
    const printed = error.mock.calls.flat().join("\n");
    expect(printed).toContain("Existing Pi login is not a managed account link; use a confirmed account switch");
    expect(printed).toContain(`seat login file ${JSON.stringify(path.join(agent, "auth.json"))}`);
    expect(printed).toContain(`account file ${JSON.stringify(path.join(account, "auth.json"))}`);
    expect(printed).not.toContain("provide a readable prepared account file");
    expect(printed).not.toContain("was not changed");
    expect(fs.readFileSync(path.join(agent, "auth.json"), "utf8")).toBe("seat-login");
  } finally { process.exitCode = exitCode; error.mockRestore(); }
});

it("reports a missing prepared auth file in the seat's own home without an uncaught lstat error", async () => {
  const { main } = await import("../src/adapters/pi-runner.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-own-account-")); roots.push(root);
  const agent = path.join(root, "seat", "agent");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitCode = process.exitCode;
  try {
    await expect(main(["--session-name", "seat", "--state-root", root, "--cwd", root,
      "--launch-id", "attempt", "--no-approve", "--account-home", agent])).resolves.toBeUndefined();
    expect(process.exitCode).toBe(2);
    expect(error.mock.calls.flat().join("\n")).toContain(path.join(agent, "auth.json"));
    expect(error.mock.calls.flat().join("\n")).toContain("Pi account preparation failed");
    expect(fs.existsSync(path.join(agent, ".openrig-account"))).toBe(false);
    expect(() => preparePiAccount(agent, undefined)).not.toThrow();
  } finally { process.exitCode = exitCode; error.mockRestore(); }
});
