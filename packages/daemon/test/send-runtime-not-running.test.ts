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
