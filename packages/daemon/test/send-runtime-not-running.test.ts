// #142 — a seat whose agent runtime failed shows a bare shell. Automatic wakes (and any send) must not be
// typed there, because the shell executes the text; the refusal must reach the watchdog as an honest failure.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { migrate } from "../src/db/migrate.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
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
    listPanes: async () => [{ id: "%1" }],
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
    const { node } = seat(runtime, "dev-impl@my-rig");
    const { tmux, sendText, sendKeys } = tmuxWithPane(async () => shell);
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-rig", tmuxPane: "%1" });
    tmux.getPanePid = async () => 1135;
    const listProcesses = async () => [{ pid: 1135, ppid: 1, pgid: 1135, tpgid: 1135,
      executableName: shell.replace(/^-/, ""), command: shell, startedAt: "Thu Oct 1 11:00:00 2026" }];
    const result = await watchdogSend(new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, listProcesses }), "dev-impl@my-rig");

    expect(result).toMatchObject({ ok: false, sent: false, reason: runtime === "claude-code" ? "target_runtime_not_running" : "target_runtime_unverified" });
    expect(result.error).toContain(runtime === "claude-code" ? "idle shell" : `${shell.replace(/^-/, "")} as the foreground command`);
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
    expect(await watchdogSend(transport, "dev-check@my-rig")).toMatchObject({ ok: false, sent: false, reason: "target_runtime_unverified" });
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
    expect(await watchdogSend(transport, "dev-check@my-rig")).toMatchObject({ ok: false, sent: false, reason: "target_runtime_unverified" });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // #197: reported pane -> managed sh -> native Claude. The OS metadata is
  // synthetic; argv follows the managed fresh/resume commands in the adapter.
  function claudeProcesses(identity = `--session-id ${nativeToken}`): NativeProcessRow[] {
    return wrapperProcesses().filter(row => row.pid !== 1199).map(row => row.pid === 1205
      ? { ...row, ppid: 1196, executableName: "claude",
        command: `/opt/bin/claude --permission-mode auto ${identity} --name dev-check@my-rig` } : row);
  }

  function wrappedClaude(listProcesses = vi.fn(async () => claudeProcesses())) {
    const { node, session } = seat("claude-code", "dev-check@my-rig");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-check@my-rig", tmuxPane: "%1" });
    sessionRegistry.updateResumeToken(session.id, "claude_id", nativeToken);
    const ports = tmuxWithPane(async () => "sh");
    ports.tmux.getPanePid = vi.fn(async () => 1135);
    return { ...ports, node, session, listProcesses,
      transport: new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: ports.tmux, listProcesses, sleep: async () => {} }) };
  }

  it.each(["fresh", "resume", "versioned process title", "queue nudge"])("#197 wrapped Claude receives %s", async kind => {
    const rows = claudeProcesses(kind === "resume" ? `--resume ${nativeToken}` : `--session-id ${nativeToken}`);
    if (kind === "versioned process title") rows.at(-1)!.command = rows.at(-1)!.command.replace("/opt/bin/claude", "claude (2.1.284)");
    const { transport, sendText, sendKeys, listProcesses } = wrappedClaude(vi.fn(async () => rows));
    const result = await transport.send("dev-check@my-rig", "existing review", {
      verify: true, ...(kind === "queue nudge" ? { actorSession: "dev-owner@my-rig", auditPointer: "existing-review", deliveryId: "nudge-claude" } : {}),
    });
    expect(result.ok).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendKeys).toHaveBeenCalledOnce();
    expect(listProcesses).toHaveBeenCalledTimes(2);
  });

  // #197 C1: Root observed macOS ucomm "claude.exe" with argv basename
  // "claude". A versioned argv fixture alone did not exercise this OS-name axis.
  it.each(["--session-id", "--resume"])("#197 accepts observed Claude OS name with %s", async identityFlag => {
    const rows = claudeProcesses().map(row => row.pid === 1205
      ? { ...row, executableName: "claude.exe",
        command: `/opt/runtime/bin/claude --permission-mode acceptEdits --model claude-opus-5-5 ${identityFlag} ${nativeToken} --name dev-check@my-rig` } : row);
    const { transport, sendText, sendKeys, listProcesses } = wrappedClaude(vi.fn(async () => rows));
    expect((await transport.send("dev-check@my-rig", "existing review")).ok).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendKeys).toHaveBeenCalledOnce();
    expect(listProcesses).toHaveBeenCalledTimes(2);
  });

  const unprovedClaude: [string, (rows: NativeProcessRow[]) => NativeProcessRow[]][] = [
    ...unproved,
    ["wrong Claude identity", rows => rows.map(r => r.pid === 1205 ? { ...r, command: "/opt/bin/claude --session-id other" } : r)],
    ["argv label without native executable", rows => rows.map(r => r.pid === 1205 ? { ...r, executableName: "echo" } : r)],
    ["ambiguous native children", rows => [...rows, { ...rows.at(-1)!, pid: 1206 }]],
    ["fork with only parent identity", () => claudeProcesses(`--resume ${nativeToken} --fork-session`)],
    ["conflicting identity arguments", () => claudeProcesses(`--resume other --session-id ${nativeToken}`)],
    ["identity flag only in name value", () => claudeProcesses(`--name --session-id ${nativeToken}`)],
  ];
  it.each(unprovedClaude)("#197 distinguishes missing evidence from a conflict: %s", async (label, mutate) => {
    const { transport, sendText, sendKeys } = wrappedClaude(vi.fn(async () => mutate(claudeProcesses())));
    const result = await transport.send("dev-check@my-rig", "existing review");
    const conflict = label === "ambiguous native children";
    expect(result.ok).toBe(!conflict);
    if (conflict) expect(result.reason).toBe("target_runtime_conflict");
    else expect(result.warning).toContain("without verified native identity");
    expect(sendText).toHaveBeenCalledTimes(conflict ? 0 : 1);
    expect(sendKeys).toHaveBeenCalledTimes(conflict ? 0 : 1);
  });

  it.each(["missing identity", "process disappears from observation", "changed bound pane", "process lookup failed"])("#197 handles %s honestly", async kind => {
    const { transport, session, tmux, listProcesses, sendText, sendKeys } = wrappedClaude();
    if (kind === "missing identity") sessionRegistry.clearResumeToken(session.id);
    if (kind === "process disappears from observation") listProcesses.mockResolvedValueOnce(claudeProcesses()).mockResolvedValueOnce(claudeProcesses().slice(0, -1));
    if (kind === "changed bound pane") tmux.getPanePid = async target => target === "%1" ? 999 : 1135;
    if (kind === "process lookup failed") listProcesses.mockRejectedValue(new Error("unavailable"));
    const result = await transport.send("dev-check@my-rig", "existing review");
    const conflict = kind === "changed bound pane";
    expect(result.ok).toBe(!conflict);
    if (conflict) expect(result.reason).toBe("target_runtime_conflict");
    else expect(result.warning).toContain("without verified native identity");
    expect(sendText).toHaveBeenCalledTimes(conflict ? 0 : 1);
    expect(sendKeys).toHaveBeenCalledTimes(conflict ? 0 : 1);
  });

  it("#197 still refuses native approval after proving the Claude wrapper", async () => {
    const { transport, tmux, sendText, sendKeys } = wrappedClaude();
    tmux.capturePaneContent = async () => "Would you like to run the following command?\n› 1. Yes, proceed (y)\n2. No\nPress enter to confirm or esc to cancel";
    expect(await transport.send("dev-check@my-rig", "existing review")).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it.each(["matching", "historical-token", "different-runtime"])("queue handoff records actual wrapper delivery (%s)", async identity => {
    migrate(db, [outboxEntriesSchema]);
    const { transport, sendText, sendKeys } = wrappedClaude(vi.fn(async () =>
      claudeProcesses(`--resume ${identity === "matching" ? nativeToken : "other"}`).map(row =>
        identity === "different-runtime" && row.pid === 1205
          ? { ...row, executableName: "codex", command: "codex resume other" } : row)));
    const repo = new QueueRepository(db, new EventBus(db), {
      transport, loadHumanRegistry: () => ({ ok: true, entities: [] }),
    });
    repo.attachOutbox(new OutboxHandler(db));
    const source = await repo.create({ sourceSession: "orch@my-rig", destinationSession: "dev-owner@my-rig", body: "review", nudge: false });
    const { created } = await repo.handoff({ qitemId: source.qitemId, fromSession: "dev-owner@my-rig", toSession: "dev-check@my-rig" });
    await vi.waitFor(() => expect(repo.getById(created.qitemId)!.lastNudgeAttempt).not.toBeNull());
    const stored = repo.getById(created.qitemId)!;
    expect(stored.lastNudgeAttempt).not.toBeNull();
    if (identity !== "different-runtime") {
      expect(stored.lastNudgeResult).toBe("delivered-ack-pending");
      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText).toHaveBeenCalledWith("dev-check@my-rig", expect.stringContaining(`Queue handoff: ${created.qitemId}`));
      expect(sendKeys).toHaveBeenCalledOnce();
    } else {
      expect(stored.lastNudgeResult).toContain("failed:");
      expect(stored.lastNudgeResult).toContain("different native runtime");
      expect(sendText).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    }
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
    const refusal = `Refused: '${SEAT}' reports zsh as the foreground command, but OpenRig could not verify its expected claude-code agent in the bound pane. The agent may still be running behind a wrapper. No text was sent.`;
    history.push({
      historyId: "h1", jobId: "job-1", evaluatedAt: new Date().toISOString(), outcome: "sent", skipReason: null,
      deliveryTargetSession: SEAT, deliveryStatus: "failed", deliveryMessage: "wake",
      evaluationNotes: { ...first.notes, deliveryReason: refusal },
    } as WatchdogHistoryEntry);

    const second = await makeParkedOwnerConsumerPolicy(deps()).evaluate(job);
    expect(second.action).toBe("skip");
    expect(JSON.stringify(second.notes)).toMatch(/already[-_]woken/);
    expect(transitions.some((t) => t.transitionNote?.startsWith(FAILED_PREFIX) && t.transitionNote.includes("could not verify"))).toBe(true);
    expect(nudges.some((n) => n.startsWith(NUDGE_FAIL_PREFIX) && n.includes("could not verify"))).toBe(true);
  });
});
