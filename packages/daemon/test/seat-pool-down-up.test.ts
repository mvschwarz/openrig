import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { setDaemonTmuxServer } from "../src/adapters/tmux-server.js";
import type { SessionProbe } from "../src/adapters/tmux.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SeatPoolSlotsRepository } from "../src/domain/seat-pool-slots.js";
import { parsePoolBlock } from "../src/domain/seat-pool-spec.js";

// #3395 (Piece 1): a pool agent whose slot is `live` goes through `rig down` and `rig up` as a plain member. Down never
// touches the slot table, and restore skips only a `drained` slot (restore-orchestrator.test.ts).

const AT = "2026-11-18T10:00:00.000Z";
const RIG = "pool-rig";

describe("seat pool agents across rig down and rig up (#3395 Piece 1)", () => {
  let db: Database.Database;
  let probes: Map<string, () => Promise<SessionProbe>>;
  let setup: ReturnType<typeof createTestApp>;
  let slots: SeatPoolSlotsRepository;
  let queue: QueueRepository;
  /** Each harness launch: the node, its model and the conversation it resumes. */
  let launches: Array<{ nodeId: string; model: string | undefined; resumeToken: string | undefined }>;

  beforeEach(() => {
    setDaemonTmuxServer([]);
    db = createFullTestDb();
    probes = new Map();
    launches = [];
    const tmux = mockTmuxAdapter();
    // The down's probe of each session: present unless the test says otherwise.
    Object.assign(tmux, {
      probeSession: vi.fn(async (name: string) => (probes.get(name) ?? (async () => ({ state: "present" as const })))()),
      listPanes: vi.fn(async () => [{ id: "%9", index: 0, cwd: os.tmpdir(), width: 80, height: 24, active: true }]),
      getPanePid: vi.fn(async () => 100),
      getPaneCommand: vi.fn(async () => "sh"),
      capturePaneContent: vi.fn(async () => "Claude Code\n❯ accept edits on"),
    });
    // The harness resumes the conversation it is given, and the pane then runs it.
    let running = "";
    const listProcesses = async () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt: "fixture-start" },
      { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "claude", command: `claude --resume ${running}`, startedAt: "fixture-start" },
    ];
    const adapter = {
      runtime: "claude-code",
      project: async () => ({ applied: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: [], skipped: [], failed: [] }),
      launchHarness: vi.fn(async (binding: { nodeId: string; model?: string }, input: { resumeToken?: string }) => {
        launches.push({ nodeId: binding.nodeId, model: binding.model, resumeToken: input.resumeToken });
        running = input.resumeToken ?? "";
        return { ok: true, resumeType: "claude_id", resumeToken: running };
      }),
      checkReady: async () => ({ ready: true }),
    };
    setup = createTestApp(db, { tmux, listProcesses, adapters: { "claude-code": adapter } as never });
    slots = new SeatPoolSlotsRepository(db);
    queue = new QueueRepository(db, setup.eventBus, { validateRig: () => true });
  });

  afterEach(() => {
    setDaemonTmuxServer([]);
    db.close();
  });

  function seat(logicalId: string, opts: { pool?: boolean; model?: string; rig?: string } = {}) {
    const rigName = opts.rig ?? RIG;
    const rig = setup.rigRepo.findRigsByName(rigName)[0] ?? setup.rigRepo.createRig(rigName);
    const parsed = parsePoolBlock({ max: 2, min: 0 });
    if (!parsed.ok || !parsed.spec) throw new Error("expected a usable pool block");
    // In a pod, as a pool agent always is: its session name is `<pod>-<member>@<rig>`, the one restore launches it under.
    db.prepare("INSERT OR IGNORE INTO pods (id, rig_id, namespace, label) VALUES (?, ?, 'dev', 'Dev')").run(`pod-${rigName}`, rig.id);
    const node = setup.rigRepo.addNode(rig.id, logicalId, {
      runtime: "claude-code", podId: `pod-${rigName}`, cwd: os.tmpdir(), ...(opts.model ? { model: opts.model } : {}), ...(opts.pool ? { pool: { spec: parsed.spec } } : {}),
    });
    const sessionName = `${logicalId.replace(/\./g, "-")}@${rigName}`;
    const session = setup.sessionRegistry.registerSession(node.id, sessionName);
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateResumeToken(session.id, "claude_id", `conv-${logicalId}`, "hook");
    setup.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName });
    return { rigId: rig.id, node, session, sessionName };
  }

  async function claimedRow(destinationSession: string) {
    const row = await queue.create({ sourceSession: `dev-impl@${RIG}`, destinationSession, body: "work in hand" });
    queue.claim({ qitemId: row.qitemId, destinationSession });
    return row.qitemId;
  }

  const rowOf = (qitemId: string) =>
    db.prepare("SELECT destination_session AS destination, state FROM queue_items WHERE qitem_id = ?").get(qitemId);
  const sessionsOf = (nodeId: string) =>
    db.prepare("SELECT id, status, intentionally_stopped AS stopped, resume_token AS token FROM sessions WHERE node_id = ? ORDER BY created_at, id")
      .all(nodeId) as Array<{ id: string; status: string; stopped: number; token: string | null }>;
  const down = async (rigId: string) => {
    const res = await setup.app.request("/api/down", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rigId, force: true }),
    });
    expect(res.status).toBe(200);
    return await res.json() as { sessionsKilled: number; errors: string[] };
  };
  const up = async () => {
    const res = await setup.app.request("/api/up", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceRef: RIG }),
    });
    expect(res.status).toBe(200);
    return await res.json() as { status: string; rigResult: string; nodes: Array<Record<string, unknown>>; keptDown?: unknown };
  };

  it("With `min: 0`, a pool agent holding a claimed row goes through `rig down` with the stop confirmed (`intentionally_stopped = 1`, counted in `sessionsKilled`) and its slot still `live`, and `rig up` brings back the same node, name, model and history with the row still its own.", async () => {
    const model = seat("dev.impl", { pool: true });
    const agent = seat("dev.impl-s1", { model: "claude-model-x" });
    const slot = slots.insert({ modelNodeId: model.node.id, slotNumber: 1, nodeId: agent.node.id, phase: "live", at: AT });
    const row = await claimedRow(agent.sessionName);

    const stopped = await down(model.rigId);
    expect(stopped.errors).toEqual([]);
    expect(stopped.sessionsKilled).toBe(2);
    expect(sessionsOf(agent.node.id)).toEqual([{ id: agent.session.id, status: "exited", stopped: 1, token: "conv-dev.impl-s1" }]);
    expect(slots.get(slot.slotId)).toEqual(slot);

    const restored = await up();
    expect(restored.status).toBe("restored");
    expect(restored.keptDown).toBeUndefined();
    const result = restored.nodes.find((node) => node.nodeId === agent.node.id);
    expect(result).toMatchObject({ logicalId: "dev.impl-s1" });
    expect(result?.status, JSON.stringify(restored)).toBe("resumed");
    // The same node, its name and model, and the same conversation resumed into a new session row of that node.
    const node = db.prepare("SELECT id, logical_id AS logicalId, model FROM nodes WHERE id = ?").get(agent.node.id);
    expect(node).toEqual({ id: agent.node.id, logicalId: "dev.impl-s1", model: "claude-model-x" });
    const sessions = sessionsOf(agent.node.id);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual({ id: agent.session.id, status: "exited", stopped: 1, token: "conv-dev.impl-s1" });
    expect(sessions[1], JSON.stringify(restored)).toMatchObject({ status: "running" });
    // Under the same name: the session the claimed row is addressed to, bound to the agent's node.
    expect(db.prepare("SELECT session_name AS name FROM sessions WHERE id = ?").get(sessions[1]!.id)).toEqual({ name: agent.sessionName });
    expect(setup.sessionRegistry.getBindingForNode(agent.node.id)?.tmuxSession).toBe(agent.sessionName);
    // The same conversation, launched with the agent's own model.
    expect(launches.filter((launch) => launch.nodeId === agent.node.id))
      .toEqual([{ nodeId: agent.node.id, model: "claude-model-x", resumeToken: "conv-dev.impl-s1" }]);
    expect(slots.get(slot.slotId)).toEqual(slot);
    expect(rowOf(row)).toEqual({ destination: agent.sessionName, state: "in-progress" });
  });

  it("A pool agent that died holding a claimed row, then `rig down` and `rig up`: its slot is still `live`, the row keeps its owner, the down does not count it in `sessionsKilled`, and restore's result for the node matches a plain member in the same state.", async () => {
    const model = seat("dev.impl", { pool: true });
    const agent = seat("dev.impl-s1");
    const plain = seat("dev.helper");
    const slot = slots.insert({ modelNodeId: model.node.id, slotNumber: 1, nodeId: agent.node.id, phase: "live", at: AT });
    const agentRow = await claimedRow(agent.sessionName);
    const plainRow = await claimedRow(plain.sessionName);
    // Both processes are gone: tmux reports their sessions absent, while their rows still say running.
    probes.set(agent.sessionName, async () => ({ state: "absent" }));
    probes.set(plain.sessionName, async () => ({ state: "absent" }));

    const stopped = await down(model.rigId);
    expect(stopped.errors).toEqual([]);
    // Only the model's session was killed; the two found absent are recorded stopped and not counted.
    expect(stopped.sessionsKilled).toBe(1);
    expect(sessionsOf(agent.node.id)).toEqual([{ id: agent.session.id, status: "exited", stopped: 1, token: "conv-dev.impl-s1" }]);
    expect(sessionsOf(plain.node.id)).toEqual([{ id: plain.session.id, status: "exited", stopped: 1, token: "conv-dev.helper" }]);
    expect(slots.get(slot.slotId)).toEqual(slot);

    const restored = await up();
    expect(restored.keptDown).toBeUndefined();
    const of = (nodeId: string, logicalId: string, sessionName: string, conv: string) => {
      const result = restored.nodes.find((node) => node.nodeId === nodeId);
      expect(result).toBeDefined();
      // The same outcome with the node's own names taken out.
      return JSON.parse(JSON.stringify(result).replaceAll(nodeId, "<node>").replaceAll(logicalId, "<seat>")
        .replaceAll(sessionName, "<session>").replaceAll(conv, "<conv>").replaceAll(logicalId.replace(/\./g, "-"), "<seat>"));
    };
    expect(of(agent.node.id, "dev.impl-s1", agent.sessionName, "conv-dev.impl-s1"))
      .toEqual(of(plain.node.id, "dev.helper", plain.sessionName, "conv-dev.helper"));
    expect(slots.get(slot.slotId)).toEqual(slot);
    expect(rowOf(agentRow)).toEqual({ destination: agent.sessionName, state: "in-progress" });
    expect(rowOf(plainRow)).toEqual({ destination: plain.sessionName, state: "in-progress" });
  });

  it("A `rig down` whose probe of a pool agent's session is neither present nor absent leaves the slot as it was.", async () => {
    // Neither present nor absent: an unavailable tmux transport, and a probe that throws.
    const neither: Array<() => Promise<SessionProbe>> = [
      async () => ({ state: "transport_unavailable", cause: "tmux timed out" }),
      async () => { throw new Error("tmux probe failed"); },
    ];
    for (const [n, probe] of neither.entries()) {
      const rig = `pool-rig-${n}`;
      const model = seat("dev.impl", { pool: true, rig });
      const agent = seat("dev.impl-s1", { rig });
      const slot = slots.insert({ modelNodeId: model.node.id, slotNumber: 1, nodeId: agent.node.id, phase: "live", at: AT });
      probes.set(agent.sessionName, probe);

      const stopped = await down(model.rigId);
      expect(stopped.errors).toHaveLength(1);
      expect(stopped.errors[0]).toContain(`'${agent.sessionName}'`);
      expect(stopped.sessionsKilled).toBe(1);
      // The stop request is recorded before the probe (#2940), so keep_alive doesn't bring the agent back; the row stays.
      expect(sessionsOf(agent.node.id)).toEqual([{ id: agent.session.id, status: "running", stopped: 1, token: "conv-dev.impl-s1" }]);
      expect(slots.get(slot.slotId)).toEqual(slot);
      expect(slots.forModel(model.node.id)).toEqual([slot]);
    }
  });
});
