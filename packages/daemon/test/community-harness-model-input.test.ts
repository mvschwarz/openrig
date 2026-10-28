import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";
import { CommunityHarnessRuntimeAdapter } from "../src/adapters/community-harness-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

// A community harness whose launcher takes the seat's declared model (`passes_model: true`) as OPENRIG_MODEL.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "model-input-")); dirs.push(dir); return dir; };
const PRESET = "format: 1\nname: synth\ncommand: synth-launch\nmaintainer: Example\nlimits: []\n";

/** A seat whose pane runs the typed command in a real shell, with a stand-in launcher that writes what it received. */
function seat(preset: string, opts: { fail?: "before" | "after" | "typed" } = {}) {
  const dir = scratch();
  writeFileSync(join(dir, "synth.yaml"), preset);
  const launcher = join(dir, "synth-launch");
  writeFileSync(launcher, `#!/bin/sh\nprintf '%s' "\${OPENRIG_MODEL-<unset>}" > "${dir}/received"\n`, { mode: 0o755 });
  const sendShellCommand = vi.fn(async (_session: string, command: string, beforeInput?: () => void) => {
    if (opts.fail === "before") return { ok: false as const, message: "no pane" };
    beforeInput?.();
    if (opts.fail === "after") throw new Error("pane went away mid-launch");
    if (opts.fail === "typed") return { ok: false as const, message: "typed, then the pane went away" };
    execFileSync("sh", ["-c", command], { env: { PATH: `${dir}:${process.env["PATH"]}`, OPENRIG_MODEL: "inherited" } });
    return { ok: true as const };
  });
  const app = new CommunityHarnessRuntimeAdapter("synth", { tmux: { hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "node"), sendShellCommand },
    presetsDir: () => dir, launchResultRoot: () => join(dir, "state", "launch-results"), launchResultWait: { timeoutMs: 20, intervalMs: 10 } });
  const received = () => readFileSync(join(dir, "received"), "utf8");
  return { app, sendShellCommand, received, dir };
}
const binding = (model?: string) => ({ tmuxSession: "w@r", ...(model === undefined ? {} : { model }) }) as NodeBinding;
const OPTED = `${PRESET}passes_model: true\n`;

describe("a community harness that takes the seat's declared model", () => {
  it("passes the declared model to an opted-in launcher exactly, and says it was passed, not which model runs", async () => {
    const { app, received } = seat(OPTED);
    const model = "vendor/model one's $HOME `x`";
    const result = await app.launchHarness(binding(model), { name: "w@r" });
    expect(result).toMatchObject({ ok: true, modelInput: { model, dispatch: "confirmed" } });
    expect(received()).toBe(model);
  });

  it("passes no model, and clears an inherited one, when the seat declares none", async () => {
    const { app, received } = seat(OPTED);
    const result = await app.launchHarness(binding(), { name: "w@r" });
    expect(result.modelInput).toBeUndefined();
    expect(received()).toBe("<unset>");
  });

  it("leaves a preset that doesn't opt in exactly as before, even with a declared model", async () => {
    const { app, sendShellCommand } = seat(PRESET);
    const result = await app.launchHarness(binding("vendor/model"), { name: "w@r" });
    expect(result).toEqual({ ok: true });
    expect(sendShellCommand.mock.calls[0]![1]).toBe("synth-launch");
  });

  it("passes the model on a resume as well, and each launch its own model when the declaration changes", async () => {
    const { app, sendShellCommand, received } = seat(`${OPTED}names_conversation: true\nresume: true\n`);
    expect(await app.launchHarness(binding("vendor/a"), { name: "w@r" })).toMatchObject({ modelInput: { model: "vendor/a", dispatch: "confirmed" } });
    expect(received()).toBe("vendor/a");
    const resumed = await app.launchHarness(binding("vendor/b"), { name: "w@r", resumeToken: "openrig-w-r-1a2b3c4d", resumeType: "community:synth" });
    expect(resumed).toMatchObject({ ok: true, modelInput: { model: "vendor/b", dispatch: "confirmed" } });
    expect(received()).toBe("vendor/b");
    expect(sendShellCommand.mock.calls[1]![1]).toContain("OPENRIG_RESUME_REF=");
  });

  it("doesn't call a model passed when the launch failed before anything was typed", async () => {
    const { app } = seat(OPTED, { fail: "before" });
    const result = await app.launchHarness(binding("vendor/model"), { name: "w@r" });
    expect(result.ok).toBe(false);
    expect(result.modelInput).toBeUndefined();
  });

  it.each([["throws", "after"], ["reports a failure", "typed"]] as const)(
    "keeps the model's dispatch uncertain, not passed, when typing began and the send then %s, and doesn't type it again", async (_case, fail) => {
      const { app, sendShellCommand } = seat(OPTED, { fail });
      const result = await app.launchHarness(binding("vendor/model"), { name: "w@r" });
      expect(result).toMatchObject({ ok: false, modelInput: { model: "vendor/model", dispatch: "uncertain" } });
      expect(sendShellCommand).toHaveBeenCalledTimes(1);
    });

  it("keeps a confirmed dispatch when a later step of the launch fails", async () => {
    // A runner whose launcher never writes its record: the seat needs attention, but the model was sent.
    const { app } = seat(`${OPTED}launch_result: true\nrunner: true\n`);
    const result = await app.launchHarness(binding("vendor/model"), { name: "w@r" });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", modelInput: { model: "vendor/model", dispatch: "confirmed" } });
  });

  it("accepts passes_model only as true or false", () => {
    const { dir } = seat(`${PRESET}passes_model: please\n`);
    expect(loadCommunityHarnessPreset("synth", dir)).toMatchObject({ ok: false, message: expect.stringContaining("passes_model must be true or false") });
  });
});
