import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAppRuntimeAdapter } from "../src/adapters/agent-app-runtime-adapter.js";
import { agentAppLabel, agentAppResumes } from "../src/domain/agent-app-presets.js";
import { ResumeMetadataRefresher, type ResumeRefreshSession } from "../src/domain/resume-metadata-refresher.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function presets(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-apps-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const LAUNCH_ONLY = "format: 1\nname: synth\ncommand: synth-app --serve\nmaintainer: Example Maintainer\n";
const RESUMES = "format: 2\nname: synth\ncommand: synth-app\nmaintainer: Example Maintainer\nsession:\n  id_pattern: '^ses_[A-Za-z0-9]{8,40}$'\n  resume: [synth-app, --session, '{session_id}']\n  exists: [synth-app, export, '{session_id}']\n  list: [synth-app, session, list, --format, json]\n";
const ID = "ses_abc12345";

function adapter(dir: string, sessionExists: (...args: unknown[]) => Promise<boolean | null> = async () => true) {
  const tmux = { hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "node"), sendShellCommand: vi.fn(async () => ({ ok: true as const })) };
  const exists = vi.fn(sessionExists);
  return { tmux, exists, app: new AgentAppRuntimeAdapter("synth", { tmux, presetsDir: () => dir, sessionExists: exists as never }) };
}
const binding = { tmuxSession: "w@r", cwd: "/work" } as NodeBinding;

describe("resuming an agent app that declares session continuity", () => {
  it("asks the app first, then types the resume argv, every element quoted, and reports the id it resumed", async () => {
    const { tmux, exists, app } = adapter(presets({ "synth.yaml": RESUMES }));
    expect(await app.launchHarness(binding, { name: "w@r", resumeToken: ID })).toEqual({ ok: true, resumeToken: ID, resumeType: "agent_app_session" });
    expect(exists).toHaveBeenCalledWith(expect.objectContaining({ exists: ["synth-app", "export", "{session_id}"] }), ID, "/work");
    expect(tmux.sendShellCommand).toHaveBeenCalledWith("w@r", `'synth-app' '--session' '${ID}'`, undefined, { stageIfLong: true, execInScript: true });
  });
  it("still launches fresh with the preset's command when there's no token", async () => {
    const { tmux, exists, app } = adapter(presets({ "synth.yaml": RESUMES }));
    expect(await app.launchHarness(binding, { name: "w@r" })).toEqual({ ok: true });
    expect(tmux.sendShellCommand).toHaveBeenCalledWith("w@r", "synth-app", undefined, { stageIfLong: true, execInScript: true });
    expect(exists).not.toHaveBeenCalled();
  });
  it("stops with a missing conversation, typing nothing, when the app says the id is gone", async () => {
    const { tmux, app } = adapter(presets({ "synth.yaml": RESUMES }), async () => false);
    expect(await app.launchHarness(binding, { name: "w@r", resumeToken: ID })).toEqual({ ok: false,
      error: `agent app "synth" reports that the saved conversation no longer exists`, recovery: "retry_fresh", missingConversation: true });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });
  it("goes ahead when the app can't say (no exists command, timeout, odd exit code)", async () => {
    const { tmux, app } = adapter(presets({ "synth.yaml": RESUMES }), async () => null);
    expect(await app.launchHarness(binding, { name: "w@r", resumeToken: ID })).toMatchObject({ ok: true, resumeToken: ID });
    expect(tmux.sendShellCommand).toHaveBeenCalledOnce();
  });
  it("refuses an id that fails the checks without echoing it or typing anything", async () => {
    const { tmux, exists, app } = adapter(presets({ "synth.yaml": RESUMES }));
    const result = await app.launchHarness(binding, { name: "w@r", resumeToken: "ses_x'; rm -rf ~" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`Resume refused for agent app "synth"`) });
    expect(!result.ok && result.error).not.toContain("rm -rf");
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });
  it("refuses fork, saying the app declares resume but not fork", async () => {
    const { tmux, app } = adapter(presets({ "synth.yaml": RESUMES }));
    expect(await app.launchHarness(binding, { name: "w@r", forkSource: { kind: "native_id", value: ID } }))
      .toEqual({ ok: false, error: `Fork is unsupported: agent app "synth" declares resume but not fork. Remove session_source for this member.` });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });
  it("keeps a launch-only preset launch-only", async () => {
    const { tmux, app } = adapter(presets({ "synth.yaml": LAUNCH_ONLY }));
    expect(await app.launchHarness(binding, { name: "w@r", resumeToken: ID }))
      .toEqual({ ok: false, error: `Resume is unsupported: agent app "synth" is launch-only. No session was started.` });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });
  it("says which presets resume", () => {
    expect(agentAppResumes("synth", presets({ "synth.yaml": RESUMES }))).toBe(true);
    expect(agentAppResumes("synth", presets({ "synth.yaml": LAUNCH_ONLY }))).toBe(false);
    expect(agentAppResumes("synth", presets({}))).toBe(false);
  });
  it("labels the seat with whether its preset declares resume", () => {
    expect(agentAppLabel("synth", presets({ "synth.yaml": RESUMES })).resume).toBe("declared");
    expect(agentAppLabel("synth", presets({ "synth.yaml": LAUNCH_ONLY })).resume).toBe("not declared");
    expect(agentAppLabel("synth", presets({})).resume).toBe("not declared");
  });
});

describe("filling an agent-app seat's token at snapshot time", () => {
  function refresher(capture: (s: ResumeRefreshSession, held: ReadonlySet<string>) => Promise<string | null>) {
    const registry = { updateResumeToken: vi.fn(() => true), agentAppSessionIdsHeldByOthers: vi.fn(() => new Set(["ses_held0000"])) };
    const r = new ResumeMetadataRefresher({ sessionRegistry: registry as unknown as SessionRegistry, tmuxAdapter: {} as TmuxAdapter, captureAgentAppSession: vi.fn(capture) });
    return { registry, r };
  }
  const seat: ResumeRefreshSession = { sessionId: "s1", sessionName: "w@r", runtime: "synth", agentApp: "synth", resumeType: null, resumeToken: null, cwd: "/work", createdAt: "2026-10-18 17:00:00" };

  it("records the one session the app reports for the seat, with ids other seats hold passed in", async () => {
    const capture = vi.fn(async () => ID);
    const { registry, r } = refresher(capture);
    await r.refresh([seat], { fillNullOnly: true });
    expect(capture).toHaveBeenCalledWith(seat, new Set(["ses_held0000"]));
    expect(registry.updateResumeToken).toHaveBeenCalledWith("s1", "agent_app_session", ID, "scrape");
  });
  it("never replaces a present token, and records nothing when the app gives no single answer", async () => {
    const capture = vi.fn(async () => null);
    const { registry, r } = refresher(capture);
    await r.refresh([{ ...seat, resumeToken: "ses_present00", resumeType: "agent_app_session" }, seat]);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(registry.updateResumeToken).not.toHaveBeenCalled();
  });
  it("leaves a free-text seat whose runtime merely names an app alone", async () => {
    const capture = vi.fn(async () => ID);
    const { registry, r } = refresher(capture);
    await r.refresh([{ ...seat, agentApp: null }], { fillNullOnly: true });
    expect(capture).not.toHaveBeenCalled();
    expect(registry.updateResumeToken).not.toHaveBeenCalled();
  });
});
