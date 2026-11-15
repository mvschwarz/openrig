import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { communityHarnessLabel, loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";
import type { RunnerGrantIssuer } from "../src/domain/runner-grant-launch.js";
import { CommunityHarnessRuntimeAdapter } from "../src/adapters/community-harness-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

// A community harness whose launcher reports the conversation it created for each launch (`launch_result: true`).

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (name: string) => { const dir = mkdtempSync(join(tmpdir(), name)); dirs.push(dir); return dir; };
const PRESET = "format: 1\nname: synth\ncommand: synth-launch --serve\nmaintainer: Example Maintainer\nlimits: []\nlaunch_result: true\n";
const binding = { tmuxSession: "w@r" } as NodeBinding;

/** A seat whose launcher writes `record(attempt)` to the file this launch names (or nothing, for undefined). */
function seat(record?: (attempt: string, file: string) => unknown, preset = PRESET, runnerGrants?: RunnerGrantIssuer) {
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
    runnerGrants, presetsDir: () => presets, launchResultRoot: () => root, launchResultWait: { timeoutMs: 20, intervalMs: 10 } });
  return { app, sendShellCommand, presets, root };
}
const good = (attempt: string) => ({ format: 1, attempt, harness: "synth", nativeRef: "chat-123", producer: "synth-launch 1.0" });

describe("a community harness whose launcher reports its conversation", () => {
  it("launches with this attempt's result file, and the seat shows the conversation as reported by its launcher, not observed", async () => {
    const { app, sendShellCommand, presets } = seat(good);
    expect(await app.launchHarness(binding, { name: "w@r" }))
      .toEqual({ ok: true, resumeToken: "chat-123", resumeType: "community:synth", resumeProvenance: "launcher" });
    expect(sendShellCommand.mock.calls[0]![1]).toMatch(/^\/usr\/bin\/env OPENRIG_LAUNCH_RESULT='[^']+\.json' OPENRIG_LAUNCH_ATTEMPT=\S+ \/usr\/bin\/env -u OPENRIG_LAUNCH_WRAPPER synth-launch --serve$/);
    expect(communityHarnessLabel("synth", presets, { resumeType: "community:synth", resumeToken: "chat-123", resumeProvenance: "launcher" }))
      .toMatchObject({ identity: "reported by its launcher, not observed", reportedConversation: "chat-123" });
    expect(communityHarnessLabel("synth", presets, { resumeType: "community:synth", resumeToken: "chat-123", resumeProvenance: null }))
      .toMatchObject({ identity: "not confirmed" });
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
    expect(sendShellCommand.mock.calls[0]![1]).toBe("/usr/bin/env -u OPENRIG_LAUNCH_WRAPPER synth-launch --serve");
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

describe("a community harness whose launcher can reopen a reported conversation", () => {
  const RESUMABLE = `${PRESET}resume: true\n`;

  it("tells the launcher which conversation to reopen, and records it when the launcher reports it reopened", async () => {
    const { app, sendShellCommand } = seat(good, RESUMABLE);
    expect(await app.launchHarness(binding, { name: "w@r", resumeToken: "chat-123", resumeType: "community:synth" }))
      .toEqual({ ok: true, resumeToken: "chat-123", resumeType: "community:synth", resumeProvenance: "launcher" });
    expect(sendShellCommand.mock.calls[0]![1]).toContain(" OPENRIG_RESUME_REF='chat-123' /usr/bin/env -u OPENRIG_LAUNCH_WRAPPER synth-launch --serve");
  });

  it("starts nothing, and never a new conversation, when the launcher says the conversation is gone", async () => {
    const { app } = seat((attempt) => ({ format: 1, attempt, harness: "synth", error: "missing", producer: "synth-launch 1.0" }), RESUMABLE);
    const result = await app.launchHarness(binding, { name: "w@r", resumeToken: "chat-123", resumeType: "community:synth" });
    expect(result).toEqual({ ok: false, missingConversation: true,
      error: `Couldn't resume community harness "synth": conversation chat-123: ${result.ok ? "" : result.error.split("chat-123: ")[1]}` });
    expect(result).toMatchObject({ error: expect.stringContaining("says the conversation doesn't exist, and started nothing") });
    expect(result).not.toHaveProperty("recovery");
  });

  it.each([
    ["no record is written", undefined, { resumeUnproven: true }, "resuming conversation chat-123 isn't confirmed"],
    ["the launcher reports another conversation", (a: string) => ({ ...good(a), nativeRef: "chat-999" }), { resumeMismatch: { opened: "chat-999" } },
      "asked to resume conversation chat-123, its launcher reports conversation chat-999 instead"],
  ] as const)("needs the person's attention, and the seat keeps its conversation, when %s", async (_case, record, flag, error) => {
    const { app, sendShellCommand } = seat(record as never, RESUMABLE);
    const result = await app.launchHarness(binding, { name: "w@r", resumeToken: "chat-123", resumeType: "community:synth" });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", ...flag, error: expect.stringContaining(error) });
    expect(result).toMatchObject({ error: expect.stringContaining("The seat keeps conversation chat-123") });
    expect(result).not.toHaveProperty("resumeToken");
    expect(sendShellCommand).toHaveBeenCalledTimes(1);
    expect(sendShellCommand.mock.calls[0]![1]).toContain("OPENRIG_RESUME_REF='chat-123'");
    expect(sendShellCommand.mock.calls[0]![1]).not.toContain("OPENRIG_CONVERSATION=");
  });

  it("never hands another runtime's saved conversation to the launcher", async () => {
    const { app, sendShellCommand } = seat(good, RESUMABLE);
    expect(await app.launchHarness(binding, { name: "w@r", resumeToken: "codex-thread-1", resumeType: "codex_id" }))
      .toMatchObject({ ok: false, recovery: "retry_fresh", error: expect.stringContaining(`the saved conversation is a "codex_id" id`) });
    expect(sendShellCommand).not.toHaveBeenCalled();
  });

  it("starts nothing when a resume's record folder can't be made, since the launcher couldn't be told what to reopen", async () => {
    const blocked = join(scratch("harness-blocked-"), "a-file");
    writeFileSync(blocked, "not a folder");
    const presets = scratch("harness-presets-");
    writeFileSync(join(presets, "synth.yaml"), RESUMABLE);
    const sendShellCommand = vi.fn(async () => ({ ok: true as const }));
    const app = new CommunityHarnessRuntimeAdapter("synth", { tmux: { hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "node"), sendShellCommand },
      presetsDir: () => presets, launchResultRoot: () => blocked });
    expect(await app.launchHarness(binding, { name: "w@r", resumeToken: "chat-123", resumeType: "community:synth" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("its launch-result folder couldn't be made") });
    expect(sendShellCommand).not.toHaveBeenCalled();
  });

  it("needs launch_result or names_conversation for resume, so the conversation to reopen is one OpenRig knows", () => {
    const presets = scratch("harness-presets-");
    writeFileSync(join(presets, "synth.yaml"), `${PRESET.replace("launch_result: true\n", "")}resume: true\n`);
    expect(loadCommunityHarnessPreset("synth", presets)).toMatchObject({ ok: false, message: expect.stringContaining("resume needs launch_result: true or names_conversation: true") });
  });
});

describe("community run authority", () => {
  it.each([true, false])("binds the launch-result attempt and finalizes exact readiness=%s", async ready => {
    let runId: string | undefined;
    const dispatched = vi.fn(), finish = vi.fn(async (_ok: boolean) => {});
    const runnerGrants: RunnerGrantIssuer = async (_binding, runtime, attempt, runner) => {
      expect([runtime, runner]).toEqual(["synth", 1]); runId = attempt;
      return { grantId: "test-grant", generation: "generation", wrap: command => command, dispatched, finish };
    };
    const f = seat(ready ? (attempt) => { expect(attempt).toBe(runId); return good(attempt); } : undefined,
      `${PRESET}runner: true\n`, runnerGrants);
    expect((await f.app.launchHarness(binding, { name: "w@r" })).ok).toBe(ready);
    expect(runId).toBeTruthy();
    expect(dispatched).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(ready);
  });

  it("allocates and revokes an attempt when the launch-result folder is unavailable", async () => {
    const finish = vi.fn(async (_ok: boolean) => {});
    const issue = vi.fn(async (_binding, _runtime, _runId, _runner) => ({ grantId: "test-grant", generation: "generation", wrap: (command: string) => command, dispatched: () => {}, finish }));
    const f = seat(undefined, `${PRESET}runner: true\n`, issue);
    rmSync(f.root, { recursive: true });
    writeFileSync(f.root, "blocked");
    expect((await f.app.launchHarness(binding, { name: "w@r" })).ok).toBe(false);
    expect(issue.mock.calls[0]?.[2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(finish).toHaveBeenCalledWith(false);
  });
});

it("finalizes its exact community grant when post-dispatch standing refuses", async () => {
  const finish = vi.fn(async (_ok: boolean) => {});
  const f = seat(good, `${PRESET}runner: true\n`, async () => ({ grantId: "refused", generation: "generation", wrap: command => command,
    dispatched: () => { throw new Error("binding changed"); }, finish }));
  expect(await f.app.launchHarness(binding, { name: "w@r" })).toMatchObject({ ok: true, resumeToken: "chat-123" });
  expect(f.sendShellCommand).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledWith(false);
});


describe("community reporting grants are optional to native launch", () => {
  it("retries only its original command when the optional grant wrapper cannot be staged", async () => {
    const finish = vi.fn(async () => {}), dispatched = vi.fn();
    const issue: RunnerGrantIssuer = async () => ({ grantId: "own", generation: "g", wrap: command => `private-wrapper ${command}`, dispatched, finish });
    const f = seat(good, `${PRESET}runner: true\n`, issue);
    f.sendShellCommand.mockImplementationOnce(async () => ({ ok: false, code: "launch_path_too_long", message: "not dispatched" }) as never);
    expect(await f.app.launchHarness(binding, { name: "w@r" })).toMatchObject({ ok: true, resumeToken: "chat-123" });
    expect(f.sendShellCommand).toHaveBeenCalledTimes(2);
    expect(f.sendShellCommand.mock.calls[0]![1]).toBe(`private-wrapper ${f.sendShellCommand.mock.calls[1]![1]}`);
    expect(dispatched).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(false);
  });

  it.each(["setup", "activation"] as const)("preserves one dispatched native launch when grant %s fails", async failure => {
    const finish = vi.fn(async () => {});
    const issue: RunnerGrantIssuer = async () => {
      if (failure === "setup") throw new Error("credential environment unavailable");
      return { grantId: "affected", generation: "g", wrap: command => command,
        dispatched: () => { throw new Error("activation failed after send"); }, finish };
    };
    const f = seat(good, `${PRESET}runner: true\n`, issue);
    expect(await f.app.launchHarness(binding, { name: "w@r" })).toMatchObject({ ok: true, resumeToken: "chat-123" });
    expect(f.sendShellCommand).toHaveBeenCalledOnce();
    expect(f.sendShellCommand.mock.calls[0]![1]).not.toContain("OPENRIG_RUN_ID=");
    if (failure === "activation") expect(finish).toHaveBeenCalledWith(false);
  });
});
