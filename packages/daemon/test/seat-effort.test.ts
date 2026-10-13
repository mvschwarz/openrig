// OPR.0.7.0.7 — one seat's effort four ways: requested, saved, emitted at launch, observed natively.
// The shared resolver every managed continuation reads, the restore/refresh precedence seam (no rule
// picked), and the report that keeps the four values apart.
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
  UNDECIDED_EFFORT_PRECEDENCE, emittedEffortFromArgv, readNativeEffort, readSeatEffort, resolveSeatEffort,
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
    expect(readNativeEffort("claude-code", claude, LSTART)).toMatchObject({ state: "observed", value: "high", at: at(3) });
    const codex = file("rollout.jsonl", [
      { type: "session_meta", timestamp: at(-100), payload: { id: "t" } },
      { type: "turn_context", timestamp: at(4), payload: { model: "gpt-5.5", effort: "medium" } },
      { type: "event_msg", timestamp: at(6), payload: { type: "token_count" } },
    ]);
    expect(readNativeEffort("codex", codex, LSTART)).toMatchObject({ state: "observed", value: "medium", source: "Codex rollout (latest turn_context)" });
  });

  it("never reports a turn from before this launch: the same conversation's earlier effort is NOT VERIFIED", () => {
    const resumed = file("resumed.jsonl", [{ type: "assistant", timestamp: at(-60), effort: "low" }]);
    expect(readNativeEffort("claude-code", resumed, LSTART)).toMatchObject({ state: "not_verified" });
    expect(readNativeEffort("claude-code", join(dir, "absent.jsonl"), LSTART)).toMatchObject({ state: "not_verified" });
    expect(readNativeEffort("claude-code", null, LSTART)).toMatchObject({ state: "not_verified" });
    expect(readNativeEffort("claude-code", resumed, null)).toMatchObject({ state: "not_verified" });
  });
});

describe("UNDECIDED_EFFORT_PRECEDENCE: the seam where the founder's rule plugs in", () => {
  it("is marked undecided; a restore keeps launching the snapshot's effort and says so when the saved choice differs", () => {
    expect(UNDECIDED_EFFORT_PRECEDENCE.decided).toBe(false);
    const live = resolveSeatEffort({ effort: "medium", effortChoice: "high" });
    const differs = UNDECIDED_EFFORT_PRECEDENCE.restoreLaunchEffort({ snapshot: { effort: "medium" }, live });
    expect(differs.effort).toBe("medium");
    expect(differs.warning).toContain("saved choice high");
    expect(UNDECIDED_EFFORT_PRECEDENCE.restoreLaunchEffort({ snapshot: { effort: "high" }, live })).toEqual({ effort: "high" });
    expect(UNDECIDED_EFFORT_PRECEDENCE.restoreLaunchEffort({ snapshot: { effort: "low" }, live: resolveSeatEffort({ effort: "medium" }) })).toEqual({ effort: "low" });
  });

  it("never deletes the saved choice on a spec refresh", () => {
    expect(UNDECIDED_EFFORT_PRECEDENCE.specRefreshChoice({ choice: "high", authoredBefore: "medium", authoredAfter: "low" })).toBe("keep");
  });
});

describe("SeatLifecycleService.effortReport: four values, each from its own source", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let service: SeatLifecycleService;
  let rows: NativeProcessRow[];
  let transcript: string | null;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    rows = [];
    transcript = null;
    const tmux = { getPanePid: async () => 100 } as unknown as TmuxAdapter;
    service = new SeatLifecycleService({
      db, rigRepo, sessionRegistry, eventBus: new EventBus(db), tmuxAdapter: tmux, listProcesses: () => rows,
      transcripts: {
        readSidecar: () => (transcript ? { ok: true as const, data: { transcript_path: transcript } } : { ok: false as const }),
        readCodexTranscriptPath: () => transcript,
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
    transcript = file("rollout.jsonl", [{ type: "turn_context", timestamp: at(5), payload: { effort: "medium" } }]);

    const report = await service.effortReport("dev-codex@eff");
    expect(report).toMatchObject({
      ok: true, runtime: "codex",
      requested: { value: "high", reason: "long refactor", operator: "op" },
      saved: { choice: "high", authored: "medium", effective: "high", source: "seat_choice" },
      emitted: { state: "observed", value: "high", pid: 200, matchesSaved: true },
      observed: { state: "observed", value: "medium", matchesEmitted: false },
      precedence: { decided: false },
    });
    expect((report as { summary: string }).summary).toContain("not the high the launch sent");
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

  it("is unknown for a seat with no running session, and refuses runtimes without effort", async () => {
    codexSeat({ running: false });
    expect(await service.effortReport("dev-codex@eff")).toMatchObject({
      ok: true, requested: null, saved: { source: "runtime_default" }, emitted: { state: "unknown" }, observed: { state: "not_verified" },
    });
    rigRepo.addNode(rigRepo.createRig("pi").id, "dev.pi", { runtime: "pi" });
    expect(await service.effortReport("dev.pi")).toMatchObject({ ok: false, code: "effort_unsupported_runtime" });
  });
});
