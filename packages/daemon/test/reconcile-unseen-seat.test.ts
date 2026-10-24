import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import type { ProcessTableRow } from "../src/domain/process-table.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

// A starting daemon that can't see its seats' tmux server (it didn't inherit their TMUX) must not read "not on my
// server" as "gone": while a seat's recorded process still runs, the session is left as it was, so the kernel doesn't
// relaunch duplicates and supersede the live seats. Without that evidence, as after a reboot, it detaches as before.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** ps's lstart, local time, as the process table reports a start time. */
const lstart = (d: Date) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} `
  + `${[d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":")} ${d.getFullYear()}`;

const OBSERVED = new Date("2026-10-24T04:40:00.000Z");
const BEFORE = new Date(OBSERVED.getTime() - 10 * 60_000);
const AFTER = new Date(OBSERVED.getTime() + 60_000);
const LATER = new Date(OBSERVED.getTime() + 5 * 60_000);
const SERVER = "tmux -S /tmp/seats.sock new-session -d -s anchor";
const row = (pid: number, ppid: number, startedAt: Date, command: string): ProcessTableRow =>
  ({ pid, ppid, pgid: pid, tpgid: -1, executableName: command.split(" ")[0]!, startedAt: lstart(startedAt), command });

const noServer = { probeSession: async () => ({ state: "transport_unavailable" as const }) } as unknown as TmuxAdapter;
/** The restarted daemon's identity poll, on a server where none of the seats' sessions exist. */
const blindPoll = { listSessions: async () => [] } as unknown as ConstructorParameters<typeof SeatIdentityReconciler>[0]["tmux"];

describe("startup reconcile: a seat on a tmux server this daemon can't see", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let rigId: string;
  let sessionId: string;
  let nodeId: string;
  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("demo");
    const node = rigRepo.addNode(rig.id, "advisor.lead", { role: "advisor" });
    const session = sessionRegistry.registerSession(node.id, "advisor-lead@demo");
    sessionRegistry.updateStatus(session.id, "running");
    rigId = rig.id;
    sessionId = session.id;
    nodeId = node.id;
    new SeatIdentityStore(db).upsert({
      nodeId: node.id, verdict: "verified", evidenceSource: null, reason: null,
      evidence: { registeredPane: "%1", observedPid: 4242, observedPanePid: 4241, observedCommand: "claude", matchedLayer: 1 },
      sessionName: "advisor-lead@demo", observedAt: OBSERVED.toISOString(),
    });
  });
  afterEach(() => db.close());

  const reconcile = (readProcesses: () => Promise<ProcessTableRow[]>, tmuxAdapter: TmuxAdapter = noServer) =>
    new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter, readProcesses }).reconcile(rigId);
  const status = () => sessionRegistry.getSessionsForRig(rigId)[0]!.status;
  const detachedEvents = () => (db.prepare("SELECT count(*) AS n FROM events WHERE type = 'session.detached'").get() as { n: number }).n;

  it("leaves it as it was while its recorded process still runs, and names that process's parent", async () => {
    const result = await reconcile(async () => [row(4241, 900, BEFORE, "claude"), row(900, 1, BEFORE, SERVER)]);
    expect(result).toMatchObject({ checked: 1, detached: 0,
      unseen: [{ sessionId, sessionName: "advisor-lead@demo", pid: 4241, parent: { pid: 900, command: SERVER } }] });
    expect(status()).toBe("running");
    expect(detachedEvents()).toBe(0);
  });

  it("does the same when the server it looked at runs but doesn't have the session", async () => {
    const absent = { probeSession: async () => ({ state: "absent" as const }) } as unknown as TmuxAdapter;
    const result = await reconcile(async () => [row(4241, 900, BEFORE, "claude")], absent);
    expect(result).toMatchObject({ detached: 0, unseen: [{ pid: 4241, parent: null }] });
    expect(status()).toBe("running");
  });

  it.each([
    ["after a reboot nothing recorded is running", async () => [row(77, 1, AFTER, "bash")]],
    ["a recorded pid now belongs to a process that started after the observation", async () => [row(4241, 1, AFTER, "bash"), row(4242, 1, AFTER, "bash")]],
    ["the process table can't be read", async () => { throw new Error("ps failed"); }],
  ] as Array<[string, () => Promise<ProcessTableRow[]>]>)("detaches as before when %s", async (_why, readProcesses) => {
    const result = await reconcile(readProcesses);
    expect(result).toMatchObject({ detached: 1, unseen: [] });
    expect(status()).toBe("detached");
    expect(detachedEvents()).toBe(1);
  });

  it("detaches as before when the recorded process belongs to an earlier session of the seat", async () => {
    db.prepare("UPDATE seat_identity_verdicts SET session_name = 'advisor-lead-old@demo'").run();
    const result = await reconcile(async () => [row(4241, 900, BEFORE, "claude")]);
    expect(result).toMatchObject({ detached: 1, unseen: [] });
  });

  describe("on a second restart, after the restarted daemon's own identity poll couldn't see the seat", () => {
    const running = async () => [row(4241, 900, BEFORE, "claude"), row(900, 1, BEFORE, SERVER)];
    const firstRestartThenPoll = async () => {
      expect(await reconcile(running)).toMatchObject({ detached: 0, unseen: [{ pid: 4241 }] });
      await new SeatIdentityReconciler({ db, tmux: blindPoll, now: () => LATER }).reconcileAll();
      // The current verdict stays honest: the poll saw nothing and records no pid.
      expect(new SeatIdentityStore(db).getForNode(nodeId)).toMatchObject({
        verdict: "tmux_unavailable", observedAt: LATER.toISOString(), evidence: { observedPid: null } });
    };

    it("still leaves it as it was while its last observed process runs", async () => {
      await firstRestartThenPoll();
      expect(await reconcile(running)).toMatchObject({ detached: 0, unseen: [{ pid: 4241, parent: { pid: 900 } }] });
      expect(status()).toBe("running");
      expect(detachedEvents()).toBe(0);
    });

    it("detaches once that process is gone", async () => {
      await firstRestartThenPoll();
      expect(await reconcile(async () => [row(900, 1, BEFORE, SERVER)])).toMatchObject({ detached: 1, unseen: [] });
      expect(status()).toBe("detached");
    });

    it("finds the seat again once the daemon looks at the seats' own server", async () => {
      await firstRestartThenPoll();
      const present = { probeSession: async () => ({ state: "present" as const }) } as unknown as TmuxAdapter;
      expect(await reconcile(running, present)).toMatchObject({ checked: 1, detached: 0, unseen: [] });
      expect(status()).toBe("running");
    });
  });
});
