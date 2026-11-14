// The Codex resume command OpenRig shows a person for a seat (`rig ps --nodes` resumeCommand and the node detail's
// recovery guidance) carries the seat's own saved permission choice, as its managed resume does. A choice that can't be
// read shows no command: the label and guidance carry the same refusal the managed launch gives, with its repair step.
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeCodexSandbox, type AppliedLaunchObservation } from "../src/domain/permission-drift.js";
import { getNodeDetail, getNodeInventory } from "../src/domain/node-inventory.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { CodexMemberPermissions } from "../src/domain/codex-member-permissions.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// No real Codex, shell or tmux runs here.
const processMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execSync: vi.fn<() => string>(() => { throw new Error("Unexpected synchronous process execution"); }),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()), execFile: processMocks.execFile, execSync: processMocks.execSync,
}));

const workspace: CodexMemberPermissions = { sandbox: "workspace-write", approval: "on-request", network_access: true, writable_roots: ["/data"] };
const WORKSPACE_ARGS = " -s workspace-write -a on-request -c 'sandbox_workspace_write.writable_roots=[\"/data\"]'"
  + " -c 'sandbox_workspace_write.network_access=true' -c 'sandbox_workspace_write.exclude_tmpdir_env_var=false'"
  + " -c 'sandbox_workspace_write.exclude_slash_tmp=false'";
// The operational flag a managed Codex launch adds, which the shown command carries too.
const UPDATE_OFF = " '-c' 'check_for_update_on_startup=false'";
const CURRENT = "flags from current settings";

describe("the Codex resume command a person is shown carries the seat's own permission choice", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let sessionId: string;

  beforeEach(() => {
    db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-2", "test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-2", "rig-2", "dev", "Dev");
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id, agent_ref, profile, resolved_spec_name, resolved_spec_version, resolved_spec_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("node-codex", "rig-2", "dev.qa", "codex", "/workspace/app", "pod-2", "local:agents/qa", "default", "qa", "1.0.0", "hash");
    registry = new SessionRegistry(db);
    sessionId = registry.registerSession("node-codex", "dev-qa@test-rig").id;
  });
  afterEach(() => db.close());

  const choose = (stored: string) => db.prepare("UPDATE nodes SET codex_permissions_json = ? WHERE id = ?").run(stored, "node-codex");
  const shown = () => {
    const entry = getNodeInventory(db, "rig-2").find((e) => e.logicalId === "dev.qa")!;
    const detail = getNodeDetail(db, "rig-2", "dev.qa")!;
    return { entry, guidance: detail.recoveryGuidance! };
  };

  describe("with a stored conversation", () => {
    beforeEach(() => registry.updateResumeToken(sessionId, "codex_id", "sess-456", "hook"));

    it("a workspace-write choice replaces the default posture, in the command and the guidance", () => {
      choose(JSON.stringify(workspace));
      const { entry, guidance } = shown();
      expect(entry.resumeCommand).toBe(`codex${WORKSPACE_ARGS}${UPDATE_OFF} resume 'sess-456'`);
      expect(entry.resumeCommandLabel).toBe(CURRENT);
      expect(guidance.commands).toEqual([`codex${WORKSPACE_ARGS}${UPDATE_OFF} resume 'sess-456'`, "cd /workspace/app"]);
      expect(guidance.summary).toBe(`Try native Codex resume first (codex${WORKSPACE_ARGS}${UPDATE_OFF} resume 'sess-456').`);
    });

    it("a read-only choice keeps the seat's profile and a recorded --no-daemon", () => {
      choose(JSON.stringify({ sandbox: "read-only", approval: "never" }));
      db.prepare("UPDATE nodes SET codex_config_profile = ? WHERE id = ?").run("team", "node-codex");
      const generation = registry.currentOccupantTenure("node-codex")!.generationUuid;
      new AppliedLaunchObservationStore(db).recordGeneration(generation, { ...observeCodexSandbox("-s workspace-write"), daemonOptOut: true } as AppliedLaunchObservation);
      expect(shown().entry).toMatchObject({
        resumeCommand: `codex --no-daemon -p 'team' -s read-only -a never${UPDATE_OFF} resume 'sess-456'`,
        resumeCommandLabel: "launched with -s workspace-write (approval unrecorded); a resume now uses -s read-only -a never",
      });
    });

    it("prints the same permission arguments the seat's managed resume sends", async () => {
      choose(JSON.stringify(workspace));
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockShellCommand({
        sendText, hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "codex"),
        capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
        sendKeys: vi.fn(async () => ({ ok: true as const })), getPanePid: vi.fn(async () => null),
        listSessions: vi.fn(async () => []), listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []),
      } as unknown as TmuxAdapter);
      const adapter = new CodexResumeAdapter(tmux, { sleep: async () => {}, maxWaitMs: 0 });
      const result = await adapter.resume("dev-qa@test-rig", "codex_id", "sess-456", "/workspace/app", null, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, workspace);
      expect(result.ok).toBe(true);
      const managed = (sendText.mock.calls as unknown[][]).map((call) => String(call[1])).find((text) => text.includes(" resume "))!;
      expect(managed).toContain(`codex${WORKSPACE_ARGS}`);
      expect(shown().entry.resumeCommand).toBe(`codex${WORKSPACE_ARGS}${UPDATE_OFF} resume 'sess-456'`);
    });

    it("a choice that can't be read shows no command, and says why with the managed launch's own refusal", () => {
      choose(JSON.stringify({ sandbox: "danger-full-access", approval: "never" }));
      let refusal = "";
      try { new NativePermissionStore(db).launchOverride("node-codex", "codex"); } catch (err) { refusal = `Permission selection: ${(err as Error).message}`; }
      expect(refusal).not.toBe("");
      const { entry, guidance } = shown();
      expect(entry).toMatchObject({ resumeCommand: null, resumeCommandLabel: refusal });
      expect(guidance).toMatchObject({ summary: `Cannot derive Codex resume command — ${refusal}`, commands: [], notes: [refusal] });
    });

    it("a seat with no choice shows the command as before, with no note", () => {
      const { entry, guidance } = shown();
      expect(entry).toMatchObject({ resumeCommand: `codex -s workspace-write${UPDATE_OFF} resume 'sess-456'`, resumeCommandLabel: CURRENT });
      expect(guidance.notes).toContain(CURRENT);
    });
  });

  it("without a stored conversation, the picker command and the summary carry the choice", () => {
    choose(JSON.stringify(workspace));
    const { entry, guidance } = shown();
    expect(entry.resumeCommand).toBeNull();
    expect(guidance.commands).toEqual(["cd /workspace/app", `codex${WORKSPACE_ARGS}${UPDATE_OFF} resume --last`]);
    expect(guidance.summary).toBe(`No stored Codex resume token. Try codex${WORKSPACE_ARGS}${UPDATE_OFF} resume --last from the seat workspace.`);
  });
});
