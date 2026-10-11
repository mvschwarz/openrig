import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

const run = promisify(exec);
const runFile = promisify(execFile);

// Controlled provider-shaped output, not an authenticated Codex invocation.
// The actual terminal process receives the real production resume command.
async function finalObservation(output: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-final-"));
  const socket = path.join(home, "owned.sock");
  const gate = path.join(home, "final-output.txt");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\n` +
    `const fs = require("node:fs");\n` +
    `if (process.argv.slice(2).join(" ") !== "-s workspace-write -c check_for_update_on_startup=false resume fixture-id") process.exit(2);\n` +
    `process.stdout.write("\\n".repeat(36) + "fixture waiting for final observation\\n");\n` +
    `const tick = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) {\n` +
    `process.stdout.write(fs.readFileSync(${JSON.stringify(gate)}, "utf8") + "\\n"); clearInterval(tick);\n` +
    `setInterval(() => {}, 1000); } }, 5);\n`, { mode: 0o755 });
  // The pane's interactive bash saves history into HOME as kill-server hangs it
  // up, racing the teardown's rmSync (ENOTEMPTY); keep that file out of home.
  const env = { ...process.env, HOME: home, TERM: "xterm-256color", HISTFILE: "/dev/null" };
  delete env.TMUX;
  delete env.TMUX_TMPDIR;
  const tmux = async (args: string[]) => (await runFile("tmux", ["-S", socket, ...args], { env })).stdout;
  try {
    await tmux(["-f", "/dev/null", "new-session", "-d", "-s", "fixture", "-x", "160", "-y", "40", "/bin/bash --noprofile --norc -i"]);
    const adapter = new TmuxAdapter(async cmd => {
      expect(cmd).toMatch(/^tmux /);
      return (await run(`tmux -S ${shellQuote(socket)} ${cmd.slice(5)}`, { env })).stdout;
    });
    const nativeCapture = adapter.capturePaneContent.bind(adapter);
    let captures = 0;
    const capture = vi.spyOn(adapter, "capturePaneContent").mockImplementation(async (target, lines) => {
      captures++;
      if (captures === 1) {
        await expect.poll(() => nativeCapture(target, lines), { timeout: 5000 }).toContain("fixture waiting for final observation");
      }
      if (captures === 27) {
        // The default budget has 26 loop observations plus one final read.
        // Release output only at that final boundary, avoiding timer races.
        fs.writeFileSync(gate, output);
        await expect.poll(() => nativeCapture(target, lines), { timeout: 5000 }).toContain(output);
      }
      return nativeCapture(target, lines);
    });
    const resume = new CodexResumeAdapter(adapter, {
      launchPath: `${bin}:/usr/bin:/bin`, codexHome: path.join(home, "private-codex"),
      // Preserve the default observation count; this tests classification at
      // the final read, not the wall-clock duration of the production timeout.
      sleep: async () => {},
    });
    const result = await resume.resume("fixture", "codex_id", "fixture-id", home);
    expect(capture).toHaveBeenCalledTimes(27);
    return result;
  } finally {
    await tmux(["kill-server"]).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("native terminal final Codex resume observation", () => {
  it("retains a late access-token refusal as recoverable attention with evidence", async () => {
    const output = "Your access token could not be refreshed. Please sign in again.";
    expect(await finalObservation(output)).toMatchObject({ ok: false, code: "attention_required", evidence: expect.stringContaining(output) });
  }, 15_000);

  it("retains a late incompatible-client notice as recoverable attention", async () => {
    const output = "This model requires a newer version of Codex.";
    expect(await finalObservation(output)).toMatchObject({ ok: false, code: "attention_required", evidence: expect.stringContaining(output) });
  }, 15_000);

  it("retains a late missing saved session as a fresh-retry outcome", async () => {
    expect(await finalObservation("Error: No saved session found for that token.")).toMatchObject({
      ok: false, code: "retry_fresh", message: "Codex resume failed: no saved session found for the requested token",
    });
  }, 15_000);

  it("still accepts a ready interactive prompt arriving at the final read", async () => {
    expect(await finalObservation("OpenAI Codex (v0.0.0)\n› Ask Codex to do anything")).toMatchObject({ ok: true });
  }, 15_000);

  it("preserves the shell fallback without claiming readiness or attention from unrelated output", async () => {
    // The production launch stages this fixture via /bin/sh. Native tmux sees
    // that foreground wrapper, so retain its existing shell fallback outcome.
    expect(await finalObservation("fixture output remains inconclusive")).toMatchObject({
      ok: false, code: "retry_fresh", message: "Codex resume failed: pane returned to shell instead of entering Codex",
    });
  }, 15_000);
});
