import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { communityHarnessLabel, loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";
import { CommunityHarnessRuntimeAdapter } from "../src/adapters/community-harness-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

// A community harness whose launcher reports the conversation it created for each launch (`launch_result: true`).

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (name: string) => { const dir = mkdtempSync(join(tmpdir(), name)); dirs.push(dir); return dir; };
const PRESET = "format: 1\nname: synth\ncommand: synth-launch --serve\nmaintainer: Example Maintainer\nlimits: []\nlaunch_result: true\n";
const binding = { tmuxSession: "w@r" } as NodeBinding;

/** A seat whose launcher writes `record(attempt)` to the file this launch names (or nothing, for undefined). */
function seat(record?: (attempt: string, file: string) => unknown, preset = PRESET) {
  const presets = scratch("harness-presets-");
  writeFileSync(join(presets, "synth.yaml"), preset);
  const root = scratch("harness-results-");
  const sendShellCommand = vi.fn(async (_session: string, command: string) => {
    const file = /OPENRIG_LAUNCH_RESULT='([^']+)'/.exec(command)?.[1];
    const attempt = /OPENRIG_LAUNCH_ATTEMPT=(\S+)/.exec(command)?.[1];
    const doc = file && attempt ? record?.(attempt, file) : undefined;
    if (file && doc !== undefined) writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
    return { ok: true as const };
  });
  const app = new CommunityHarnessRuntimeAdapter("synth", { tmux: { hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "node"), sendShellCommand },
    presetsDir: () => presets, launchResultRoot: () => root, launchResultWait: { timeoutMs: 20, intervalMs: 10 } });
  return { app, sendShellCommand, presets, root };
}
const good = (attempt: string) => ({ format: 1, attempt, harness: "synth", nativeRef: "chat-123", producer: "synth-launch 1.0" });

describe("a community harness whose launcher reports its conversation", () => {
  it("launches with this attempt's result file, and the seat shows the conversation as reported by its launcher, not observed", async () => {
    const { app, sendShellCommand, presets } = seat(good);
    expect(await app.launchHarness(binding, { name: "w@r" }))
      .toEqual({ ok: true, resumeToken: "chat-123", resumeType: "community:synth", resumeProvenance: "launcher" });
    expect(sendShellCommand.mock.calls[0]![1]).toMatch(/^\/usr\/bin\/env OPENRIG_LAUNCH_RESULT='[^']+\.json' OPENRIG_LAUNCH_ATTEMPT=\S+ synth-launch --serve$/);
    expect(communityHarnessLabel("synth", presets, { resumeType: "community:synth", resumeToken: "chat-123" }))
      .toMatchObject({ identity: "reported by its launcher, not observed", reportedConversation: "chat-123" });
    expect(communityHarnessLabel("synth", presets)).toMatchObject({ identity: "not confirmed" });
  });

  it.each([
    ["nothing was written", undefined, "wasn't written"],
    ["it's another attempt's", (a: string) => ({ ...good(a), attempt: "an-older-attempt" }), "belongs to another launch attempt"],
    ["it names another harness", (a: string) => ({ ...good(a), harness: "other" }), `names harness "other"`],
    ["it isn't JSON", () => "not json", "isn't JSON"],
    ["its id has a space", (a: string) => ({ ...good(a), nativeRef: "chat 123" }), "has no usable nativeRef"],
    ["it names no producer", (a: string) => ({ ...good(a), producer: "" }), "doesn't name its producer"],
  ] as const)("still starts, with its identity unavailable and the reason named, when %s", async (_case, record, reason) => {
    const { app } = seat(record as never);
    const result = await app.launchHarness(binding, { name: "w@r" });
    expect(result).toEqual({ ok: true, warnings: [expect.stringContaining(reason)] });
    expect(result).toMatchObject({ warnings: [expect.stringContaining(`community harness "synth": its launch identity is unavailable`)] });
  });

  it("reads no record through a link, so one written elsewhere can't name the seat's conversation", async () => {
    const elsewhere = join(scratch("harness-elsewhere-"), "record.json");
    const { app } = seat((attempt, file) => { writeFileSync(elsewhere, JSON.stringify(good(attempt))); symlinkSync(elsewhere, file); return undefined; });
    expect(await app.launchHarness(binding, { name: "w@r" })).toEqual({ ok: true, warnings: [expect.stringContaining("isn't a plain file")] });
  });

  it("launches once without a record when its record folder can't be made: the identity is unavailable, the launch isn't refused", async () => {
    const blocked = join(scratch("harness-blocked-"), "a-file");
    writeFileSync(blocked, "not a folder");
    const presets = scratch("harness-presets-");
    writeFileSync(join(presets, "synth.yaml"), PRESET);
    const sendShellCommand = vi.fn(async () => ({ ok: true as const }));
    const app = new CommunityHarnessRuntimeAdapter("synth", { tmux: { hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "node"), sendShellCommand },
      presetsDir: () => presets, launchResultRoot: () => blocked });
    expect(await app.launchHarness(binding, { name: "w@r" }))
      .toEqual({ ok: true, warnings: [expect.stringContaining("its launch identity is unavailable: its launch-result folder couldn't be made")] });
    expect(sendShellCommand).toHaveBeenCalledTimes(1);
    expect(sendShellCommand.mock.calls[0]![1]).toBe("synth-launch --serve");
  });

  it("doesn't read a record larger than 64 KiB", async () => {
    const { app } = seat((a) => JSON.stringify({ ...good(a), padding: "x".repeat(70_000) }));
    expect(await app.launchHarness(binding, { name: "w@r" })).toEqual({ ok: true, warnings: [expect.stringContaining("is too large")] });
  });

  it("doesn't reopen a reported conversation for a launch-only harness: it says so and a new one starts", async () => {
    const { app, sendShellCommand } = seat(good);
    expect(await app.launchHarness(binding, { name: "w@r", resumeToken: "chat-123" })).toEqual({ ok: false, recovery: "retry_fresh",
      error: `Resume is unsupported: community harness "synth" is launch-only, so its reported conversation isn't reopened. A new conversation starts only where the caller allows a fresh start; a restore stops and asks.` });
    expect(sendShellCommand).not.toHaveBeenCalled();
  });

  it("accepts launch_result only as true or false", () => {
    const presets = scratch("harness-presets-");
    writeFileSync(join(presets, "synth.yaml"), PRESET.replace("launch_result: true", "launch_result: 1"));
    expect(loadCommunityHarnessPreset("synth", presets)).toMatchObject({ ok: false, message: expect.stringContaining("launch_result must be true or false") });
  });
});
