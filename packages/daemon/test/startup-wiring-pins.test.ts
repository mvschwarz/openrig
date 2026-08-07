// P16 — STARTUP-WIRING PIN GRADUATION (the UNINJECTED-SERVICE class, twice
// recurred: validateRig-uninjected + the dead occupant-invalidator). A service
// with an optional safety dep passes every unit test while production startup
// silently never injects it — the feature is OFF in prod and nothing notices.
//
// These pins drive the REAL createDaemon composition ONCE and assert, per
// SAFETY-classified optional dep, that the production injection actually
// happened. A pin here failing means a startup edit un-wired a safety feature.
//
// The census (P16 sweep, 2026-08-07) also found FIVE deps that are UNINJECTED
// TODAY — those are it.todo ledger entries at the bottom (routed to the desk as
// findings; a passing pin would freeze the defect). When a finding's fix lands,
// its todo graduates to a real pin.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon } from "../src/startup.js";
import type { AppDeps } from "../src/server.js";
import type { CmuxTransportFactory } from "../src/terminal/cmux-transport.js";
import type { ExecFn } from "../src/domain/tmux-adapter.js";
import type Database from "better-sqlite3";
import type { ContextMonitor } from "../src/domain/context-monitor.js";

let db: Database.Database;
let deps: AppDeps;
let contextMonitor: ContextMonitor;
let scratch: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // D15 isolation: the composition writes real state — anchor it in scratch.
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "p16-wiring-"));
  for (const k of ["OPENRIG_HOME", "OPENRIG_DB", "OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_NO_KERNEL"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.OPENRIG_HOME = path.join(scratch, "home");
  process.env.OPENRIG_DB = path.join(scratch, "wiring.sqlite");
  delete process.env.OPENRIG_URL;
  delete process.env.OPENRIG_PORT;
  process.env.OPENRIG_NO_KERNEL = "1";
  const cmuxFactory: CmuxTransportFactory = async () => {
    throw Object.assign(new Error("no socket"), { code: "ENOENT" });
  };
  const tmuxExec: ExecFn = async () => "";
  // production passes the RESOLVED file dbPath (index.ts) — :memory: is the
  // test-friendly default that deliberately skips the slow-op recorder; the
  // wiring pin must compose like production.
  const result = await createDaemon({ cmuxFactory, tmuxExec, dbPath: process.env.OPENRIG_DB! });
  db = result.db;
  deps = result.deps;
  contextMonitor = result.contextMonitor;
}, 60000);

afterAll(() => {
  db?.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Reach a private field for a WIRING assertion (presence, never behavior). */
function priv<T>(obj: unknown, key: string): T {
  return (obj as Record<string, T>)[key] as T;
}

describe("P16 — AppDeps members with safety semantics are composed (definedness pins)", () => {
  const MEMBERS: Array<keyof AppDeps> = [
    "queueRepo", "inboxHandler", "outboxHandler", "sessionTransport",
    "transcriptStore", "providerService", "seatIdentityReconciler",
    "seatActivityService", "watchdogJobsRepo", "watchdogHistoryLog",
    "watchdogPolicyEngine", "watchdogScheduler", "periodicSnapshotScheduler",
    "workflowRuntime", "selfAttachService", "rigLifecycleService",
    "resumeMetadataRefresher", "runtimeAdapters",
    "streamStore", "askService", "wakeResolveService", "projectClassifier",
    "classifierLeaseManager", "viewProjector", "tmuxOptionDefaults",
  ];
  for (const member of MEMBERS) {
    it(`deps.${String(member)} is constructed by production startup`, () => {
      expect(deps[member], `AppDeps.${String(member)} must be composed by createDaemon`).toBeDefined();
    });
  }
});

describe("P16 — domain-internal safety injections (the recurred class, pinned at the wire)", () => {
  it("QueueRepository.validateRig is the topology gate, not the permissive default (recurrence #1)", async () => {
    // behavioral probe through the composed object: an unknown-rig destination must refuse.
    await expect(
      deps.queueRepo!.create({
        sourceSession: "a@known-nowhere",
        destinationSession: "b@definitely-unregistered-rig",
        body: "wiring probe",
      } as never),
    ).rejects.toThrow(/unknown rig/);
  });

  it("QueueRepository.workflowFrontierPredicate is injected (the close-path guard)", () => {
    expect(priv(deps.queueRepo, "workflowFrontierPredicate")).toBeTruthy();
  });

  it("SessionTransport carries the eventBus (dangerous-override audit fails closed without it)", () => {
    expect(priv(deps.sessionTransport, "eventBus")).toBeTruthy();
  });

  it("SessionTransport carries the slow-op recorder (composed conditionally at startup:238 — a real-db daemon must have it)", () => {
    expect(priv(deps.sessionTransport, "slowOpRecorder")).toBeTruthy();
  });

  it("ContextMonitor carries the compaction enforcer (threshold->action detector)", () => {
    expect(priv(contextMonitor, "compactionEnforcer")).toBeTruthy();
  });

  it.todo("51-08 (graduates at the slice fold): ContextMonitor carries usageSamples + providerWindowSampler — pin flips live when hv/51-08-telemetry lands; asserting now would pin a wiring main does not yet carry");

  it("ClassifierLeaseManager.isAlive is attached post-construction (the lease-liveness seam)", () => {
    expect(priv(deps.classifierLeaseManager, "isAlive")).toBeTruthy();
  });

  it("QueueRepository transport is attached post-construction (the wake path)", () => {
    expect(priv(deps.queueRepo, "transport")).toBeTruthy();
  });
});

describe("P16 — UNINJECTED-SERVICE findings ledger (routed to desk; todo graduates to a pin when the fix lands)", () => {
  it.todo("FINDING A1: SeatHandoverService.occupantInvalidator UNINJECTED (routes/seat.ts construction) — every handover commits with zero state invalidation; ghost-stage atom-B lane owns the impl");
  it.todo("FINDING A2: projection-planner resolveTargetPath UNINJECTED (rigspec-instantiator.ts:1672) — hash_conflict classification dead; operator-modified files silently overwritten");
  it.todo("FINDING A3: InboxHandler.authenticate UNINJECTED (startup.ts:950) — sender-spoofing gate is allow-all; route forwards client-supplied authenticatedSender");
  it.todo("FINDING A4: WorkflowValidator seatLivenessCheck never constructed — role_no_live_preferred_target advisory dead; instances stall at step 1 unwarned");
  it("A5 GRADUATED (P19): AskService's PsProjectionService carries seatActivity — one terminalActive truth across both paths", () => {
    const ps = priv<unknown>(deps.askService, "deps") as { psProjectionService: unknown };
    expect(priv(ps.psProjectionService, "seatActivity"), "the ask path must inject seatActivity like the attention path does").toBeTruthy();
  });

  it("SLOW-OP REQUEST MIDDLEWARE WIRED: server.ts app.use's the createSlowOpRequestMiddleware seam", () => {
    // The middleware CONTRACT moved to hermetic unit tests (slow-op-recorder.test), which cannot cover
    // 'the real server actually uses this middleware' — the uninjected-service enable-path gap. This pin
    // closes it at the source: the seam must be imported AND app.use'd (an import alone leaves the
    // request observer dead in prod).
    const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(src, "server.ts must import the extracted seam").toContain("createSlowOpRequestMiddleware");
    expect(src, "server.ts must app.use the seam, not just import it").toMatch(
      /app\.use\(\s*["']\*["']\s*,\s*createSlowOpRequestMiddleware\(/,
    );
  });
});
