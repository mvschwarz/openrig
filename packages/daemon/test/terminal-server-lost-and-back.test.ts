// #3315 — the daemon once its tmux server is gone: the loss and the return are recorded once each, delivery to the
// seats on that server is held without spending attempts or writing events per attempt, owed work survives and goes
// out when the server answers again, nothing restarts the server, and one lost socket holds only its own seats.
// The terminal is modeled (no native server); terminal-server-lost-and-back-native.test.ts does the same on a real
// tmux server of its own.
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { TmuxAdapter, type SessionProbe } from "../src/adapters/tmux.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { RigDeliveryDrainStore } from "../src/domain/rig-delivery-drain.js";
import type { SendResult } from "../src/domain/session-transport.js";
import { TerminalServerReachability, type TerminalServerChange, type TerminalServerObservation } from "../src/domain/terminal-server-reachability.js";
import { wireTerminalReachability } from "../src/domain/terminal-server-seats.js";
import type { OutboxEntry } from "../src/domain/outbox-handler.js";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "../src/domain/watchdog-scheduler.js";
import { LADDER_ATTEMPT_PREFIX, LADDER_RUNG_PREFIX } from "../src/domain/queue-stuck-sweep.js";

const SOCKET = "/tmp/openrig-test-3315/sock";
const NO_SERVER = `no server running on ${SOCKET}`;

/** A real TmuxAdapter over a modeled server the TEST takes away and brings back. `tmux -D` (a server start) is only
 *  recorded: if anything in the daemon tried to restart the server, the test would see it in `commands`. */
function toggleableTerminal(sessions: string[] = []) {
  let up = true, denied = false;
  const live = new Set(sessions);
  const commands: string[] = [];
  const adapter = new TmuxAdapter(async command => {
    commands.push(command);
    if (command.startsWith("tmux -D")) return "";
    if (denied) throw new Error(`Command failed: ${command}\nerror connecting to ${SOCKET} (Permission denied)`);
    if (!up) throw new Error(`Command failed: ${command}\n${NO_SERVER}`);
    if (command.startsWith("tmux has-session")) {
      const name = /-t '?=([^' ]+)/.exec(command)?.[1] ?? "";
      if (live.has(name)) return "";
      throw new Error(`can't find session: ${name}`);
    }
    if (command.startsWith("tmux list-sessions")) return "";
    throw new Error(`Unexpected terminal command: ${command}`);
  });
  return {
    adapter, commands,
    takeAway: () => { up = false; },
    bringBack: () => { up = true; },
    /** tmux can't be read at all (not classified as a lost server): probeSession throws. */
    deny: () => { denied = true; },
    starts: () => commands.filter(c => c.startsWith("tmux -D")).length,
    probes: () => commands.filter(c => c.startsWith("tmux has-session")).length,
  };
}

const stores: Database.Database[] = [];
afterEach(() => { for (const db of stores.splice(0)) if (db.open) db.close(); vi.useRealTimers(); });
function database() {
  const db = new Database(":memory:"); stores.push(db);
  migrate(db, ALL_MIGRATIONS);
  return db;
}
function eventCount(db: Database.Database, type: string): number {
  return (db.prepare("SELECT count(*) AS n FROM events WHERE type = ?").get(type) as { n: number }).n;
}

/** The daemon's own wiring (wireTerminalReachability, as startup.ts calls it), with the return's resume steps spied. */
function wire(db: Database.Database, terminal: ReturnType<typeof toggleableTerminal>, drains: RigDeliveryDrainStore) {
  const eventBus = new EventBus(db);
  const changes: TerminalServerChange[] = [];
  const drainPendingWakeIntents = vi.fn(async (_opts: { eligible: (entry: OutboxEntry) => boolean }) => ({}));
  const retryPromptWakes = vi.fn((_session: string) => {});
  const reach = wireTerminalReachability({ db, adapter: terminal.adapter, drains, socket: SOCKET,
    emit: change => { changes.push(change); eventBus.emit(change); }, drainPendingWakeIntents, retryPromptWakes });
  return { reach, changes, eventBus, drainPendingWakeIntents, retryPromptWakes };
}

function seats(db: Database.Database) {
  db.exec(`INSERT INTO rigs(id, name) VALUES ('r', 'test');
    INSERT INTO nodes(id, rig_id, logical_id, runtime) VALUES ('n1', 'r', 'worker', 'claude-code'), ('n2', 'r', 'outside', 'claude-code');
    INSERT INTO sessions(id, node_id, session_name, status) VALUES ('s1', 'n1', 'worker@test', 'running'), ('s2', 'n2', 'outside@test', 'running');
    INSERT INTO bindings(id, node_id, attachment_type, tmux_session) VALUES ('b1', 'n1', 'tmux', 'worker@test');
    INSERT INTO bindings(id, node_id, attachment_type, external_session_name) VALUES ('b2', 'n2', 'external_cli', 'outside@test');`);
}

describe("the record of a lost tmux server", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });

  it("records the loss and the return once each, however many probes see them", () => {
    const changes: TerminalServerChange[] = [];
    const reach = new TerminalServerReachability({ onChange: c => changes.push(c) });
    reach.observe(SOCKET, { reachable: true });
    for (let i = 0; i < 50; i++) reach.observe(SOCKET, { reachable: false, cause: NO_SERVER });
    expect(changes).toEqual([{ type: "tmux.server_gone", socket: SOCKET, cause: NO_SERVER, since: "2026-01-01T00:00:00.000Z" }]);
    expect(reach.snapshot()).toMatchObject({ state: "degraded", servers: [{ socket: SOCKET, state: "unreachable", cause: NO_SERVER }] });
    vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
    for (let i = 0; i < 50; i++) reach.observe(SOCKET, { reachable: true });
    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual({ type: "tmux.server_back", socket: SOCKET, since: "2026-01-01T01:00:00.000Z", goneSince: "2026-01-01T00:00:00.000Z" });
    expect(reach.snapshot()).toMatchObject({ state: "ok", servers: [{ state: "reachable", transitions: 2 }] });
    expect(reach.snapshot().servers[0]).not.toHaveProperty("cause");
  });

  it("keeps one unreachable socket from affecting another", () => {
    const reach = new TerminalServerReachability();
    reach.observe("/tmp/a/sock", { reachable: false, cause: "no server running on /tmp/a/sock" });
    reach.observe("/tmp/b/sock", { reachable: true });
    expect(reach.unreachable("/tmp/a/sock")).not.toBeNull();
    expect(reach.unreachable("/tmp/b/sock")).toBeNull();
    expect(reach.snapshot().state).toBe("degraded");
    expect(reach.snapshot().servers.map(s => [s.socket, s.state])).toEqual([["/tmp/a/sock", "unreachable"], ["/tmp/b/sock", "reachable"]]);
  });

  it("is unknown before anything was observed", () => {
    expect(new TerminalServerReachability().snapshot()).toEqual({ state: "unknown", servers: [] });
  });

  it("notices the return with a read-only probe on a bounded backoff, and never starts the server", async () => {
    const db = database(), terminal = toggleableTerminal(); seats(db);
    const { reach, changes } = wire(db, terminal, new RigDeliveryDrainStore(db));
    terminal.takeAway();
    await terminal.adapter.probeSession("worker@test"); // the delivery attempt that finds the loss
    expect(changes.map(c => c.type)).toEqual(["tmux.server_gone"]);
    // An hour without the server: 5, 10, 20, 40 s, then every 60 s at most.
    for (let s = 0; s < 3600; s += 5) await vi.advanceTimersByTimeAsync(5_000);
    expect(terminal.probes() - 1).toBeLessThanOrEqual(64);
    expect(terminal.probes() - 1).toBeGreaterThanOrEqual(55);
    expect(changes).toHaveLength(1);
    terminal.bringBack();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changes.map(c => c.type)).toEqual(["tmux.server_gone", "tmux.server_back"]);
    const afterReturn = terminal.probes();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(terminal.probes()).toBe(afterReturn); // no probing while the server answers
    expect(terminal.starts()).toBe(0);
    expect(reach.snapshot().state).toBe("ok");
    expect(eventCount(db, "tmux.server_gone")).toBe(1);
    expect(eventCount(db, "tmux.server_back")).toBe(1);
  });

  it("takes an absent server with no running seat on it for the idle state, and stops watching a loss whose seats stop", async () => {
    const db = database(); seats(db);
    db.exec("UPDATE sessions SET status = 'stopped'");
    const terminal = toggleableTerminal();
    const { reach, changes } = wire(db, terminal, new RigDeliveryDrainStore(db));
    terminal.takeAway(); // tmux exits with its last session: nothing depends on it
    await terminal.adapter.probeSession("worker@test");
    await terminal.adapter.listSessions();
    expect(changes).toEqual([]);
    expect(reach.snapshot().state).toBe("unknown");
    db.exec("UPDATE sessions SET status = 'running' WHERE id = 's1'");
    await terminal.adapter.probeSession("worker@test");
    expect(changes.map(c => c.type)).toEqual(["tmux.server_gone"]);
    db.exec("UPDATE sessions SET status = 'stopped'"); // its seats were stopped meanwhile
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reach.snapshot()).toEqual({ state: "unknown", servers: [] });
    const probes = terminal.probes();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(terminal.probes()).toBe(probes);
  });

  it("offers owed work again on the return: pending wake intents of tmux seats, and the reachable retry of running ones", async () => {
    const db = database(); seats(db);
    const terminal = toggleableTerminal();
    const { drainPendingWakeIntents, retryPromptWakes } = wire(db, terminal, new RigDeliveryDrainStore(db));
    terminal.takeAway();
    await terminal.adapter.probeSession("worker@test");
    expect(drainPendingWakeIntents).not.toHaveBeenCalled();
    terminal.bringBack();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(drainPendingWakeIntents).toHaveBeenCalledTimes(1);
    const { eligible } = drainPendingWakeIntents.mock.calls[0]![0];
    const entry = (destinationSession: string, deliveryState: string) => ({ destinationSession, deliveryState }) as OutboxEntry;
    expect(eligible(entry("worker@test", "pending"))).toBe(true);
    expect(eligible(entry("worker@test", "failed"))).toBe(false); // not re-sent blindly: the reachable retry decides
    expect(eligible(entry("outside@test", "pending"))).toBe(false);
    expect(retryPromptWakes.mock.calls).toEqual([["worker@test"]]);
  });

  it("ends the hold on a return probe it can't read, keeps the loss as history, and claims no return", async () => {
    const db = database(); seats(db);
    const terminal = toggleableTerminal(), drains = new RigDeliveryDrainStore(db);
    const { reach, changes, drainPendingWakeIntents, retryPromptWakes } = wire(db, terminal, drains);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    terminal.takeAway();
    await terminal.adapter.probeSession("worker@test");
    expect(drains.holds("worker@test")).toBe(true);
    terminal.deny(); // e.g. a standing permission error, while the server may well be back
    await vi.advanceTimersByTimeAsync(5_000);
    expect(drains.holds("worker@test")).toBe(false);
    expect(changes.map(c => c.type)).toEqual(["tmux.server_gone"]);
    expect(eventCount(db, "tmux.server_back")).toBe(0);
    expect(reach.snapshot()).toMatchObject({ state: "unknown", servers: [{ socket: SOCKET, state: "unknown",
      since: "2026-01-01T00:00:05.000Z", lastLoss: { since: "2026-01-01T00:00:00.000Z", cause: NO_SERVER } }] });
    expect(reach.snapshot().servers[0]!.cause).toMatch(/^the return probe failed: .*Permission denied/);
    // Owed work resumes through the same pass as a return; no more probing and no new wait.
    expect(drainPendingWakeIntents).toHaveBeenCalledTimes(1);
    expect(retryPromptWakes.mock.calls).toEqual([["worker@test"]]);
    const probes = terminal.probes();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(terminal.probes()).toBe(probes);
    expect(terminal.starts()).toBe(0);
  });

  it("from an unknown reading, the next classified probe records the loss again, or the return of the loss kept", async () => {
    const changes: TerminalServerChange[] = [];
    const reach = new TerminalServerReachability({ onChange: c => changes.push(c), probe: async () => null });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    reach.observe(SOCKET, { reachable: false, cause: NO_SERVER });
    await vi.advanceTimersByTimeAsync(5_000); // a probe that answers nothing is unreadable too
    expect(reach.unreachable(SOCKET)).toBeNull();
    expect(reach.snapshot().servers[0]).toMatchObject({ state: "unknown", cause: "the return probe answered nothing" });
    reach.observe(SOCKET, { reachable: false, cause: NO_SERVER }); // a delivery's own probe finds it gone: held again
    expect(reach.unreachable(SOCKET)).not.toBeNull();
    expect(changes.map(c => c.type)).toEqual(["tmux.server_gone", "tmux.server_gone"]);
    await vi.advanceTimersByTimeAsync(5_000);
    vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
    reach.observe(SOCKET, { reachable: true });
    expect(changes.at(-1)).toEqual({ type: "tmux.server_back", socket: SOCKET, since: "2026-01-01T00:10:00.000Z",
      goneSince: "2026-01-01T00:00:05.000Z" });
    expect(reach.snapshot()).toMatchObject({ state: "ok", servers: [{ state: "reachable" }] });
    expect(reach.snapshot().servers[0]).not.toHaveProperty("lastLoss");
    reach.stop();
  });

  /** The daemon's wiring over an adapter whose return probes the TEST settles, so another probe's observation can land
   *  while one is pending. */
  function pendingProbes(db: Database.Database, drains: RigDeliveryDrainStore) {
    const pending: Array<{ resolve: (probe: SessionProbe) => void; reject: (error: unknown) => void }> = [];
    const adapter: Pick<TmuxAdapter, "probeSession" | "serverObserver"> = {
      probeSession: () => new Promise<SessionProbe>((resolve, reject) => { pending.push({ resolve, reject }); }),
    };
    const changes: TerminalServerChange[] = [];
    const drainPendingWakeIntents = vi.fn(async (_opts: { eligible: (entry: OutboxEntry) => boolean }) => ({}));
    const reach = wireTerminalReachability({ db, adapter, drains, socket: SOCKET, emit: change => { changes.push(change); },
      drainPendingWakeIntents, retryPromptWakes: () => {} });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return { reach, pending, changes, drainPendingWakeIntents, observe: (o: TerminalServerObservation) => adapter.serverObserver!(o) };
  }

  it("an unreadable return probe ends only the loss it was checking: a loss that began meanwhile stays held", async () => {
    const db = database(); seats(db);
    const drains = new RigDeliveryDrainStore(db);
    const { reach, pending, changes, drainPendingWakeIntents, observe } = pendingProbes(db, drains);
    observe({ reachable: false, cause: NO_SERVER }); // loss A
    await vi.advanceTimersByTimeAsync(5_000); // A's return probe starts and is still pending
    expect(pending).toHaveLength(1);
    vi.setSystemTime(new Date("2026-01-01T00:00:07Z"));
    observe({ reachable: true }); // the server answers again...
    vi.setSystemTime(new Date("2026-01-01T00:00:08Z"));
    observe({ reachable: false, cause: NO_SERVER }); // ...and goes again: loss B
    expect(changes.map(c => c.type)).toEqual(["tmux.server_gone", "tmux.server_back", "tmux.server_gone"]);
    const passes = drainPendingWakeIntents.mock.calls.length; // the return's pass
    pending[0]!.reject(new Error("Command failed: tmux has-session\nerror connecting to /x (Permission denied)"));
    await vi.advanceTimersByTimeAsync(0);
    expect(drains.holds("worker@test")).toBe(true);
    expect(reach.snapshot().servers[0]).toMatchObject({ state: "unreachable", since: "2026-01-01T00:00:08.000Z", cause: NO_SERVER });
    expect(drainPendingWakeIntents).toHaveBeenCalledTimes(passes); // nothing offered while B holds
    await vi.advanceTimersByTimeAsync(5_000); // B keeps its own return probe
    expect(pending).toHaveLength(2);
    pending[1]!.reject(new Error("unreadable")); // B's own unreadable probe still ends B's hold
    await vi.advanceTimersByTimeAsync(0);
    expect(drains.holds("worker@test")).toBe(false);
    expect(reach.snapshot().servers[0]).toMatchObject({ state: "unknown", lastLoss: { since: "2026-01-01T00:00:08.000Z" } });
    reach.stop();
  });

  it("a return probe's classified result never applies an older failure over a return recorded meanwhile", async () => {
    // The record's contract: its probe need not report through the adapter's observer, so another probe can record the
    // return while this one is pending. (Through the adapter, its observer and its result come out together.)
    const changes: TerminalServerChange[] = [];
    const pending: Array<(observation: TerminalServerObservation) => void> = [];
    const reach = new TerminalServerReachability({ onChange: c => changes.push(c),
      probe: () => new Promise<TerminalServerObservation>(resolve => { pending.push(resolve); }) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    reach.observe(SOCKET, { reachable: false, cause: NO_SERVER });
    await vi.advanceTimersByTimeAsync(5_000); // the return probe starts and is still pending
    reach.observe(SOCKET, { reachable: true }); // another probe records the return
    pending[0]!({ reachable: false, cause: NO_SERVER }); // the pending probe answers with what it saw before
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.map(c => c.type)).toEqual(["tmux.server_gone", "tmux.server_back"]);
    expect(reach.unreachable(SOCKET)).toBeNull();
    expect(reach.snapshot()).toMatchObject({ state: "ok", servers: [{ state: "reachable" }] });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(pending).toHaveLength(1); // no probing while the server answers
    reach.stop();
  });
});

describe("the tmux adapter reports each classified probe", () => {
  it("tells its observer what a probe showed, without changing the probe's result", async () => {
    const terminal = toggleableTerminal(["worker@test"]);
    const seen: unknown[] = [];
    terminal.adapter.serverObserver = observation => { seen.push(observation); throw new Error("observer bug"); };
    expect(await terminal.adapter.probeSession("worker@test")).toEqual({ state: "present" });
    expect(await terminal.adapter.probeSession("gone@test")).toEqual({ state: "absent" });
    terminal.takeAway();
    expect(await terminal.adapter.probeSession("worker@test")).toMatchObject({ state: "transport_unavailable" });
    expect(await terminal.adapter.listSessions()).toEqual([]);
    expect(seen).toEqual([{ reachable: true }, { reachable: true },
      { reachable: false, cause: NO_SERVER }, { reachable: false, cause: NO_SERVER }]);
  });

  /** A real TmuxAdapter whose exec fails the way execTmuxCommand does: the "Command failed:" line with the output
   *  appended for a reader, and tmux's own stderr kept apart as `execStderr`. */
  function failingListing(socket: string, stderr: string, stdout = "") {
    const seen: unknown[] = [];
    const commands: string[] = [];
    let thrown: Error | undefined;
    const adapter = new TmuxAdapter(async command => {
      commands.push(command);
      thrown = Object.assign(new Error([`Command failed: ${command}`, stdout, stderr].filter(Boolean).join("\n")),
        { stdout, stderr, execStderr: stderr });
      throw thrown;
    }, undefined, undefined, ["-S", socket]);
    adapter.serverObserver = observation => { seen.push(observation); };
    return { adapter, seen, commands, thrown: () => thrown };
  }

  it("classifies a listing from tmux's reported stderr: a refused custom socket is an empty listing and a loss", async () => {
    const refused = "error connecting to /custom/openrig.sock (Connection refused)";
    const terminal = failingListing("/custom/openrig.sock", `${refused}\n`);
    expect(await terminal.adapter.listSessions()).toEqual([]);
    expect(terminal.commands).toEqual([expect.stringMatching(/^tmux -S \/custom\/openrig\.sock list-sessions /)]);
    expect(terminal.seen).toEqual([{ reachable: false, cause: refused }]);
  });

  it("rejects a listing on unknown or permission stderr with the original error and no loss, whatever the command or stdout say", async () => {
    // The command (on a tmux-N socket) and stdout name a socket and an absence; only the stderr tmux reported may classify.
    const looksAbsent = "no server running on /tmp/tmux-1000/default\nerror connecting to /tmp/tmux-1000/default (Connection refused)";
    const cases: Array<[string, string]> = [
      ["error connecting to /custom/openrig.sock (Permission denied)\n", looksAbsent],
      ["open terminal failed: not a terminal\n", looksAbsent],
      ["server version is too old for client\n", looksAbsent],
      ["lost server: Connection refused\n", ""], // only the command's tmux-N socket resembles absence
    ];
    for (const [stderr, stdout] of cases) {
      const terminal = failingListing("/tmp/tmux-1000/default", stderr, stdout);
      await expect(terminal.adapter.listSessions()).rejects.toBe(terminal.thrown());
      expect(terminal.seen).toEqual([]);
    }
  });
});

describe("delivery while the server is gone", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });

  it("holds only the seats on the lost server, the drain's review job included, and fails open", async () => {
    const db = database(); seats(db);
    const terminal = toggleableTerminal(), drains = new RigDeliveryDrainStore(db);
    wire(db, terminal, drains);
    expect(drains.holds("worker@test")).toBe(false);
    terminal.takeAway();
    await terminal.adapter.probeSession("worker@test");
    expect(drains.holds("worker@test")).toBe(true);
    expect(drains.holds("worker@test", "any-review-job")).toBe(true);
    expect(drains.holds("outside@test")).toBe(false); // an external CLI seat never goes through tmux
    expect(drains.holds("nobody@test")).toBe(false);
    drains.attachTerminalHold(() => { throw new Error("database busy"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(drains.holds("worker@test")).toBe(false);
  });

  it("spends one attempt finding the loss, then nothing until the server answers; owed reminders then go out", async () => {
    const db = database(); seats(db);
    const terminal = toggleableTerminal(["worker@test"]);
    const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const { changes } = wire(db, terminal, queue.deliveryDrains);
    const jobs = new WatchdogJobsRepository(db), history = new WatchdogHistoryLog(db), outbox = new OutboxHandler(db);
    const unavailable = (cause: string): SendResult => ({ ok: false, sessionName: "worker@test", sent: false, inputPhase: "not_reached",
      reason: "tmux_unavailable", error: `The tmux server could not be reached (${cause}).` });
    // What SessionTransport does first: probe the session; a server that does not answer means nothing was sent.
    const send = vi.fn(async (session: string): Promise<SendResult> => {
      const probe = await terminal.adapter.probeSession(session);
      return probe.state === "transport_unavailable" ? unavailable(probe.cause) : { ok: true, sessionName: session, sent: true };
    });
    const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: new EventBus(db),
      deliveryDeferred: (jobId, session) => queue.deliveryDrains.holds(session, jobId),
      deliver: makeWatchdogDeliver({ sessionTransport: { send }, outbox, now: () => new Date(), retryIntervalSeconds: 300, retryCap: 3 }),
      now: () => new Date() });
    const scheduler = new WatchdogScheduler({ jobsRepo: jobs, policyEngine: engine, now: () => new Date(), onTickError: e => { throw e; } });
    const remind = (message: string) => jobs.register({ policy: "periodic-reminder",
      specYaml: `target: { session: worker@test }\nmessage: ${message}\n`, targetSession: "worker@test", intervalSeconds: 3600,
      registeredBySession: "owner@test" });
    const first = remind("Check the work");
    vi.setSystemTime(Date.now() + 3600_000);

    terminal.takeAway();
    await scheduler.runTickNow();
    expect(send).toHaveBeenCalledTimes(1); // the attempt that finds the loss
    expect(changes.map(c => c.type)).toEqual(["tmux.server_gone"]);
    const fired = eventCount(db, "watchdog.evaluation_fired"), historyRows = history.countForJob(first.jobId);
    const queueEvents = eventCount(db, "queue.updated"), evidence = eventCount(db, "transport.delivery_evidence");

    // Eight hours without the server: a pass every minute, and a reminder registered meanwhile.
    const second = remind("Fresh work");
    for (let minute = 0; minute < 8 * 60; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await scheduler.runTickNow();
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(eventCount(db, "watchdog.evaluation_fired")).toBe(fired);
    expect(history.countForJob(first.jobId)).toBe(historyRows);
    expect(history.countForJob(second.jobId)).toBe(0);
    expect(eventCount(db, "queue.updated")).toBe(queueEvents);
    expect(eventCount(db, "transport.delivery_evidence")).toBe(evidence);
    expect(jobs.getByIdOrThrow(first.jobId).state).toBe("active"); // still owed: not exhausted, not ended
    expect(eventCount(db, "tmux.server_gone")).toBe(1);

    terminal.bringBack();
    await vi.advanceTimersByTimeAsync(60_000); // the tracker's probe sees it answer
    expect(changes.map(c => c.type)).toEqual(["tmux.server_gone", "tmux.server_back"]);
    await scheduler.runTickNow();
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(jobs.getByIdOrThrow(first.jobId).lastFireAt).not.toBeNull();
    expect(jobs.getByIdOrThrow(second.jobId).lastFireAt).not.toBeNull();
    expect(terminal.starts()).toBe(0);
  });

  it("suspends the wake ladder for a baton on the lost server: no attempt, no rung, no escalation; it resumes after", async () => {
    const db = database(); seats(db);
    const terminal = toggleableTerminal(["worker@test"]);
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    wire(db, terminal, repo.deliveryDrains);
    const src = await repo.create({ sourceSession: "sender@test", destinationSession: "relay@test", body: "obligation" });
    const { created: baton } = await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@test", toSession: "worker@test", nudge: false });
    const failedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
      .run(failedAt, `failed:The tmux server could not be reached (${NO_SERVER}).`, baton.qitemId);
    const calls: string[] = [];
    const { runWakeLadderTick } = await import("../src/domain/queue-wake-ladder.js");
    const tick = () => runWakeLadderTick({ db, queueRepo: repo, resolveOrchestrator: () => "orch@test",
      attemptWake: async (qitemId: string) => { calls.push(qitemId); return "delivered:ok"; },
      retryIntervalSeconds: 300, retryCap: 3, unconfirmedWindowMinutes: 30, swapGraceSeconds: 180, log: () => {} });
    const markers = (prefix: string) => (db.prepare("SELECT transition_note AS n FROM queue_transitions WHERE qitem_id = ?")
      .all(baton.qitemId) as Array<{ n: string | null }>).map(r => r.n ?? "").filter(n => n.startsWith(prefix));

    terminal.takeAway();
    await terminal.adapter.probeSession("worker@test");
    for (let i = 0; i < 20; i++) {
      await tick();
      db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(new Date(Date.now() - 3600_000).toISOString(), baton.qitemId);
    }
    expect(calls).toEqual([]);
    expect(markers(LADDER_ATTEMPT_PREFIX)).toEqual([]);
    expect(markers(LADDER_RUNG_PREFIX)).toEqual([]);
    expect(repo.list({ limit: 500 }).filter((i: QueueItem) => i.destinationSession === "orch@test")).toEqual([]);
    expect(repo.getById(baton.qitemId)?.state).toBe("pending");

    terminal.bringBack();
    await terminal.adapter.probeSession("worker@test");
    await tick();
    expect(calls).toEqual([baton.qitemId]);
    expect(terminal.starts()).toBe(0);
  });
});
