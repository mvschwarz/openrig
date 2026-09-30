// #142 — a seat whose agent runtime failed shows a bare shell. Automatic wakes (and any send) must not be
// typed there, because the shell executes the text; the refusal must reach the watchdog as an honest failure.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import {
  makeParkedOwnerConsumerPolicy,
  makeRigAnchor,
  FAILED_PREFIX,
  NUDGE_FAIL_PREFIX,
  PARKED_OWNER_POLICY_NAME,
  type ParkedOwnerConsumerDeps,
  type RowTransitionView,
} from "../src/domain/policies/parked-owner-consumer.js";
import type { PolicyJob } from "../src/domain/policies/types.js";
import type { WatchdogHistoryEntry } from "../src/domain/watchdog-history-log.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";

function tmuxWithPane(getPaneCommand: () => Promise<string | null>) {
  const sendText = vi.fn(async () => ({ ok: true as const }));
  const sendKeys = vi.fn(async () => ({ ok: true as const }));
  const tmux = {
    hasSession: async () => true,
    probeSession: async () => ({ state: "present" as const }),
    sendText,
    sendKeys,
    capturePaneContent: async () => "idle prompt\n❯ ",
    getPanePid: async () => null,
    getPaneCommand,
  } as unknown as TmuxAdapter;
  return { tmux, sendText, sendKeys };
}

describe("#142 transport refuses to type into a bare shell where an agent runtime should run", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });
  afterEach(() => db.close());

  function seat(runtime: string, name: string) {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, name.split("@")[0]!.replace("-", "."), { role: "worker", runtime });
    const session = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name });
    return { node, session };
  }

  // The watchdog's deliver() makes exactly this call (startup.ts parked-owner delivery).
  const watchdogSend = (transport: SessionTransport, name: string) =>
    transport.send(name, "[OpenRig watchdog scheduler · policy: parked-owner-consumer] You are parked", {
      deliveryId: "guard-watchdog-job-1", actorSession: "watchdog@system", auditPointer: "job-1",
    });

  it.each([["claude-code", "zsh"], ["codex", "-bash"]])("%s seat showing %s: refused, nothing typed", async (runtime, shell) => {
    seat(runtime, "dev-impl@my-rig");
    const { tmux, sendText, sendKeys } = tmuxWithPane(async () => shell);
    const result = await watchdogSend(new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux }), "dev-impl@my-rig");

    expect(result).toMatchObject({ ok: false, sent: false, reason: "target_runtime_not_running" });
    expect(result.error).toContain(`bare ${shell.replace(/^-/, "")} shell`);
    expect(result.error).toContain("No text was sent");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("sibling: a running agent runtime still receives the wake", async () => {
    seat("claude-code", "dev-impl@my-rig");
    const { tmux, sendText } = tmuxWithPane(async () => "claude");
    const result = await watchdogSend(new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux }), "dev-impl@my-rig");

    expect(result.ok).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
  });

  // 2026-09-29 guest: the ready checker still read as bash at the #142 guard.
  // Model its pane -> sh -> Node launcher -> native Codex chain. Process-group
  // and start-time values below are synthetic; native execution remains a separate check.
  const nativeToken = "01a0ef72-c681-7a21-abc6-c0bdd0a3bc98";
  function wrapperProcesses(): NativeProcessRow[] {
    const startedAt = "Tue Sep 29 23:33:00 2026";
    return [
      { pid: 1135, ppid: 1, pgid: 1135, tpgid: 1196, executableName: "zsh", command: "-zsh", startedAt },
      { pid: 1196, ppid: 1135, pgid: 1196, tpgid: 1196, executableName: "bash", command: "/bin/sh /tmp/launch.txt", startedAt },
      { pid: 1199, ppid: 1196, pgid: 1196, tpgid: 1196, executableName: "node", command: `node /opt/bin/codex resume ${nativeToken}`, startedAt },
      { pid: 1205, ppid: 1199, pgid: 1196, tpgid: 1196, executableName: "codex", command: `/opt/native/codex resume ${nativeToken}`, startedAt },
    ];
  }

  function wrappedSeat(listProcesses = vi.fn(async () => wrapperProcesses())) {
    const { node, session } = seat("codex", "dev-check@my-rig");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-check@my-rig", tmuxPane: "%1" });
    sessionRegistry.updateResumeToken(session.id, "codex", nativeToken);
    const ports = tmuxWithPane(async () => "bash");
    ports.tmux.getPanePid = vi.fn(async () => 1135);
    const deps = { db, rigRepo, sessionRegistry, tmuxAdapter: ports.tmux, listProcesses, sleep: async () => {} };
    return { ...ports, node, session, listProcesses, transport: new SessionTransport(deps) };
  }

  it.each(["ordinary verified send", "queue nudge", "watchdog wake"])("wrapped native Codex receives %s", async kind => {
    const { transport, sendText, sendKeys, listProcesses } = wrappedSeat();
    const result = kind === "watchdog wake"
      ? await watchdogSend(transport, "dev-check@my-rig")
      : await transport.send("dev-check@my-rig", "existing review", {
        verify: true, ...(kind === "queue nudge" ? { actorSession: "dev-owner@my-rig", auditPointer: "existing-review", deliveryId: "nudge-1" } : {}),
      });
    expect(result.ok).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendKeys).toHaveBeenCalledOnce();
    expect(listProcesses).toHaveBeenCalledTimes(2);
  });

  it("proven native wrapper still refuses an approval prompt", async () => {
    const { transport, tmux, sendText, sendKeys } = wrappedSeat();
    tmux.capturePaneContent = async () => "Would you like to run the following command?\n› 1. Yes, proceed (y)\n2. No\nPress enter to confirm or esc to cancel";
    expect(await transport.send("dev-check@my-rig", "existing review")).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("allows a fresh native wrapper without inventing a resume identity", async () => {
    const { transport, session, listProcesses, sendText } = wrappedSeat();
    sessionRegistry.clearResumeToken(session.id);
    listProcesses.mockResolvedValue(wrapperProcesses().map(r => r.pid === 1205
      ? { ...r, command: "/opt/native/codex -m model" } : r));
    expect((await watchdogSend(transport, "dev-check@my-rig")).ok).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
  });

  const unproved: [string, (rows: NativeProcessRow[]) => NativeProcessRow[]][] = [
    ["exited native with stale UI", rows => rows.slice(0, -1)],
    ["background native", rows => rows.map(r => r.pid === 1205 ? { ...r, pgid: 999 } : r)],
    ["another pane's native", rows => rows.map(r => r.pid === 1205 ? { ...r, ppid: 999 } : r)],
    ["wrong resume identity", rows => rows.map(r => r.pid === 1205 ? { ...r, command: "/opt/native/codex resume different" } : r)],
    ["incomplete process identity", rows => rows.map(r => ({ ...r, startedAt: undefined }))],
  ];
  it.each(unproved)("shell label still refuses %s without input", async (_name, mutate) => {
    const { transport, sendText, sendKeys } = wrappedSeat(vi.fn(async () => mutate(wrapperProcesses())));
    expect(await watchdogSend(transport, "dev-check@my-rig")).toMatchObject({ ok: false, sent: false, reason: "target_runtime_not_running" });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it.each(["missing binding", "wrong bound pane", "missing resume identity", "changed process", "unavailable processes"])("refuses %s behind the shell label", async kind => {
    const { transport, node, session, tmux, listProcesses, sendText, sendKeys } = wrappedSeat();
    if (kind === "missing binding") sessionRegistry.clearBinding(node.id);
    if (kind === "wrong bound pane") tmux.getPanePid = async target => target === "%1" ? 999 : 1135;
    if (kind === "missing resume identity") sessionRegistry.clearResumeToken(session.id);
    if (kind === "changed process") listProcesses.mockResolvedValueOnce(wrapperProcesses()).mockResolvedValueOnce(wrapperProcesses().slice(0, -1));
    if (kind === "unavailable processes") listProcesses.mockRejectedValue(new Error("process observation failed"));
    expect(await watchdogSend(transport, "dev-check@my-rig")).toMatchObject({ ok: false, sent: false, reason: "target_runtime_not_running" });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("negative: a terminal node's shell is its runtime, so it still receives text", async () => {
    seat("terminal", "ops-human@my-rig");
    const { tmux, sendText } = tmuxWithPane(async () => "zsh");
    const result = await watchdogSend(new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux }), "ops-human@my-rig");

    expect(result.ok).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
  });

  it.each([["unknown", async () => null], ["unreadable", async () => { throw new Error("tmux failed"); }]])(
    "an %s pane command stays advisory and still sends", async (_label, getPaneCommand) => {
      seat("claude-code", "dev-impl@my-rig");
      const { tmux, sendText } = tmuxWithPane(getPaneCommand as () => Promise<string | null>);
      const result = await watchdogSend(new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux }), "dev-impl@my-rig");

      expect(result.ok).toBe(true);
      expect(sendText).toHaveBeenCalledOnce();
    });
});

// #197 — a managed Claude launch wraps `claude` in /bin/sh, so the pane
// foreground reads as a bare shell while the runtime runs beneath it. The
// token-bound pane-descendant proof (findExactNativeResumeProcess, the same
// reconciler the identity path uses) clears the refusal; without a matching
// registered token the refusal stands.
describe("#197 managed Claude behind a shell wrapper still receives sends", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });
  afterEach(() => db.close());

  // The watchdog's deliver() makes exactly this call (startup.ts parked-owner delivery).
  const watchdogSend = (transport: SessionTransport, name: string) =>
    transport.send(name, "[OpenRig watchdog scheduler · policy: parked-owner-consumer] You are parked", {
      deliveryId: "guard-watchdog-job-1", actorSession: "watchdog@system", auditPointer: "job-1",
    });

  const claudeToken = "sess_9f2c41aa-7b3e-4d18-9c1e-55aa02f3c7d1";  function claudeWrapperProcesses(): NativeProcessRow[] {
    const startedAt = "Tue Sep 30 12:00:00 2026";
    return [
      { pid: 1135, ppid: 1, pgid: 1135, tpgid: 1196, executableName: "zsh", command: "-zsh", startedAt },
      { pid: 1196, ppid: 1135, pgid: 1196, tpgid: 1196, executableName: "sh", command: "/bin/sh /tmp/openrig-tmux-send-1-abc.txt", startedAt },
      { pid: 1205, ppid: 1196, pgid: 1196, tpgid: 1196, executableName: "claude", command: `claude --permission-mode auto --session-id ${claudeToken} --name orch-lead@my-rig`, startedAt },
    ];
  }

  function claudeWrappedSeat(listProcesses = vi.fn(async () => claudeWrapperProcesses())) {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "orch-lead@my-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "orch-lead@my-rig", tmuxPane: "%1" });
    sessionRegistry.updateResumeToken(session.id, "claude-code", claudeToken);
    const ports = tmuxWithPane(async () => "sh");
    ports.tmux.getPanePid = vi.fn(async () => 1135);
    const deps = { db, rigRepo, sessionRegistry, tmuxAdapter: ports.tmux, listProcesses, sleep: async () => {} };
    return { ...ports, session, listProcesses, transport: new SessionTransport(deps) };
  }

  it.each(["ordinary verified send", "queue nudge", "watchdog wake"])("wrapped native Claude receives %s", async kind => {
    const { transport, sendText, sendKeys } = claudeWrappedSeat();
    const result = kind === "watchdog wake"
      ? await watchdogSend(transport, "orch-lead@my-rig")
      : await transport.send("orch-lead@my-rig", "existing review", {
        verify: true, ...(kind === "queue nudge" ? { actorSession: "dev-owner@my-rig", auditPointer: "existing-review", deliveryId: "nudge-1" } : {}),
      });
    expect(result.ok).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendKeys).toHaveBeenCalledOnce();
  });

  it.each([
    ["wrong resume identity", rows => rows.map(r => r.pid === 1205 ? { ...r, command: "claude --permission-mode auto --session-id other" } : r)],
    ["exited native with stale UI", rows => rows.slice(0, -1)],
  ])("shell label still refuses Claude %s without input", async (_name, mutate) => {
    const { transport, sendText, sendKeys } = claudeWrappedSeat(vi.fn(async () => mutate(claudeWrapperProcesses())));
    expect(await watchdogSend(transport, "orch-lead@my-rig")).toMatchObject({ ok: false, sent: false, reason: "target_runtime_not_running" });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("refuses a managed Claude wrapper with no registered token", async () => {
    const { transport, session, sendText, sendKeys } = claudeWrappedSeat();
    sessionRegistry.clearResumeToken(session.id);
    expect(await watchdogSend(transport, "orch-lead@my-rig")).toMatchObject({ ok: false, sent: false, reason: "target_runtime_not_running" });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });
});

describe("#142 the parked-owner wake records the refusal honestly and does not retry into the shell", () => {
  const SEAT = "dev-impl@my-rig";
  const ROW = "qitem-owed-1";

  it("the refused delivery lands as a failure on the still-open row, and the episode sends no second wake", async () => {
    const transitions: RowTransitionView[] = [];
    const nudges: string[] = [];
    const history: WatchdogHistoryEntry[] = [];
    const deps = (): ParkedOwnerConsumerDeps => ({
      diagnoseRig: () => ({ seats: [{
        sessionName: SEAT,
        parked: true,
        activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null } },
        obligations: { items: [{ qitemId: ROW, state: "in-progress", summary: null }], held: [] },
      }] }),
      history: { listForJob: (_j, limit) => history.slice(0, limit), countForJob: () => history.length },
      rows: {
        listTransitions: () => [...transitions],
        appendNote: (_q, note) => { transitions.push({ ts: new Date().toISOString(), transitionNote: note }); return { ok: true }; },
        recordNudgeResult: (_q, result) => void nudges.push(result),
        listOpenIds: () => [ROW],
      },
    });
    const job = {
      jobId: "job-1", policy: PARKED_OWNER_POLICY_NAME, target: { session: makeRigAnchor("my-rig") },
      intervalSeconds: 120, context: {}, lastEvaluationAt: null, lastFireAt: null,
    } as unknown as PolicyJob;

    const first = await makeParkedOwnerConsumerPolicy(deps()).evaluate(job);
    expect(first.action).toBe("send");
    const refusal = `Refused: '${SEAT}' shows a bare zsh shell, so its claude-code runtime is not running. Text sent there would run as shell commands. Relaunch the seat first. No text was sent.`;
    history.push({
      historyId: "h1", jobId: "job-1", evaluatedAt: new Date().toISOString(), outcome: "sent", skipReason: null,
      deliveryTargetSession: SEAT, deliveryStatus: "failed", deliveryMessage: "wake",
      evaluationNotes: { ...first.notes, deliveryReason: refusal },
    } as WatchdogHistoryEntry);

    const second = await makeParkedOwnerConsumerPolicy(deps()).evaluate(job);
    expect(second.action).toBe("skip");
    expect(JSON.stringify(second.notes)).toMatch(/already[-_]woken/);
    expect(transitions.some((t) => t.transitionNote?.startsWith(FAILED_PREFIX) && t.transitionNote.includes("runtime is not running"))).toBe(true);
    expect(nudges.some((n) => n.startsWith(NUDGE_FAIL_PREFIX) && n.includes("runtime is not running"))).toBe(true);
  });
});
