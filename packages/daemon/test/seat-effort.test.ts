// OPR.0.7.0.7 — one seat's effort four ways: requested, saved, emitted at launch, observed natively.
// The shared resolver every managed continuation reads, the restore/refresh precedence seam (latest
// wins), and the report that keeps the four values apart.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import {
  LATEST_WINS_EFFORT_PRECEDENCE, UNDECIDED_EFFORT_PRECEDENCE, effortPrecedence, emittedEffortFromArgv, readNativeEffort, readSeatEffort, resolveSeatEffort,
} from "../src/domain/seat-effort.js";

const LSTART = "Tue Oct 13 05:49:17 2026";
// ps prints lstart in local time; the reader parses it the same way.
const STARTED_MS = Date.parse("Oct 13, 2026 05:49:17");
const at = (offsetSeconds: number) => new Date(STARTED_MS + offsetSeconds * 1000).toISOString();

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seat-effort-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, lines: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

describe("resolveSeatEffort: the one resolver for managed continuations", () => {
  it("prefers the seat's choice, then the authored value, then no flag", () => {
    expect(resolveSeatEffort({ effort: "medium", effortChoice: "high" })).toEqual({ choice: "high", authored: "medium", effective: "high", source: "seat_choice" });
    expect(resolveSeatEffort({ effort: "medium", effortChoice: null })).toEqual({ choice: null, authored: "medium", effective: "medium", source: "authored" });
    expect(resolveSeatEffort({ effort: " ", effortChoice: "" })).toEqual({ choice: null, authored: null, effective: null, source: "runtime_default" });
  });

  it("reads a node row, and an older database without the choice column from nodes.effort alone", () => {
    const db = createFullTestDb();
    const repo = new RigRepository(db);
    const node = repo.addNode(repo.createRig("r").id, "dev.a", { runtime: "codex", effort: "low" });
    repo.setNodeEffortChoice(node.id, "high");
    expect(readSeatEffort(db, node.id)).toMatchObject({ effective: "high", source: "seat_choice" });
    expect(readSeatEffort(db, "missing")).toBeNull();
    db.exec("ALTER TABLE nodes DROP COLUMN effort_choice");
    expect(readSeatEffort(db, node.id)).toMatchObject({ effective: "low", source: "authored" });
    db.close();
  });
});

describe("emittedEffortFromArgv: what the launch command line sent", () => {
  it("reads Claude's --effort in both spellings, and its absence", () => {
    expect(emittedEffortFromArgv("claude-code", ["claude", "--permission-mode", "auto", "--effort", "high", "--resume", "x"])).toEqual({ flag: "present", value: "high" });
    expect(emittedEffortFromArgv("claude-code", ["claude", "--effort=low"])).toEqual({ flag: "present", value: "low" });
    expect(emittedEffortFromArgv("claude-code", ["claude", "--resume", "x"])).toEqual({ flag: "none" });
  });

  it("reads Codex's model_reasoning_effort override, quoted or not, and ignores other overrides", () => {
    expect(emittedEffortFromArgv("codex", ["codex", "-m", "gpt-5.5", "-c", 'model_reasoning_effort="high"', "resume", "t"])).toEqual({ flag: "present", value: "high" });
    expect(emittedEffortFromArgv("codex", ["codex", "--config=model_reasoning_effort=minimal"])).toEqual({ flag: "present", value: "minimal" });
    expect(emittedEffortFromArgv("codex", ["codex", "-c", "sandbox_workspace_write.network_access=true", "resume", "t"])).toEqual({ flag: "none" });
  });
});

describe("readNativeEffort: what the native session recorded since this process started", () => {
  it("reads Claude's latest assistant turn, and Codex's latest turn_context", () => {
    const claude = file("claude.jsonl", [
      { type: "user", timestamp: at(2) },
      { type: "assistant", timestamp: at(3), effort: "high" },
      { type: "user", timestamp: at(5) },
    ]);
    expect(readNativeEffort("claude-code", claude, LSTART)).toMatchObject({ state: "observed", value: "high", at: at(3), outcome: "recorded" });
    const codex = file("rollout.jsonl", [
      { type: "session_meta", timestamp: at(-100), payload: { id: "t" } },
      { type: "turn_context", timestamp: at(4), payload: { turn_id: "t1", model: "gpt-5.5", effort: "medium" } },
      { type: "event_msg", timestamp: at(6), payload: { type: "token_count" } },
    ]);
    expect(readNativeEffort("codex", codex, LSTART)).toMatchObject({ state: "observed", value: "medium", source: "Codex rollout (latest turn_context)", outcome: "pending" });
    const done = file("done.jsonl", [
      { type: "turn_context", timestamp: at(4), payload: { turn_id: "t1", effort: "high" } },
      { type: "event_msg", timestamp: at(9), payload: { type: "task_complete", turn_id: "t1", last_agent_message: "ok" } },
    ]);
    expect(readNativeEffort("codex", done, LSTART)).toMatchObject({ value: "high", outcome: "accepted" });
  });

  it("calls only a request rejection naming the level REJECTED; other errored turns failed before it could be judged", () => {
    // Real rollout shape: task_complete.error = { codex_error_info, message }.
    const kinds: Array<[unknown, string, string]> = [
      ["usage_limit_exceeded", "You've hit your usage limit. Try again later.", "usage limit"],
      ["unauthorized", "Your access token could not be refreshed.", "unauthorized"],
      ["other", "stream disconnected before completion", "other"],
      [{ usage_limit_exceeded: { resets_in_seconds: 60 } }, "usage limit", "usage limit"],
      // A 400 naming a different value is not this level's rejection.
      ["other", "Invalid value: 'turbo'. Supported values are: 'low', 'high'.", "other"],
    ];
    for (const [info, message, kind] of kinds) {
      const path = file(`failed-${kind}-${Math.random()}.jsonl`, [
        { type: "turn_context", timestamp: at(4), payload: { turn_id: "t3", effort: "high" } },
        { type: "event_msg", timestamp: at(6), payload: { type: "task_complete", turn_id: "t3", last_agent_message: null, error: { codex_error_info: info, message } } },
      ]);
      const observed = readNativeEffort("codex", path, LSTART);
      expect(observed, message).toMatchObject({ state: "observed", value: "high", outcome: "failed" });
      expect((observed as { detail: string }).detail).toBe(`The turn failed (${kind}) before this level could be judged.`);
    }
  });

  it("reads an interrupted turn (turn_aborted for that turn id) as interrupted, not pending forever", () => {
    const aborted = file("aborted.jsonl", [
      { type: "turn_context", timestamp: at(4), payload: { turn_id: "t4", effort: "high" } },
      { type: "event_msg", timestamp: at(5), payload: { type: "turn_aborted", turn_id: "other-turn", reason: "interrupted" } },
      { type: "event_msg", timestamp: at(6), payload: { type: "turn_aborted", turn_id: "t4", reason: "interrupted" } },
    ]);
    expect(readNativeEffort("codex", aborted, LSTART)).toMatchObject({ value: "high", outcome: "interrupted" });
  });

  it("names a level the service rejected as rejected, never as the level in effect (measured on Codex 0.153.4)", () => {
    const rejected = file("rejected.jsonl", [
      { type: "turn_context", timestamp: at(4), payload: { turn_id: "t2", effort: "turbo" } },
      { type: "event_msg", timestamp: at(6), payload: { type: "task_complete", turn_id: "t2", last_agent_message: null,
        error: { codex_error_info: "other", message: "Invalid response.create payload: Invalid value: 'turbo'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'." } } },
    ]);
    const observed = readNativeEffort("codex", rejected, LSTART);
    expect(observed).toMatchObject({ state: "observed", value: "turbo", outcome: "rejected" });
    expect((observed as { detail: string }).detail).toContain("Invalid value: 'turbo'");
  });

  it("never reports a turn from before this launch: the same conversation's earlier effort is NOT VERIFIED", () => {
    const resumed = file("resumed.jsonl", [{ type: "assistant", timestamp: at(-60), effort: "low" }]);
    expect(readNativeEffort("claude-code", resumed, LSTART)).toMatchObject({ state: "not_verified" });
    expect(readNativeEffort("claude-code", join(dir, "absent.jsonl"), LSTART)).toMatchObject({ state: "not_verified" });
    expect(readNativeEffort("claude-code", null, LSTART)).toMatchObject({ state: "not_verified" });
    expect(readNativeEffort("claude-code", resumed, null)).toMatchObject({ state: "not_verified" });
  });
});

describe("Effort precedence: the decided rule, latest wins (OPR.0.7.0.7)", () => {
  it("is the rule in force, and it is decided", () => {
    expect(effortPrecedence).toBe(LATEST_WINS_EFFORT_PRECEDENCE);
    expect(LATEST_WINS_EFFORT_PRECEDENCE.decided).toBe(true);
    expect(LATEST_WINS_EFFORT_PRECEDENCE.detail).toContain("No restore option picks older settings");
  });

  it("a restore launches the seat's saved choice, and says so when the snapshot held another value", () => {
    const live = resolveSeatEffort({ effort: "medium", effortChoice: "high" });
    const differs = LATEST_WINS_EFFORT_PRECEDENCE.restoreLaunchEffort({ snapshot: { effort: "medium" }, live });
    expect(differs.effort).toBe("high");
    expect(differs.warning).toContain("launched the seat's saved choice high, not medium from the snapshot");
    expect(LATEST_WINS_EFFORT_PRECEDENCE.restoreLaunchEffort({ snapshot: { effort: "medium", effortChoice: "low" }, live }).warning)
      .toContain("not low from the snapshot");
    expect(LATEST_WINS_EFFORT_PRECEDENCE.restoreLaunchEffort({ snapshot: { effort: "medium", effortChoice: "high" }, live })).toEqual({ effort: "high" });
    expect(LATEST_WINS_EFFORT_PRECEDENCE.restoreLaunchEffort({ snapshot: {}, live }).warning).toContain("not the snapshot's runtime default");
  });

  it("without a saved choice (never set, or cleared) a restore launches the snapshot's authored effort: an older choice never comes back", () => {
    const cleared = resolveSeatEffort({ effort: "medium" });
    expect(LATEST_WINS_EFFORT_PRECEDENCE.restoreLaunchEffort({ snapshot: { effort: "low", effortChoice: "high" }, live: cleared })).toEqual({ effort: "low" });
    expect(LATEST_WINS_EFFORT_PRECEDENCE.restoreLaunchEffort({ snapshot: {}, live: cleared })).toEqual({ effort: null });
  });

  it("with the seat's node row gone, the latest explicit choice known is the snapshot's", () => {
    expect(LATEST_WINS_EFFORT_PRECEDENCE.restoreLaunchEffort({ snapshot: { effort: "low", effortChoice: "high" }, live: null })).toEqual({ effort: "high" });
    expect(LATEST_WINS_EFFORT_PRECEDENCE.restoreLaunchEffort({ snapshot: { effort: "low" }, live: null })).toEqual({ effort: "low" });
  });

  it("a spec refresh keeps the saved choice", () => {
    expect(LATEST_WINS_EFFORT_PRECEDENCE.specRefreshChoice({ choice: "high", authoredBefore: "medium", authoredAfter: "low" })).toBe("keep");
  });

  it("the undecided placeholder is kept only for comparison, and isn't in force", () => {
    expect(UNDECIDED_EFFORT_PRECEDENCE.decided).toBe(false);
    expect(effortPrecedence).not.toBe(UNDECIDED_EFFORT_PRECEDENCE);
  });
});

describe("SeatLifecycleService.effortReport: four values, each from its own source", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let service: SeatLifecycleService;
  let rows: NativeProcessRow[];
  let transcript: string | null;
  let sidecarSession: string | null;
  let logsThread: string | undefined;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    rows = [];
    transcript = null;
    sidecarSession = null;
    logsThread = undefined;
    const tmux = { getPanePid: async () => 100 } as unknown as TmuxAdapter;
    service = new SeatLifecycleService({
      db, rigRepo, sessionRegistry, eventBus: new EventBus(db), tmuxAdapter: tmux, listProcesses: () => rows,
      transcripts: {
        readSidecar: () => (transcript ? { ok: true as const, data: { transcript_path: transcript, session_id: sidecarSession } } : { ok: false as const }),
        readCodexTranscriptPath: () => transcript,
      },
      inPlaceRestartIo: {
        readProcess: async () => ({ cwd: "/w", exe: "/usr/local/bin/codex", env: { CODEX_HOME: "/scratch/.codex" }, apiKeyEnvNames: [] }),
        readThreadId: async () => logsThread,
      },
    });
  });
  afterEach(() => db.close());

  function codexSeat(opts: { authored?: string; running?: boolean } = {}) {
    const rig = rigRepo.createRig("eff");
    const node = rigRepo.addNode(rig.id, "dev.codex", { runtime: "codex", cwd: "/w", ...(opts.authored ? { effort: opts.authored } : {}) });
    const session = sessionRegistry.registerSession(node.id, "dev-codex@eff");
    sessionRegistry.updateStatus(session.id, opts.running === false ? "exited" : "running");
    sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: "dev-codex@eff", tmuxPane: "%1" });
    sessionRegistry.updateResumeToken(session.id, "codex_id", "019a-thread", "scrape");
    return node;
  }
  function running(args: string) {
    rows = [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 200, executableName: "bash", command: "-bash", startedAt: LSTART },
      { pid: 200, ppid: 100, pgid: 200, tpgid: 200, executableName: "codex", command: `/usr/local/bin/codex ${args}`, startedAt: LSTART },
    ];
  }

  it("reports requested, saved, the launch's flag and the native turn, and names a native value the launch didn't send", async () => {
    codexSeat({ authored: "medium" });
    await service.setEffort({ seatRef: "dev-codex@eff", effort: "high", reason: "long refactor", operator: "op" });
    running(`-m gpt-5.5 -c model_reasoning_effort="high" resume 019a-thread`);
    transcript = file("rollout.jsonl", [
      { type: "turn_context", timestamp: at(5), payload: { turn_id: "t1", effort: "medium" } },
      { type: "event_msg", timestamp: at(7), payload: { type: "task_complete", turn_id: "t1" } },
    ]);

    const report = await service.effortReport("dev-codex@eff");
    expect(report).toMatchObject({
      ok: true, runtime: "codex",
      requested: { value: "high", reason: "long refactor", operator: "op" },
      saved: { choice: "high", authored: "medium", effective: "high", source: "seat_choice" },
      emitted: { state: "observed", value: "high", pid: 200, matchesSaved: true },
      observed: { state: "observed", value: "medium", matchesEmitted: false, outcome: "accepted" },
      precedence: { decided: true },
    });
    expect((report as { summary: string }).summary).toContain("medium, not the high the launch sent");
    expect((report as { summary: string }).summary).toContain("accepted by the service for that turn");
  });

  it("before the seat takes a turn, and before a continuation, says so instead of claiming the saved value", async () => {
    codexSeat({ authored: "medium" });
    await service.setEffort({ seatRef: "dev-codex@eff", effort: "high", reason: "r" });
    running(`-m gpt-5.5 -c model_reasoning_effort="medium" resume 019a-thread`);
    transcript = file("rollout.jsonl", [{ type: "turn_context", timestamp: at(-30), payload: { effort: "medium" } }]);

    const report = await service.effortReport("dev-codex@eff");
    expect(report).toMatchObject({ emitted: { value: "medium", matchesSaved: false }, observed: { state: "not_verified" } });
    expect((report as { summary: string }).summary).toMatch(/differs from the saved value.*NOT VERIFIED/);
  });

  it("attributes native effort only from the conversation the observed process is on", async () => {
    codexSeat({ authored: "low" });
    transcript = file("rollout-a.jsonl", [
      { type: "turn_context", timestamp: at(5), payload: { turn_id: "a1", effort: "low" } },
      { type: "event_msg", timestamp: at(7), payload: { type: "task_complete", turn_id: "a1" } },
    ]);
    // The pane now runs conversation B at high; the registry and its transcript still name A (019a-thread).
    running(`-c model_reasoning_effort="high" resume 019b-other`);
    const b = await service.effortReport("dev-codex@eff");
    expect(b).toMatchObject({ emitted: { state: "observed", value: "high" }, observed: { state: "not_verified" } });
    expect((b as { observed: { detail: string } }).observed.detail).toContain("isn't on the conversation recorded");
    // A fresh Codex names no conversation in argv: its own logs decide.
    running(`-c model_reasoning_effort="low" -C /w`);
    logsThread = "019b-other";
    expect(await service.effortReport("dev-codex@eff")).toMatchObject({ observed: { state: "not_verified" } });
    logsThread = "019a-thread";
    expect(await service.effortReport("dev-codex@eff")).toMatchObject({ observed: { state: "observed", value: "low", outcome: "accepted" } });
    logsThread = undefined;
    expect(await service.effortReport("dev-codex@eff")).toMatchObject({ observed: { state: "not_verified" } });
  });

  it("joins a Claude process to its sidecar session by argv, or by a recorded resume rotation", async () => {
    const rig = rigRepo.createRig("effc");
    const node = rigRepo.addNode(rig.id, "dev.claude", { runtime: "claude-code", cwd: "/w", effort: "high" });
    const session = sessionRegistry.registerSession(node.id, "dev-claude@effc");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: "dev-claude@effc", tmuxPane: "%1" });
    transcript = file("claude.jsonl", [{ type: "assistant", timestamp: at(5), effort: "high" }]);
    const claude = (args: string) => {
      rows = [
        { pid: 100, ppid: 1, pgid: 100, tpgid: 200, executableName: "bash", command: "-bash", startedAt: LSTART },
        { pid: 200, ppid: 100, pgid: 200, tpgid: 200, executableName: "claude", command: `claude --effort high ${args}`, startedAt: LSTART },
      ];
    };
    sidecarSession = "sess-s";
    claude("--resume sess-s");
    expect(await service.effortReport("dev-claude@effc")).toMatchObject({ observed: { state: "observed", value: "high", outcome: "recorded" } });
    claude("--resume sess-t");
    expect(await service.effortReport("dev-claude@effc")).toMatchObject({ observed: { state: "not_verified" } });
    db.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'sess-s', resume_rotated_from = 'sess-t' WHERE id = ?").run(session.id);
    expect(await service.effortReport("dev-claude@effc")).toMatchObject({ observed: { state: "observed", value: "high" } });
  });

  it("is unknown for a seat with no running session, and refuses runtimes without effort", async () => {
    codexSeat({ running: false });
    expect(await service.effortReport("dev-codex@eff")).toMatchObject({
      ok: true, requested: null, saved: { source: "runtime_default" }, emitted: { state: "unknown" }, observed: { state: "not_verified" },
    });
    rigRepo.addNode(rigRepo.createRig("pi").id, "dev.pi", { runtime: "pi" });
    expect(await service.effortReport("dev.pi")).toMatchObject({ ok: false, code: "effort_unsupported_runtime" });
  });
});
