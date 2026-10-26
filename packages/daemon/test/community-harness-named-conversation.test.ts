import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { communityHarnessLabel, loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";
import { CommunityHarnessRuntimeAdapter } from "../src/adapters/community-harness-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

// A community harness that takes its conversation's name from OpenRig (`names_conversation: true`).

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const PRESET = "format: 1\nname: synth\ncommand: synth-launch\nmaintainer: Example Maintainer\nlimits: []\nnames_conversation: true\n";
const binding = { tmuxSession: "dev-impl@my-rig" } as NodeBinding;

function seat(preset = PRESET) {
  const presets = mkdtempSync(join(tmpdir(), "harness-presets-"));
  dirs.push(presets);
  writeFileSync(join(presets, "synth.yaml"), preset);
  const sendShellCommand = vi.fn(async () => ({ ok: true as const }));
  const app = new CommunityHarnessRuntimeAdapter("synth", { tmux: { hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "node"), sendShellCommand },
    presetsDir: () => presets });
  return { app, sendShellCommand, presets };
}
const typed = (send: ReturnType<typeof seat>["sendShellCommand"]) => (send.mock.calls[0] as unknown[])[1] as string;

describe("a community harness whose conversation OpenRig names", () => {
  it("names each new conversation, passes the name to the command, and shows it as named by OpenRig, not observed", async () => {
    const { app, sendShellCommand, presets } = seat();
    const first = await app.launchHarness(binding, { name: "dev-impl@my-rig" });
    expect(first).toMatchObject({ ok: true, resumeType: "community:synth", resumeProvenance: "passed", resumeToken: expect.stringMatching(/^openrig-dev-impl-my-rig-[0-9a-f]{8}$/) });
    const name = (first as { resumeToken: string }).resumeToken;
    expect(typed(sendShellCommand)).toBe(`/usr/bin/env OPENRIG_CONVERSATION='${name}' synth-launch`);
    // A second launch gets its own name, so two seats never share a conversation.
    expect(await app.launchHarness(binding, { name: "dev-impl@my-rig" })).not.toMatchObject({ resumeToken: name });
    expect(communityHarnessLabel("synth", presets, { resumeType: "community:synth", resumeToken: name, resumeProvenance: "passed" }))
      .toMatchObject({ identity: "named by OpenRig, not observed", namedConversation: name });
  });

  it("passes the saved name back on a resume, and never as a new conversation", async () => {
    const { app, sendShellCommand } = seat(`${PRESET}resume: true\n`);
    expect(await app.launchHarness(binding, { name: "dev-impl@my-rig", resumeToken: "openrig-dev-impl-1a2b3c4d", resumeType: "community:synth" }))
      .toEqual({ ok: true, resumeToken: "openrig-dev-impl-1a2b3c4d", resumeType: "community:synth", resumeProvenance: "passed" });
    expect(typed(sendShellCommand)).toBe("/usr/bin/env OPENRIG_RESUME_REF='openrig-dev-impl-1a2b3c4d' synth-launch");
  });

  it.each([
    ["the preset doesn't declare resume", PRESET, "community:synth", /launch-only, so its named conversation isn't reopened/],
    ["the saved conversation is a former runtime's", `${PRESET}resume: true\n`, "codex_id", /a "codex_id" id, not one community harness "synth"/],
  ])("starts nothing and says why when %s", async (_case, preset, resumeType, why) => {
    const { app, sendShellCommand } = seat(preset);
    expect(await app.launchHarness(binding, { name: "dev-impl@my-rig", resumeToken: "openrig-dev-impl-1a2b3c4d", resumeType }))
      .toMatchObject({ ok: false, recovery: "retry_fresh", error: expect.stringMatching(why) });
    expect(sendShellCommand).not.toHaveBeenCalled();
  });

  it("accepts names_conversation only as true or false, and not alongside launch_result", () => {
    const { presets } = seat("format: 1\nname: synth\ncommand: synth-launch\nmaintainer: Example Maintainer\nlimits: []\nnames_conversation: yes please\n");
    expect(loadCommunityHarnessPreset("synth", presets)).toMatchObject({ ok: false, message: expect.stringContaining("names_conversation must be true or false") });
    writeFileSync(join(presets, "synth.yaml"), `${PRESET}launch_result: true\n`);
    expect(loadCommunityHarnessPreset("synth", presets)).toMatchObject({ ok: false, message: expect.stringContaining("can't both be true") });
  });
});
