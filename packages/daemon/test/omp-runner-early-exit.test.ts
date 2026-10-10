// The OMP runner's report when OMP exits during startup, before its RPC
// transport starts. The runner cannot tell why OMP stopped, so it must not
// claim a cause: it states the phase and how OMP exited, and keeps OMP's own
// output visible. These run the real runner entry against fake executables.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const RUNNER = nodePath.join(__dirname, "..", "src", "adapters", "pi-runner.ts");

let root: string | null = null;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null; });

/** Run the real runner with a fake `<runtime>` that runs `before`, prints
 *  `stderr`, and ends with `ending`. */
function runWithFake(runtime: "omp" | "pi", stderr: string[], ending = "exit 1", before = "") {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), `openrig-${runtime}-early-exit-`));
  const bin = nodePath.join(root, "bin");
  fs.mkdirSync(bin);
  const lines = stderr.map((line) => `printf '%s\\n' '${line}' >&2`).join("\n");
  fs.writeFileSync(nodePath.join(bin, runtime), `#!/bin/sh\n${before}\n${lines}\n${ending}\n`, { mode: 0o755 });
  const args = [
    "--import", "tsx", RUNNER,
    "--session-name", "dev@rig", "--state-root", nodePath.join(root, "state", runtime), "--cwd", root,
    "--launch-id", "launch-1",
  ];
  args.push(...(runtime === "omp" ? ["--runtime", "omp", "--approval-mode", "always-ask"] : ["--no-approve"]));
  const result = spawnSync(process.execPath, args, {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: os.tmpdir() },
    input: "",
    encoding: "utf8",
    timeout: 30_000,
  });
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

const errorLine = (output: string) => output.split("\n").find((line) => line.startsWith("[omp-runner] ERROR")) ?? "";

describe("OMP exits during startup, before its RPC transport", () => {
  it("no models available: no cause is claimed; phase, exit code, and OMP's output are reported", () => {
    const stderr = [
      "No models available. Use /login or set an API key environment variable. Then use /model to select a model.",
      "Set an API key environment variable:",
      "  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.",
    ];
    const { output } = runWithFake("omp", stderr);
    expect(output).not.toContain("not a credential problem");
    const error = errorLine(output);
    expect(error).toContain("OMP exited during startup, before its RPC transport started");
    expect(error).toContain("exit code 1");
    expect(error).toContain("Its last output: No models available. Use /login or set an API key environment variable.");
    // OMP's own lines are still mirrored as they arrive.
    expect(output).toContain(`[omp:err] ${stderr[0]}`);
  }, 40_000);

  it("control: an unrelated crash gets the same honest wording", () => {
    const { output } = runWithFake("omp", ["TypeError: Cannot read properties of undefined (reading model)", "    at main (cli.js:12:3)"], "exit 7");
    expect(output).not.toContain("credential");
    const error = errorLine(output);
    expect(error).toContain("OMP exited during startup, before its RPC transport started");
    expect(error).toContain("exit code 7");
    expect(error).toContain("Its last output: TypeError: Cannot read properties of undefined (reading model) |     at main (cli.js:12:3)");
  }, 40_000);

  it("a signal and silent stderr are reported as such", () => {
    const { output } = runWithFake("omp", [], "kill -TERM $$");
    const error = errorLine(output);
    expect(error).toContain("signal SIGTERM");
    expect(error).toContain("It printed nothing on stderr.");
  }, 40_000);

  it("keeps only a bounded tail of OMP's output in the error", () => {
    const many = Array.from({ length: 12 }, (_, n) => `line ${n + 1}`);
    const error = errorLine(runWithFake("omp", [...many, "x".repeat(1_000)]).output);
    expect(error).not.toContain("line 8 |");
    expect(error).toContain("line 9 | line 10 | line 11 | line 12 | ");
    expect(error).toContain(`${"x".repeat(300)}...`);
    expect(error).not.toContain("x".repeat(301));
  }, 40_000);
});

describe("OMP exit record with a child holding OMP's stderr", () => {
  it("is still written promptly, with OMP's output in it", async () => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-omp-grandchild-"));
    const bin = nodePath.join(root, "bin");
    fs.mkdirSync(bin);
    const pidFile = nodePath.join(root, "sleeper.pid");
    // Like an LSP or MCP server OMP started: inherits OMP's stdio and outlives it.
    fs.writeFileSync(nodePath.join(bin, "omp"), `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nprintf '%s\\n' 'fatal: startup failed' >&2\nexit 1\n`, { mode: 0o755 });
    let output = "";
    const runner = spawn(process.execPath, [
      "--import", "tsx", RUNNER,
      "--session-name", "dev@rig", "--state-root", nodePath.join(root, "state", "omp"), "--cwd", root,
      "--launch-id", "launch-1", "--runtime", "omp", "--approval-mode", "always-ask",
    ], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: os.tmpdir() }, stdio: ["pipe", "pipe", "pipe"] });
    runner.stdout.on("data", (chunk) => { output += String(chunk); });
    runner.stderr.on("data", (chunk) => { output += String(chunk); });
    try {
      const started = Date.now();
      while (Date.now() - started < 8_000 && !errorLine(output)) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(errorLine(output)).toContain("exit code 1).");
      expect(errorLine(output)).toContain("Its last output: fatal: startup failed");
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      runner.kill("SIGKILL");
      try { process.kill(Number(fs.readFileSync(pidFile, "utf8").trim()), "SIGKILL"); } catch { /* already gone */ }
    }
  }, 20_000);
});

describe("Pi is unchanged", () => {
  it("an early Pi exit keeps Pi's markers and gets no OMP diagnostic", () => {
    // The fake Pi reads the runner's initial RPC line before it fails, so the
    // runner's first stdin write never races the child's exit (an EPIPE on
    // that write would otherwise come before the lines asserted below).
    const { output } = runWithFake("pi", ["pi: fatal: bad config"], "exit 1", "IFS= read -r first_rpc_line");
    expect(output).toContain("[pi:err] pi: fatal: bad config");
    expect(output).toContain("[pi-runner] EXITED pi exited (code 1)");
    expect(output).not.toContain("[omp-runner]");
    expect(output).not.toContain("Its last output");
  }, 40_000);
});
