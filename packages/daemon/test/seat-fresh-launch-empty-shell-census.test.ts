import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { ProcessTableRow } from "../src/domain/process-table.js";

// The process table as the daemon's own observers see it. `live` is the table now, and `hidden` the pids whose stat this
// user can't read (Linux hidepid). The shared read models another observer's census still in flight: it listed the
// processes once, when it began, and every caller asking meanwhile joins it. A census that begins now sees `live`.
// `children` is the shell's own children list (Linux), null where the kernel keeps none.
// (`readProcessTableNow` is round 3's rows-only read, kept so that round's code can run against these cells.)
const table = vi.hoisted(() => ({ live: [] as ProcessTableRow[], shared: null as ProcessTableRow[] | null, hidden: [] as number[],
  children: [] as number[] | null }));
vi.mock("../src/domain/process-table.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain/process-table.js")>()),
  readProcessTable: async () => (table.shared ??= [...table.live]),
  readProcessTableCensusNow: async () => ({ rows: [...table.live], permissionHiddenPids: [...table.hidden] }),
  readProcessTableNow: async () => [...table.live],
  readProcessChildrenNow: async () => table.children && [...table.children],
}));

// #3392 (CR-F1): the last empty-shell sample before the stop must be a census begun for it. With no lister injected, as
// the daemon's own seat route runs, a shared census another observer began before a harness started under the shell
// must not let the stop proceed.
describe("a fresh launch without --stop, with the daemon's own process reads", () => {
  let db: Database.Database;
  let repo: RigRepository;
  let registry: SessionRegistry;
  let bus: EventBus;
  let service: SeatLifecycleService;
  let commands: string[];
  let named: string | undefined;
  let onIdentity: (() => void) | undefined;
  const shell: ProcessTableRow = { pid: 4242, ppid: 1, pgid: 4242, tpgid: 4242, executableName: "zsh", command: "-zsh",
    startedAt: "Sat Jan  1 12:00:00 2000" };
  const claude: ProcessTableRow = { pid: 5000, ppid: 4242, pgid: 5000, tpgid: 4242, executableName: "claude", command: "claude",
    startedAt: "Sat Jan  1 12:01:00 2000" };

  beforeEach(() => {
    db = createFullTestDb();
    db.exec(outboxEntriesSchema.sql);
    db.exec(seatDeliveryGuardSchema.sql);
    repo = new RigRepository(db);
    registry = new SessionRegistry(db);
    bus = new EventBus(db);
    commands = [];
    table.live = [shell];
    table.shared = null;
    table.hidden = [];
    table.children = [];
    named = undefined;
    onIdentity = undefined;
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
      if (command.includes("detach-client")) return "";
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
    // No listProcesses: the service reads the table as the daemon's seat route does.
    service = new SeatLifecycleService({
      db, rigRepo: repo, sessionRegistry: registry, eventBus: bus, tmuxAdapter: adapter,
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

  it("doesn't kill when a harness starts under the shell after another observer's shared census listed it empty", async () => {
    const seat = failedStartSeat();
    // While the adapter reads the session's identity, another observer's census lists the empty shell and stays in
    // flight; then a harness starts under the shell. The record and the shell's own fingerprint don't change.
    onIdentity = () => {
      table.shared = [shell];
      table.live = [shell, claude];
    };
    const result = await service.launchFresh({ seatRef: seat.name, fresh: true, reason: "replace the shell" });
    expect(killIssued()).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "selection_changed", stopPhase: "none" });
    expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(seat.session.id) as { status: string }).status).toBe("running");
  });

  // #3392 r4: a child running as another user is hidden from this user's /proc (hidepid). The census names the hidden pid
  // but not its parent, so the proof can't say the shell is empty, and the launch keeps --stop.
  it("keeps --stop when some process is hidden from this user, though the shell shows no child", async () => {
    const seat = failedStartSeat();
    table.hidden = [6000];
    const result = await service.launchFresh({ seatRef: seat.name, fresh: true, reason: "replace the shell" });
    expect(killIssued()).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "session_live" });
    expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(seat.session.id) as { status: string }).status).toBe("running");
  });

  // #3392 r5: under hidepid=2 another user's process is missing from the census altogether, hidden pid and all. The
  // shell's own children list still names it, so the launch keeps --stop.
  it("keeps --stop when the shell's own children list names a process the census doesn't show", async () => {
    const seat = failedStartSeat();
    table.children = [7000];
    const result = await service.launchFresh({ seatRef: seat.name, fresh: true, reason: "replace the shell" });
    expect(killIssued()).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "session_live" });
    expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(seat.session.id) as { status: string }).status).toBe("running");
  });

  it("kills on the census alone where the kernel keeps no children list", async () => {
    const seat = failedStartSeat();
    table.children = null;
    await service.launchFresh({ seatRef: seat.name, fresh: true, reason: "replace the shell" }).catch(() => undefined);
    expect(killIssued()).toBe(true);
  });

  it("kills when the shell stays empty, read anew at each sample", async () => {
    const seat = failedStartSeat();
    // What follows the kill (absence probes, the new launch) isn't this test's subject; the fake doesn't model it.
    await service.launchFresh({ seatRef: seat.name, fresh: true, reason: "replace the shell" }).catch(() => undefined);
    expect(killIssued()).toBe(true);
  });
});
