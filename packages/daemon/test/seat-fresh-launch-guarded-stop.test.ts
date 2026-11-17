import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";

// #3392: a fresh launch without --stop ends a failed start's shell only while the shell is still empty at the stop. The
// real guarded adapter reads the pane, the session's identity and its seat marker, then detaches and kills; the pane's
// processes are observed again after those reads, right before each effect.
describe("a fresh launch without --stop, through the guarded tmux adapter", () => {
  let db: Database.Database;
  let repo: RigRepository;
  let registry: SessionRegistry;
  let bus: EventBus;
  let service: SeatLifecycleService;
  let commands: string[];
  let processes: NativeProcessRow[];
  let named: string | undefined;
  let onIdentity: (() => void) | undefined;
  let onDetach: (() => void) | undefined;
  const shell: NativeProcessRow = { pid: 4242, ppid: 1, pgid: 4242, tpgid: 4242, executableName: "zsh", command: "-zsh", argv: ["-zsh"],
    startedAt: "Sat Jan  1 12:00:00 2000" };
  const claude: NativeProcessRow = { pid: 5000, ppid: 4242, pgid: 5000, tpgid: 4242, executableName: "claude", command: "claude",
    argv: ["claude"], startedAt: "Sat Jan  1 12:01:00 2000" };

  beforeEach(() => {
    db = createFullTestDb();
    db.exec(outboxEntriesSchema.sql);
    db.exec(seatDeliveryGuardSchema.sql);
    repo = new RigRepository(db);
    registry = new SessionRegistry(db);
    bus = new EventBus(db);
    commands = [];
    processes = [shell];
    named = undefined;
    onIdentity = onDetach = undefined;
    const adapter = new TmuxAdapter(async command => {
      commands.push(command);
      if (command.includes("has-session")) return "";
      if (command.includes("#{pane_pid}")) return "4242";
      if (command.includes("list-panes")) { named = /=([^:']+):/.exec(command)?.[1] ?? named; return "%1|0|/project|120|40|1"; }
      if (command.startsWith("tmux show-environment")) {
        const bound = db.prepare("SELECT node_id FROM bindings WHERE tmux_session = ?").get(named) as { node_id: string } | undefined;
        return `OPENRIG_NODE_ID=${bound?.node_id ?? ""}`;
      }
      if (command.startsWith("tmux display-message") && command.includes("#{session_id}")) { onIdentity?.(); return "$7|4242|1700000000"; }
      if (command.includes("detach-client")) { onDetach?.(); return ""; }
      if (command.includes("kill-session")) return "";
      throw new Error(`unexpected tmux command: ${command}`);
    });
    adapter.deliveryGuard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    const runtime: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: true, resumeToken: "fresh", resumeType: "claude_session_id" }),
      checkReady: async () => ({ ready: true }),
    };
    service = new SeatLifecycleService({
      db, rigRepo: repo, sessionRegistry: registry, eventBus: bus, tmuxAdapter: adapter,
      listProcesses: async () => processes,
      nodeLauncher: new NodeLauncher({ db, rigRepo: repo, sessionRegistry: registry, eventBus: bus, tmuxAdapter: adapter }),
      startupOrchestrator: new StartupOrchestrator({ db, sessionRegistry: registry, eventBus: bus, tmuxAdapter: adapter, sleep: async () => undefined }),
      runtimeAdapters: { "claude-code": runtime },
    });
  });
  afterEach(() => db.close());

  function failedStartSeat() {
    const rig = repo.createRig("guarded");
    const node = repo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/project" });
    const name = "dev-impl@guarded";
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: name, tmuxPane: "%1" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) "
      + "VALUES (?, '[]', '[]', '[]', 'claude-code')").run(node.id);
    registry.updateStartupStatus(session.id, "failed");
    bus.emit({ type: "node.startup_failed", rigId: rig.id, nodeId: node.id, sessionId: session.id, stage: "readiness_check",
      readinessCode: "returned_to_shell", error: "Readiness timeout after 30s — harness did not become interactive: The probe pane returned to a shell instead of staying inside the runtime." });
    return { node, session, name };
  }
  const killIssued = () => commands.some(command => command.includes("kill-session"));
  const detachIssued = () => commands.some(command => command.includes("detach-client"));

  it.each([
    { when: "the adapter reads the session's identity", during: "identity" as const, stopPhase: "none" },
    { when: "the clients are detached", during: "detach" as const, stopPhase: "detached" },
  ])("doesn't kill when a harness starts under the shell while $when, with the record unchanged", async ({ during, stopPhase }) => {
    const seat = failedStartSeat();
    const start = () => { processes = [shell, claude]; };
    if (during === "identity") onIdentity = start; else onDetach = start;
    const result = await service.launchFresh({ seatRef: seat.name, fresh: true, reason: "replace the shell" });
    expect(killIssued()).toBe(false);
    expect(detachIssued()).toBe(during === "detach");
    expect(result).toMatchObject({ ok: false, code: "selection_changed", stopPhase, partialEffect: stopPhase !== "none" });
    expect((result as { message: string }).message).toContain("Right before the stop, its shell had a process under it or couldn't be observed");
    expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(seat.session.id) as { status: string }).status).toBe("running");
  });

  it("doesn't kill when the pane's processes can't be listed at the stop", async () => {
    const seat = failedStartSeat();
    onIdentity = () => { processes = undefined as unknown as NativeProcessRow[]; };
    const result = await service.launchFresh({ seatRef: seat.name, fresh: true, reason: "replace the shell" });
    expect(killIssued()).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "selection_changed", stopPhase: "none" });
  });

  it("detaches and kills when the shell stays empty through the adapter's reads", async () => {
    const seat = failedStartSeat();
    // What follows the kill (absence probes, the new launch) isn't this test's subject; the fake doesn't model it.
    await service.launchFresh({ seatRef: seat.name, fresh: true, reason: "replace the shell" }).catch(() => undefined);
    expect(detachIssued()).toBe(true);
    expect(killIssued()).toBe(true);
  });
});
