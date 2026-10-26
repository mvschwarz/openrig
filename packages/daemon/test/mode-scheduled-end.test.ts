// A person's mode ends at the scheduled end they chose: armed with the application on the watchdog's own clock, it ends
// that application only, with the same end-if-mine path as "I'm back", and tells the kernel operator to give the account.
// Real SQLite (all migrations), real person records in a temp home, the real queue and watchdog jobs table.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { addHumanFragment, loadHumanRegistry, readHumanAvailability, removeHumanFragment, setHumanField } from "../src/domain/gateway/human-registry.js";
import { HumanModeService, registryAvailability } from "../src/domain/gateway/human-operating-modes.js";
import { makeTopologyDestinationCheck } from "../src/domain/queue-destination-check.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { armModeScheduledEnd, KERNEL_OPERATOR_SESSION, makeModeScheduledEndPolicy, MODE_SCHEDULED_END_POLICY, runModeScheduledEnd } from "../src/domain/policies/mode-scheduled-end.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const START = new Date("2026-10-20T21:00:00Z");
const END = new Date("2026-10-21T07:00:00Z");

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "mode-end-")); homes.push(home);
  expect(addHumanFragment({ entityId: "alex", class: "human", displayName: "alex", address: "alex@external", prefs: { deliveryClass: "B", availability: "focus" },
    connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://fixture", role: "primary", handle: "U-ALEX" }] }, home).ok).toBe(true);
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const queueRepo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => loadHumanRegistry(home) });
  const clock = { now: START };
  const modes = new HumanModeService({ db, availability: registryAvailability(home), now: () => clock.now,
    armScheduledEnd: (a) => armModeScheduledEnd({ jobsRepo: new WatchdogJobsRepository(db), ...a }) });
  modes.save("alex", { name: "asleep", availability: { value: "away" }, delivery: { account: "slack at seven" } }, "operator-agent@kernel");
  modes.save("alex", { name: "away-from-desk", availability: { value: "away" } }, "operator-agent@kernel");
  const jobFor = (applicationId: string) => new WatchdogJobsRepository(db).listActive()
    .find((j) => j.policy === MODE_SCHEDULED_END_POLICY && j.specYaml.includes(applicationId));
  // Each run uses new repositories over the same database, as after a daemon restart.
  // The queue as production builds it: rows are refused unless the destination check admits them.
  const validateRig = makeTopologyDestinationCheck({ findRigsByName: (name) => new RigRepository(db).findRigsByName(name), loadHumanRegistry: () => loadHumanRegistry(home) });
  const productionQueue = () => new QueueRepository(db, new EventBus(db), { validateRig, loadHumanRegistry: () => loadHumanRegistry(home) });
  const run = (jobId: string, at: Date, queueRepo = productionQueue()) => runModeScheduledEnd({ db, queueRepo,
    jobsRepo: new WatchdogJobsRepository(db), home, jobId, now: at });
  const toOperator = () => (db.prepare("SELECT destination_session AS dest, body FROM queue_items WHERE source_session = 'daemon@kernel'").all() as Array<{ dest: string; body: string }>);
  const availability = () => (readHumanAvailability("alex", home) as { availability?: string }).availability;
  return { db, home, clock, modes, jobFor, run, toOperator, availability };
}

describe("a mode's scheduled end", () => {
  it("ends at its time as \"scheduled\", puts back what was the mode's, and tells the kernel operator where the account goes", async () => {
    const f = fixture();
    f.db.prepare("INSERT INTO rigs (id, name) VALUES ('r-k', 'kernel')").run();
    f.db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-op', 'r-k', 'operator.agent')").run();
    f.db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('s-op', 'n-op', ?)").run(KERNEL_OPERATOR_SESSION);
    const app = f.modes.apply("alex", "asleep", { scheduledEnd: END }, "orch@rig").application!;
    const job = f.jobFor(app.applicationId)!;
    expect(await f.run(job.jobId, new Date("2026-10-21T06:59:00Z"))).toEqual({ state: "not-yet" });
    expect(f.modes.current("alex")?.applicationId).toBe(app.applicationId);
    expect(await f.run(job.jobId, new Date("2026-10-21T07:00:30Z"))).toEqual({ state: "ended", notified: KERNEL_OPERATOR_SESSION });
    expect(f.modes.get(app.applicationId)).toMatchObject({ endReason: "scheduled", endedAt: "2026-10-21T07:00:30.000Z", scheduledEnd: END.toISOString() });
    expect(f.availability()).toBe("focus");
    const [row] = f.toOperator();
    expect(row!.dest).toBe(KERNEL_OPERATOR_SESSION);
    expect(row!.body).toContain(`rig gateway human mode account alex ${app.applicationId}`);
    expect(row!.body).toContain("slack at seven");
    expect(row!.body).toContain("Applied by orch@rig.");
    expect(f.jobFor(app.applicationId)).toBeUndefined(); // retired
  });

  it("where the kernel operator isn't on this host, the seat that applied the mode is told when the queue accepts it, and the row says why", async () => {
    const f = fixture();
    f.db.prepare("INSERT INTO rigs (id, name) VALUES ('r-rig', 'rig')").run(); // orch@rig is a routable seat
    const app = f.modes.apply("alex", "asleep", { scheduledEnd: END }, "orch@rig").application!;
    expect(await f.run(f.jobFor(app.applicationId)!.jobId, END)).toEqual({ state: "ended", notified: "orch@rig" });
    expect(f.toOperator()[0]!.body).toContain(`Sent to orch@rig because ${KERNEL_OPERATOR_SESSION} isn't on this host.`);
  });

  it("applied by a named operator outside any seat, with no kernel operator here, the person is told, as an update", async () => {
    const f = fixture();
    const app = f.modes.apply("alex", "asleep", { scheduledEnd: END }, "op").application!;
    const jobId = f.jobFor(app.applicationId)!.jobId;
    expect(await f.run(jobId, END)).toEqual({ state: "ended", notified: "alex@external" });
    const row = f.db.prepare("SELECT destination_session AS dest, human_intent AS intent, body FROM queue_items WHERE source_session = 'daemon@kernel'").get() as Record<string, string>;
    expect(row).toMatchObject({ dest: "alex@external", intent: "update" });
    expect(row.body).toBe(`Your asleep ended at its scheduled time. Its account: \`rig gateway human mode account alex ${app.applicationId}\`; ask your operator to go through it.`);
    expect(new WatchdogJobsRepository(f.db).getById(jobId)).toMatchObject({ state: "terminal",
      terminalReason: `ended at its scheduled time; alex@external told (${KERNEL_OPERATOR_SESSION} isn't on this host, and op, who applied it, isn't an address the queue accepts)` });
  });

  it("a person registry that can't be read leaves the notice owed, not lost; once it reads again the person is told once", async () => {
    const f = fixture();
    const app = f.modes.apply("alex", "asleep", { scheduledEnd: END }, "op").application!;
    const jobId = f.jobFor(app.applicationId)!.jobId;
    const fragment = join(f.home, "gateway", "humans", "alex.yaml");
    const good = readFileSync(fragment, "utf8");
    writeFileSync(fragment, "entityId: [unclosed\n"); // briefly unreadable
    expect(await f.run(jobId, END)).toMatchObject({ state: "notice-pending", why: expect.stringContaining("the person registry couldn't be read") });
    expect(f.modes.get(app.applicationId)!.endReason).toBe("scheduled"); // the mode did end
    expect(f.jobFor(app.applicationId)?.jobId).toBe(jobId); // still active
    expect(f.toOperator()).toEqual([]);
    writeFileSync(fragment, good); // repaired
    expect(await f.run(jobId, new Date("2026-10-21T07:01:00Z"))).toEqual({ state: "ended", notified: "alex@external" });
    expect(f.toOperator().map((r) => r.dest)).toEqual(["alex@external"]);
    expect(f.jobFor(app.applicationId)).toBeUndefined();
  });

  it("a person no longer registered, with no one else to tell, ends the job saying why, and nothing happens after", async () => {
    const f = fixture();
    const app = f.modes.apply("alex", "asleep", { scheduledEnd: END }, "op").application!;
    const jobId = f.jobFor(app.applicationId)!.jobId;
    expect(removeHumanFragment("alex", { inflight: [] }, f.home).ok).toBe(true);
    expect(await f.run(jobId, END)).toEqual({ state: "ended", notified: undefined });
    const reason = `ended at its scheduled time; no notice: ${KERNEL_OPERATOR_SESSION} isn't on this host, op, who applied it, isn't an address the queue accepts, and alex isn't registered`;
    expect(new WatchdogJobsRepository(f.db).getById(jobId)).toMatchObject({ state: "terminal", terminalReason: reason });
    await f.run(jobId, new Date("2026-10-21T07:05:00Z")); // a second pass changes nothing
    expect(new WatchdogJobsRepository(f.db).getById(jobId)).toMatchObject({ state: "terminal", terminalReason: reason });
    expect(f.toOperator()).toEqual([]);
  });

  it("if telling the operator fails, the mode still ends, and the next run sends the one notice", async () => {
    const f = fixture();
    f.db.prepare("INSERT INTO rigs (id, name) VALUES ('r-rig', 'rig')").run();
    const app = f.modes.apply("alex", "asleep", { scheduledEnd: END }, "orch@rig").application!;
    const job = f.jobFor(app.applicationId)!;
    const failing = new QueueRepository(f.db, new EventBus(f.db));
    failing.create = async () => { throw new Error("database is locked (test)"); };
    expect(await f.run(job.jobId, END, failing)).toEqual({ state: "notice-pending" });
    expect(f.modes.get(app.applicationId)!.endReason).toBe("scheduled");
    expect(f.jobFor(app.applicationId)).toBeDefined(); // still owed
    expect(await f.run(job.jobId, new Date("2026-10-21T07:01:00Z"))).toEqual({ state: "ended", notified: "orch@rig" });
    expect(f.toOperator()).toHaveLength(1);
    expect(f.jobFor(app.applicationId)).toBeUndefined();
  });

  it("switched to another mode before its time: the old job retires and never ends the new mode", async () => {
    const f = fixture();
    const asleep = f.modes.apply("alex", "asleep", { scheduledEnd: END }, "orch@rig").application!;
    const job = f.jobFor(asleep.applicationId)!;
    const away = f.modes.apply("alex", "away-from-desk", {}, "orch@rig").application!;
    expect(await f.run(job.jobId, new Date("2026-10-21T07:05:00Z"))).toEqual({ state: "already-ended" });
    expect(f.modes.current("alex")?.applicationId).toBe(away.applicationId);
    expect(f.modes.get(asleep.applicationId)!.endReason).toBe("switched");
    expect(f.jobFor(asleep.applicationId)).toBeUndefined();
    expect(f.toOperator()).toEqual([]);
  });

  it("ended by hand first: nothing more happens at its time, and a manual choice made since stays", async () => {
    const f = fixture();
    const app = f.modes.apply("alex", "asleep", { scheduledEnd: END }, "orch@rig").application!;
    const job = f.jobFor(app.applicationId)!;
    f.modes.end("alex", "back", "alex");
    expect(setHumanField("alex", "availability", "off", f.home).ok).toBe(true);
    expect(await f.run(job.jobId, END)).toEqual({ state: "already-ended" });
    expect(f.modes.get(app.applicationId)!.endReason).toBe("back");
    expect(f.availability()).toBe("off");
  });

  it("while a mode waits to end, the watchdog records nothing each minute; a notice still owed is recorded", async () => {
    const f = fixture();
    const bus = new EventBus(f.db);
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e as { type: string }));
    const jobsRepo = new WatchdogJobsRepository(f.db);
    const historyLog = new WatchdogHistoryLog(f.db);
    const engine = new WatchdogPolicyEngine({ jobsRepo, historyLog, eventBus: bus, deliver: async () => ({ ok: true }) as never,
      additionalPolicies: [makeModeScheduledEndPolicy({ db: f.db, queueRepo: new QueueRepository(f.db, new EventBus(f.db), {
        validateRig: makeTopologyDestinationCheck({ findRigsByName: (name) => new RigRepository(f.db).findRigsByName(name), loadHumanRegistry: () => loadHumanRegistry(f.home) }),
      }), jobsRepo, home: f.home })] } as never);
    const later = f.modes.apply("alex", "asleep", { scheduledEnd: new Date("2099-01-01T07:00:00Z") }, "orch@rig").application!;
    const waiting = f.jobFor(later.applicationId)!;
    await engine.evaluate(waiting);
    await engine.evaluate(jobsRepo.getById(waiting.jobId)!);
    expect(historyLog.countForJob(waiting.jobId)).toBe(0);
    expect(events.filter((e) => e.type.startsWith("watchdog."))).toEqual([]);

    f.modes.end("alex", "back", "alex");
    const app = f.modes.apply("alex", "asleep", { scheduledEnd: END }, "op").application!; // END has passed by the wall clock
    const owed = f.jobFor(app.applicationId)!;
    writeFileSync(join(f.home, "gateway", "humans", "alex.yaml"), "entityId: [unclosed\n"); // the notice can't be addressed yet
    await engine.evaluate(owed);
    expect(historyLog.countForJob(owed.jobId)).toBe(1);
    expect(events.some((e) => e.type === "watchdog.evaluation_skipped")).toBe(true);
  });
});
