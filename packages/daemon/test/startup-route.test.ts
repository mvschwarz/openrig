import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { startupRevision } from "../src/routes/startup.js";
import { defaultProbeRuntimes } from "../src/domain/kernel-boot.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { existsSync, readFileSync } from "node:fs";
import { verifyCodexPaneProcess, verifyPaneIdleShell } from "../src/domain/native-process-lineage.js";
vi.mock("../src/domain/native-process-lineage.js", async (original) => {
  const actual = await original<typeof import("../src/domain/native-process-lineage.js")>();
  return { ...actual, verifyCodexPaneProcess: vi.fn(actual.verifyCodexPaneProcess), verifyPaneIdleShell: vi.fn(actual.verifyPaneIdleShell) };
});
vi.mock("../src/domain/kernel-boot.js", async (original) => ({ ...await original<typeof import("../src/domain/kernel-boot.js")>(), defaultProbeRuntimes: vi.fn(async () => ({ codex: "ok", claudeCode: "ok" })) }));

describe("startup consent and effect boundary", () => {
  let db: ReturnType<typeof createFullTestDb>;
  let setup: ReturnType<typeof createTestApp>;
  beforeEach(() => { db = createFullTestDb(); setup = createTestApp(db); vi.mocked(defaultProbeRuntimes).mockResolvedValue({ codex: "ok", claudeCode: "ok" }); });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });
  function seat() {
    const rig = setup.rigRepo.createRig("selected");
    const node = setup.rigRepo.addNode(rig.id, "operator.agent", { runtime: "codex", model: "configured-model" });
    const session = setup.sessionRegistry.registerSession(node.id, "operator-agent@selected");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: "%1" });
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
    return { rig, node, session };
  }
  function post(rigId: string, revision: string, action = "fresh") {
    return setup.app.request(`/api/startup/${rigId}/operator.agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, revision }) });
  }
  it("prepares the installed kernel definition once without launching any occupant", async () => {
    setup = createTestApp(db, { podInstantiatorFsOps: { exists: existsSync, readFile: (path) => readFileSync(path, "utf8") } });
    const request = () => setup.app.request("/api/startup/kernel", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime: "codex" }) });
    const first = await request();
    const body = await first.json();
    expect(body).toMatchObject({ ok: true, rigId: expect.any(String) });
    expect(first.status).toBe(200);
    expect(setup.rigRepo.getRig(body.rigId)!.nodes.map((node) => node.logicalId).sort())
      .toEqual(["advisor.lead", "operator.agent", "operator.human", "queue.worker"]);
    expect(setup.sessionRegistry.getSessionsForRig(body.rigId)).toEqual([]);
    expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
    const second = await request();
    expect(await second.json()).toMatchObject({ ok: true, rigId: body.rigId, reused: true });
  });
  it("rejects a changed occupant or model before invoking fresh launch", async () => {
    const { rig, node } = seat(); const revision = startupRevision(db, node);
    db.prepare("UPDATE nodes SET model = ? WHERE id = ?").run("changed-model", node.id);
    const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
    const response = await post(rig.id, revision);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "selection_changed" });
    expect(launch).not.toHaveBeenCalled();
  });
  it("does not replace an unprobeable pane", async () => {
    const { rig, node } = seat();
    vi.mocked(setup.tmuxAdapter.probeSession).mockRejectedValue(new Error("tmux unavailable"));
    const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
    const response = await post(rig.id, startupRevision(db, node));
    expect(await response.json()).toMatchObject({ ok: false, code: "unverified" });
    expect(launch).not.toHaveBeenCalled();
  });
  it("checks provider prerequisite before fresh and keeps stored model/history", async () => {
    const { rig, node, session } = seat();
    vi.mocked(defaultProbeRuntimes).mockResolvedValue({ codex: "unavailable", claudeCode: "ok" });
    const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
    const response = await post(rig.id, startupRevision(db, node));
    expect(await response.json()).toMatchObject({ code: "provider_prerequisite", freshAllowed: false });
    expect(launch).not.toHaveBeenCalled();
    expect(setup.rigRepo.getRig(rig.id)!.nodes[0]!.model).toBe("configured-model");
    expect(setup.sessionRegistry.getSessionsForRig(rig.id).map((s) => s.id)).toEqual([session.id]);
    const readback = await setup.app.request(`/api/startup/${rig.id}`);
    expect((await readback.json()).seats[0]).toMatchObject({ freshAllowed: false, prerequisite: expect.stringContaining("unauthenticated") });
  });
  describe("a seat whose pane command reads as a shell", () => {
    function shellPane(runtime: "claude-code" | "codex", proven: boolean) {
      const { rig, node } = seat();
      db.prepare("UPDATE nodes SET runtime = ? WHERE id = ?").run(runtime, node.id);
      vi.mocked(setup.tmuxAdapter.probeSession).mockResolvedValue({ state: "present" } as never);
      setup.tmuxAdapter.listPanes = vi.fn(async () => [{ id: "%1", index: 0, cwd: "/p", width: 80, height: 24, active: true }]) as never;
      setup.tmuxAdapter.getPaneCommand = vi.fn(async () => "sh");
      setup.tmuxAdapter.capturePaneContent = vi.fn(async () => "booting wrapper...");
      vi.mocked(verifyPaneIdleShell).mockResolvedValue(proven);
      return rig;
    }
    async function observed(rigId: string) {
      const response = await setup.app.request(`/api/startup/${rigId}`);
      return (await response.json()).seats[0].observed as { state: string; detail: string };
    }
    it("does not call a Claude pane a returned shell when no idle shell is proven", async () => {
      const seen = await observed(shellPane("claude-code", false).id);
      expect(seen.state).toBe("attention_required");
      expect(seen.detail).toBe("The pane shows a shell that is not a proven idle shell; a launch script may still be starting Claude.");
    });
    it("keeps the returned-to-shell wording when the idle shell is proven", async () => {
      const seen = await observed(shellPane("claude-code", true).id);
      expect(seen).toMatchObject({ state: "attention_required", detail: "The probe pane returned to a shell instead of staying inside the runtime." });
    });
  });
  it("re-probes a Codex status footer after the foreground process is verified", async () => {
    setup = createTestApp(db, {
      appDeps: {
        listProcesses: async () => [
          { pid: 900, ppid: 1, command: "/bin/zsh", pgid: 900, tpgid: 901, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
          { pid: 901, ppid: 900, command: "codex --model anthropic/claude-3.5-sonnet",
            argv: ["codex", "--model", "anthropic/claude-3.5-sonnet"], pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:01 2000" },
        ],
      },
    });
    const { rig, node } = seat();
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "present" } as never));
    setup.tmuxAdapter.listPanes = vi.fn(async () => [{ id: "%1", index: 0, cwd: "/p", width: 80, height: 24, active: true }]) as never;
    setup.tmuxAdapter.getPaneCommand = vi.fn(async () => "zsh");
    setup.tmuxAdapter.getPanePid = vi.fn(async () => 900);
    let captures = 0;
    setup.tmuxAdapter.capturePaneContent = vi.fn(async () => {
      captures++;
      if (captures === 1) return "  project2 · main\n› codex resume 019a136b-0000-7000-8000-000000000001";
      return [
        "› ",
        "  Ready · Context 13% used · anthropic/claude-3.5-sonnet         ⚠ 2 warnings · f2 to view",
      ].join("\n");
    });

    const response = await setup.app.request(`/api/startup/${rig.id}`);
    expect((await response.json()).seats[0].observed).toMatchObject({ state: "running" });
    expect(captures).toBe(2);
  });
  it("reports unavailable transport without authorizing fresh replacement", async () => {
    const { rig, node } = seat();
    vi.mocked(setup.tmuxAdapter.probeSession).mockResolvedValue({ state: "transport_unavailable", cause: "no server" });
    const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
    const response = await post(rig.id, startupRevision(db, node));
    expect(await response.json()).toMatchObject({ ok: false, code: "transport_unavailable" });
    expect(launch).not.toHaveBeenCalled();
  });
  it("serializes repeated fresh requests and passes exact scope to the existing lifecycle", async () => {
    const { rig, node } = seat(); const revision = startupRevision(db, node);
    let finish!: (value: never) => void;
    const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = post(rig.id, revision);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    const second = await post(rig.id, revision);
    expect(await second.json()).toMatchObject({ code: "operation_in_progress" });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ seatRef: "operator-agent@selected", fresh: true, stop: false, reason: expect.stringContaining(revision) }));
    finish({ ok: false, code: "startup_context_missing", message: "fixture refuses launch" } as never);
    await first;
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
