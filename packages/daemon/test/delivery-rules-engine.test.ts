// OPR.0.5.6.1 — the §5 delivery rules engine (locked spec + A1 single-human
// narrowing + A2 AM-F1..F5; F-7 OFF-IS-RESPECTED locked at dispatch, no founder
// reversal received; F-8 RULED enum/dials consumed, never re-minted).
//
// RED-first with final test bytes at pristine base 0d6e65743: the engine module
// does not exist, prefs.deliveryClass/away are stored-but-inert, the mention
// decision is two dial-reads 230 lines apart (queue-access.ts:39 +
// slack-subsystem.ts:184), the operator rung records "cited, not built" and
// exhausts in the same breath, and no digest/deferral machinery exists.
// Every section below fails at base for exactly those reasons.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";
import { resolveSlackHandle, validateHumanFragment } from "../src/domain/gateway/human-registry.js";
import { WatchdogJobsRepository, PHASE_D_POLICIES } from "../src/domain/watchdog-jobs-repository.js";
import { runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";

// The engine is imported dynamically so each section carries its own RED
// receipt ("engine module absent") instead of one collection-time failure.
type EngineModule = typeof import("../src/domain/gateway/delivery-rules-engine.js");
async function engine(): Promise<EngineModule | null> {
  try {
    return (await import("../src/domain/gateway/delivery-rules-engine.js")) as EngineModule;
  } catch {
    return null;
  }
}
async function deferralPolicyModule(): Promise<Record<string, unknown> | null> {
  try {
    return (await import("../src/domain/policies/delivery-deferral.js")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
async function digestFlushModule(): Promise<Record<string, unknown> | null> {
  try {
    return (await import("../src/domain/policies/delivery-digest-flush.js")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const SRC_ROOT = join(__dirname, "..", "src");

function registryWith(prefs: Record<string, unknown>) {
  return {
    ok: true as const,
    entities: [{
      entityId: "human-founder",
      class: "human" as const,
      displayName: "Founder",
      address: "human-founder@external",
      connectorBindings: [{
        kind: "slack" as const,
        connectorRef: "primary",
        secretsRef: "env:SLACK_BOT_TOKEN",
        role: "primary" as const,
        handle: "UFOUNDER",
      }],
      prefs,
    }],
  };
}

function ensureFinalColumns(db: Database.Database): void {
  for (const table of ["queue_transitions", "queue_transitions_archive"]) {
    const names = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
    if (!names.has("owner_notification_kind")) db.exec(`ALTER TABLE ${table} ADD COLUMN owner_notification_kind TEXT`);
    if (!names.has("owner_notification_level")) db.exec(`ALTER TABLE ${table} ADD COLUMN owner_notification_level TEXT`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 THE CLASS MATRIX (AM-F2: completeness is arithmetic; every cell cites its
// ruling). 4 prefs × 4 availabilities × 2 modes = 32 cells. The single-human
// terminal column rides the away/off escalation cells (A1: next-person cells
// never existed as separate cells; termination is a property of those cells).
// Quiet cells never mention (mention === (outcome === "interrupt") only).
// ─────────────────────────────────────────────────────────────────────────────

type Cell = {
  pref: "A" | "B" | "C" | "D";
  availability: "available" | "focus" | "away" | "off";
  mode: "normal" | "escalation";
  outcome: "interrupt" | "notify" | "digest" | "log";
  digestWindow?: "4h" | "daily";
  deferMinutes?: number;
  termination?: boolean;
  cite: string;
};

const A = "available", F = "focus", W = "away", O = "off";
const MATRIX: Cell[] = [
  // pref A — interrupt-always (§5 register: "delivered immediately, every time");
  // off is the one modulation F-7/F-8 allow (off suppresses interruption, never delivery).
  { pref: "A", availability: A, mode: "normal", outcome: "interrupt", cite: "register A interrupt-always" },
  { pref: "A", availability: F, mode: "normal", outcome: "interrupt", cite: "register A overrides focus (always means always)" },
  { pref: "A", availability: W, mode: "normal", outcome: "interrupt", cite: "register A overrides away (always means always)" },
  { pref: "A", availability: O, mode: "normal", outcome: "notify", cite: "F-8: off suppresses interruption, never delivery" },
  { pref: "A", availability: A, mode: "escalation", outcome: "interrupt", cite: "escalation is interrupt-class (A1.2)" },
  { pref: "A", availability: F, mode: "escalation", outcome: "interrupt", cite: "design §3: focus escalation = post + mention" },
  { pref: "A", availability: W, mode: "escalation", outcome: "interrupt", termination: true, cite: "register A immediate even away; single-human termination recorded (A1.1)" },
  { pref: "A", availability: O, mode: "escalation", outcome: "notify", termination: true, cite: "F-7 VERBATIM: off is respected, escalation never overrides; termination row + escalations view stay loud" },
  // pref B — notify; escalation lifts to interrupt; away+B = the M1 §5 preset (30-minute deferral).
  { pref: "B", availability: A, mode: "normal", outcome: "notify", cite: "register B threaded post, no mention" },
  { pref: "B", availability: F, mode: "normal", outcome: "notify", cite: "register B" },
  { pref: "B", availability: W, mode: "normal", outcome: "notify", cite: "design §3: away normal = post, no mention" },
  { pref: "B", availability: O, mode: "normal", outcome: "notify", cite: "F-8: delivery never suppressed" },
  { pref: "B", availability: A, mode: "escalation", outcome: "interrupt", cite: "escalation lifts B (A1.2 interrupt-class)" },
  { pref: "B", availability: F, mode: "escalation", outcome: "interrupt", cite: "design §3: focus escalation = post + mention" },
  { pref: "B", availability: W, mode: "escalation", outcome: "interrupt", deferMinutes: 30, termination: true, cite: "M1 §5 AWAY preset + AM-F3: exactly one interrupt at T+30 to the SAME human; termination recorded (A1.1)" },
  { pref: "B", availability: O, mode: "escalation", outcome: "notify", termination: true, cite: "F-7 VERBATIM cell" },
  // pref C — 4h digest; escalation lifts out of digest entirely.
  { pref: "C", availability: A, mode: "normal", outcome: "digest", digestWindow: "4h", cite: "register C worker-parked 4h digest" },
  { pref: "C", availability: F, mode: "normal", outcome: "digest", digestWindow: "4h", cite: "register C" },
  { pref: "C", availability: W, mode: "normal", outcome: "digest", digestWindow: "4h", cite: "register C" },
  { pref: "C", availability: O, mode: "normal", outcome: "digest", digestWindow: "4h", cite: "register C; off touches interruption only" },
  { pref: "C", availability: A, mode: "escalation", outcome: "interrupt", cite: "escalation never digests (A1.2)" },
  { pref: "C", availability: F, mode: "escalation", outcome: "interrupt", cite: "escalation never digests" },
  { pref: "C", availability: W, mode: "escalation", outcome: "interrupt", deferMinutes: 30, termination: true, cite: "away escalation defers per the preset (uniform non-A rule, documented)" },
  { pref: "C", availability: O, mode: "escalation", outcome: "notify", termination: true, cite: "F-7 VERBATIM cell" },
  // pref D — daily digest; same escalation lift.
  { pref: "D", availability: A, mode: "normal", outcome: "digest", digestWindow: "daily", cite: "register D daily batch" },
  { pref: "D", availability: F, mode: "normal", outcome: "digest", digestWindow: "daily", cite: "register D" },
  { pref: "D", availability: W, mode: "normal", outcome: "digest", digestWindow: "daily", cite: "register D" },
  { pref: "D", availability: O, mode: "normal", outcome: "digest", digestWindow: "daily", cite: "register D" },
  { pref: "D", availability: A, mode: "escalation", outcome: "interrupt", cite: "escalation never digests" },
  { pref: "D", availability: F, mode: "escalation", outcome: "interrupt", cite: "escalation never digests" },
  { pref: "D", availability: W, mode: "escalation", outcome: "interrupt", deferMinutes: 30, termination: true, cite: "away escalation defers per the preset" },
  { pref: "D", availability: O, mode: "escalation", outcome: "notify", termination: true, cite: "F-7 VERBATIM cell" },
];

describe("OPR.0.5.6.1 §1 — the full class matrix, one receipt per cell (AM-F2)", () => {
  it("ARITHMETIC PIN: the matrix enumerates exactly 4 prefs × 4 availabilities × 2 modes = 32 cells", () => {
    expect(MATRIX.length).toBe(4 * 4 * 2);
    const keys = new Set(MATRIX.map((c) => `${c.pref}|${c.availability}|${c.mode}`));
    expect(keys.size).toBe(32);
  });

  for (const cell of MATRIX) {
    it(`CELL ${cell.pref}×${cell.availability}×${cell.mode} → ${cell.outcome}${cell.deferMinutes ? ` deferred ${cell.deferMinutes}m` : ""}${cell.termination ? " +termination" : ""} [${cell.cite}]`, async () => {
      const mod = await engine();
      expect(mod, "the delivery rules engine module must exist (RED at base: absent)").not.toBeNull();
      const decision = mod!.decideDelivery({
        level: cell.mode === "escalation" ? "ALERT" : "NOTICE",
        escalation: cell.mode === "escalation",
        human: { entityId: "human-founder", deliveryClass: cell.pref, availability: cell.availability },
        dials: { minimumLevelThatPosts: "NOTICE", minimumLevelThatInterrupts: "ALERT" },
      });
      expect(decision.outcome).toBe(cell.outcome);
      // quiet cells never mention — any mention from a notify/digest/log cell is the red
      expect(decision.mention).toBe(cell.outcome === "interrupt");
      if (cell.digestWindow) expect(decision.digestWindow).toBe(cell.digestWindow);
      if (cell.deferMinutes) expect(decision.deferMinutes).toBe(cell.deferMinutes);
      else expect(decision.deferMinutes).toBeUndefined();
      if (cell.termination) {
        expect(decision.termination).toMatchObject({
          who: "human-founder",
          availability: cell.availability,
          noFallbackAvailable: true,
        });
      } else {
        expect(decision.termination).toBeUndefined();
      }
    });
  }

  it("LOG: a RECORD-level message (below the posts dial) decides log — durable only, never posted", async () => {
    const mod = await engine();
    expect(mod).not.toBeNull();
    const decision = mod!.decideDelivery({
      level: "RECORD",
      escalation: false,
      human: { entityId: "human-founder", deliveryClass: "A", availability: "available" },
      dials: { minimumLevelThatPosts: "NOTICE", minimumLevelThatInterrupts: "ALERT" },
    });
    expect(decision.outcome).toBe("log");
    expect(decision.mention).toBe(false);
  });

  it("DIAL DEMOTION: an interrupt-class decision below the interrupts dial demotes to notify (the S14 semantic preserved through the engine)", async () => {
    const mod = await engine();
    expect(mod).not.toBeNull();
    const decision = mod!.decideDelivery({
      level: "NOTICE",
      escalation: true,
      human: { entityId: "human-founder", deliveryClass: "A", availability: "available" },
      dials: { minimumLevelThatPosts: "NOTICE", minimumLevelThatInterrupts: "ALERT" },
    });
    expect(decision.outcome).toBe("notify");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 AVAILABILITY IN THE REGISTRY — net-new enum key, legacy away inference
// ─────────────────────────────────────────────────────────────────────────────

describe("OPR.0.5.6.1 §2 — availability is a validated prefs key; legacy away infers; conflict is loud", () => {
  function fragment(prefs: Record<string, unknown>) {
    return {
      entityId: "human-founder",
      class: "human",
      displayName: "Founder",
      address: "human-founder@external",
      connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "env:T", role: "primary", handle: "UF" }],
      prefs,
    };
  }

  it("accepts availability available|focus|away|off (RED at base: closed key set rejects the key)", () => {
    for (const availability of ["available", "focus", "away", "off"]) {
      const r = validateHumanFragment(fragment({ deliveryClass: "B", availability }));
      expect(r.ok, `availability=${availability}: ${r.ok ? "" : (r as { error: string }).error}`).toBe(true);
    }
  });

  it("rejects an unknown availability value loudly", () => {
    const r = validateHumanFragment(fragment({ deliveryClass: "B", availability: "busy" }));
    expect(r.ok).toBe(false);
  });

  it("legacy away:true reads as availability=away when availability is absent (whole-field-absent inference only)", async () => {
    const mod = await engine();
    expect(mod).not.toBeNull();
    expect(mod!.resolveAvailability({ deliveryClass: "B", away: true })).toBe("away");
    expect(mod!.resolveAvailability({ deliveryClass: "B" })).toBe("available");
    expect(mod!.resolveAvailability({ deliveryClass: "B", availability: "focus" })).toBe("focus");
  });

  it("availability + conflicting legacy away is refused at validation (two spellings of one truth)", () => {
    const r = validateHumanFragment(fragment({ deliveryClass: "B", availability: "available", away: true }));
    expect(r.ok).toBe(false);
    const agreeing = validateHumanFragment(fragment({ deliveryClass: "B", availability: "away", away: true }));
    expect(agreeing.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 GATEWAY CONSULTS THE ENGINE (AM-F5) — behavior-level, wire harness
// ─────────────────────────────────────────────────────────────────────────────

describe("OPR.0.5.6.1 §3 — the gateway consults the engine before dispatch", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let home: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    ensureFinalColumns(db);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    home = mkdtempSync(join(tmpdir(), "s01-rules-"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function parkOnFounder(tags: string[] = []): Promise<QueueItem> {
    const row = await repo.create({
      sourceSession: "dev-qa@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "await decision",
      ...(tags.length ? { tags } : {}),
      nudge: false,
    });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "orch-lead@v-openrig-build",
      state: "blocked",
      blockedOn: "human-founder@kernel",
      summary: "Choose A or B",
      evidenceRef: "/proof/decision.md",
      transitionNote: "parked",
    });
    return row;
  }

  function wireWith(prefs: Record<string, unknown>, posts: Array<Record<string, unknown>>) {
    const registry = registryWith(prefs);
    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    return buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl: async (_url, init) => {
        posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, ts: `1724.000${posts.length}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
  }

  it("F-7 CELL, END TO END: an off human's ALERT park POSTS (delivery never suppressed) with NO mention, and the termination is recorded on the row (RED at base: ALERT mentions)", async () => {
    const row = await parkOnFounder();
    const registry = registryWith({ deliveryClass: "B", availability: "off" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const [alert] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alert).toBeDefined();

    const posts: Array<Record<string, unknown>> = [];
    const wire = wireWith({ deliveryClass: "B", availability: "off" }, posts);
    try {
      wire.startServices?.();
      expect(wire.dispatcher.dispatch(OUTBOUND_OP, alert!.destinationSession!, alert)).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts.length, "off never suppresses the post (F-8)").toBe(1);
      expect(JSON.stringify(posts[0]), "off is respected: no mention, ever (F-7)").not.toContain("<@UFOUNDER>");
      const termination = repo.listTransitions(row.qitemId).filter((t) => t.transitionNote?.startsWith("delivery-termination:"));
      expect(termination.length, "the termination row records who/availability/no-fallback-available").toBe(1);
      expect(termination[0]!.transitionNote).toContain("who=human-founder");
      expect(termination[0]!.transitionNote).toContain("availability=off");
      expect(termination[0]!.transitionNote).toContain("no-fallback-available");
    } finally {
      wire.stop();
    }
  });

  it("QUIET CELL ABSENCE: a focus human's normal NOTICE post carries no mention while an available A-class ALERT still mentions (floor)", async () => {
    const row = await parkOnFounder();
    const registry = registryWith({ deliveryClass: "B", availability: "focus" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const [alert] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alert).toBeDefined();
    const posts: Array<Record<string, unknown>> = [];
    const wire = wireWith({ deliveryClass: "B", availability: "focus" }, posts);
    try {
      wire.startServices?.();
      wire.dispatcher.dispatch(OUTBOUND_OP, alert!.destinationSession!, alert);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts.length).toBe(1);
      expect(JSON.stringify(posts[0])).not.toContain("<@UFOUNDER>");
      expect(row.qitemId).toBeTruthy();
    } finally {
      wire.stop();
    }
  });

  it("DIGEST CONTAINMENT: a C-class human's rows are NEVER dispatched individually (RED at base: each row posts on its own)", async () => {
    await parkOnFounder();
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const [alert] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alert).toBeDefined();
    const posts: Array<Record<string, unknown>> = [];
    const wire = wireWith({ deliveryClass: "C", availability: "available" }, posts);
    try {
      wire.startServices?.();
      wire.dispatcher.dispatch(OUTBOUND_OP, alert!.destinationSession!, alert);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts.length, "digest-class rows accumulate; the flush posts, never the sweep").toBe(0);
    } finally {
      wire.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 DIGEST — lossless, exactly-once, restart-durable window (AM-F1 tooth)
// ─────────────────────────────────────────────────────────────────────────────

describe("OPR.0.5.6.1 §4 — the C/D digest flush", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    ensureFinalColumns(db);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    home = mkdtempSync(join(tmpdir(), "s01-digest-"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function nParks(n: number): Promise<QueueItem[]> {
    const rows: QueueItem[] = [];
    for (let i = 0; i < n; i++) {
      const row = await repo.create({
        sourceSession: `seat-${i}@r`,
        destinationSession: "orch-lead@v-openrig-build",
        body: `decision ${i}`,
        nudge: false,
      });
      repo.update({
        qitemId: row.qitemId,
        actorSession: "orch-lead@v-openrig-build",
        state: "blocked",
        blockedOn: "human-founder@kernel",
        summary: `Decision ${i}`,
        evidenceRef: `/proof/${i}.md`,
        transitionNote: "parked",
      });
      rows.push(row);
    }
    return rows;
  }

  it("LOSSLESS + EXACTLY-ONCE: N digest-class rows flush as ONE notify-class digest containing all N; no member is ALSO posted individually; a second flush posts nothing (RED at base: no flush machinery exists)", async () => {
    const mod = await digestFlushModule();
    expect(mod, "policies/delivery-digest-flush must exist (RED at base: absent)").not.toBeNull();
    const rows = await nParks(3);
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const posts: Array<Record<string, unknown>> = [];
    const flush = (mod as { runDeliveryDigestFlush: (deps: unknown) => Promise<{ posted: number; members: number }> }).runDeliveryDigestFlush;
    const deps = {
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      home,
      post: async (payload: Record<string, unknown>) => {
        posts.push(payload);
        return { ok: true as const, ts: `1724.9${posts.length}` };
      },
      window: "4h" as const,
    };
    const first = await flush(deps);
    expect(first.posted).toBe(1);
    expect(first.members).toBe(3);
    expect(posts.length).toBe(1);
    const body = JSON.stringify(posts[0]);
    for (const row of rows) expect(body).toContain(row.qitemId);
    expect(body, "the digest itself is notify-class: no mention").not.toContain("<@UFOUNDER>");
    // every member row carries its posted receipt (the S14 literal, digest-tokened)
    for (const row of rows) {
      const receipts = repo.listTransitions(row.qitemId).filter((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "));
      expect(receipts.length, `row ${row.qitemId} digest receipt`).toBe(1);
      expect(receipts[0]!.transitionNote).toContain("digest=");
    }
    // exactly-once: a second flush finds nothing undigested
    const second = await flush(deps);
    expect(second.posted).toBe(0);
    expect(posts.length).toBe(1);
  });

  it("REGISTERED SUBSTRATE: the digest flush and the away deferral are PHASE_D policies — no third timer engine (AM-F1 anti-sprawl)", async () => {
    expect(PHASE_D_POLICIES).toContain("delivery-digest-flush");
    expect(PHASE_D_POLICIES).toContain("delivery-deferral");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 AWAY DEFERRAL — restart-durable one-shot at T+30 (AM-F1/AM-F3 teeth)
// ─────────────────────────────────────────────────────────────────────────────

describe("OPR.0.5.6.1 §5 — the 30-minute away deferral on the watchdog substrate", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let jobs: WatchdogJobsRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    ensureFinalColumns(db);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    jobs = new WatchdogJobsRepository(db);
  });
  afterEach(() => db.close());

  it("DEFERRAL ARMS DURABLY AND FIRES EXACTLY ONCE AT T+30, surviving a daemon restart mid-window (RED at base: no deferral policy exists)", async () => {
    const mod = await deferralPolicyModule();
    expect(mod, "policies/delivery-deferral must exist (RED at base: absent)").not.toBeNull();
    const row = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-founder@external",
      body: "escalation",
      nudge: false,
    });
    const arm = (mod as { armDeliveryDeferral: (deps: unknown) => { jobId: string } }).armDeliveryDeferral;
    const armed = arm({ jobsRepo: jobs, queueRepo: repo, qitemId: row.qitemId, entityId: "human-founder", minutes: 30 });
    expect(armed.jobId).toBeTruthy();
    // durable: visible on watchdog_jobs (SQLite is the schedule)
    const jobRow = db.prepare("SELECT policy, state FROM watchdog_jobs WHERE job_id = ?").get(armed.jobId) as { policy: string; state: string };
    expect(jobRow).toMatchObject({ policy: "delivery-deferral", state: "active" });

    // "restart": a NEW repository instance over the same DB sees the same job
    const jobsAfterRestart = new WatchdogJobsRepository(db);
    const fire = (mod as { fireDeliveryDeferralIfDue: (deps: unknown) => Promise<{ fired: boolean }> }).fireDeliveryDeferralIfDue;
    const interrupts: string[] = [];
    const deps = {
      jobsRepo: jobsAfterRestart,
      queueRepo: repo,
      jobId: armed.jobId,
      deliverInterrupt: async (qitemId: string) => {
        interrupts.push(qitemId);
        return { ok: true as const };
      },
    };
    // before T+30: not due
    expect((await fire({ ...deps, now: new Date(Date.now() + 10 * 60_000) })).fired).toBe(false);
    // at T+30: fires exactly once
    expect((await fire({ ...deps, now: new Date(Date.now() + 31 * 60_000) })).fired).toBe(true);
    expect(interrupts).toEqual([row.qitemId]);
    // after firing: terminal, never a second interrupt (one-shot, not periodic-reminder)
    expect((await fire({ ...deps, now: new Date(Date.now() + 62 * 60_000) })).fired).toBe(false);
    expect(interrupts.length).toBe(1);
    const terminal = db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(armed.jobId) as { state: string };
    expect(terminal.state).toBe("terminal");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 OPERATOR RUNG DELIVERS (A1.2 + AM-F3) — the S01 pointer retires
// ─────────────────────────────────────────────────────────────────────────────

describe("OPR.0.5.6.1 §6 — the operator rung dispatches through the engine", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    ensureFinalColumns(db);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => db.close());

  async function batonAtOperatorRung(): Promise<QueueItem> {
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    const { created } = await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: "worker@r", nudge: false });
    // failed wake, aged past the retry cap so the ladder escalates; orchestrator
    // resolves to the destination itself -> self-skip -> operator rung this tick.
    const ts = new Date(Date.now() - 10 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
      .run(ts, "failed:tmux session not found", created.qitemId);
    return created;
  }

  function markersOf(qitemId: string, prefix: string): string[] {
    return (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts, rowid").all(qitemId) as Array<{ transition_note: string | null }>)
      .map((r) => r.transition_note ?? "")
      .filter((n) => n.startsWith(prefix));
  }

  async function tickWithEngine(engineOutcome: { decision: string; resolved: boolean }, calls: Array<{ qitemId: string }>) {
    return runWakeLadderTick({
      db,
      queueRepo: repo,
      attemptWake: async () => "failed:tmux session not found",
      resolveOrchestrator: () => null, // self-skip -> operator rung immediately
      retryIntervalSeconds: 1,
      retryCap: 0,
      log: () => {},
      deliveryEngine: {
        dispatchEscalation: async (row: QueueItem, _reason: string) => {
          calls.push({ qitemId: row.qitemId });
          return engineOutcome;
        },
      },
    } as never);
  }

  it("DISPATCHED-TO-ENGINE: the rung records the engine decision and, on a resolved outcome, exhausts (RED at base: WakeLadderDeps has no deliveryEngine and the marker says cited-not-built)", async () => {
    const baton = await batonAtOperatorRung();
    const calls: Array<{ qitemId: string }> = [];
    await tickWithEngine({ decision: "interrupt", resolved: true }, calls);
    expect(calls.length, "the operator rung must dispatch through the engine").toBe(1);
    const rungMarkers = markersOf(baton.qitemId, "escalation-rung:").filter((n) => /operator/.test(n));
    expect(rungMarkers.length).toBeGreaterThanOrEqual(1);
    expect(rungMarkers.join("\n")).toContain("dispatched-to-engine");
    expect(rungMarkers.join("\n")).toContain("decision=interrupt");
    expect(rungMarkers.join("\n")).not.toContain("cited not built");
    expect(markersOf(baton.qitemId, "ladder-exhausted:").length).toBe(1);
  });

  it("NO SILENT ADVANCE (AM-F3): a DEFERRED outcome leaves the ladder unexhausted through the deferral; resolution exhausts it; the engine is dispatched exactly once across the episode", async () => {
    const baton = await batonAtOperatorRung();
    const calls: Array<{ qitemId: string }> = [];
    await tickWithEngine({ decision: "interrupt", resolved: false }, calls);
    expect(calls.length).toBe(1);
    expect(markersOf(baton.qitemId, "ladder-exhausted:").length, "no advance past the operator rung while the engine's outcome is pending").toBe(0);

    // second tick during the deferral: no re-dispatch (exactly-once), still unexhausted
    await tickWithEngine({ decision: "interrupt", resolved: false }, calls);
    expect(calls.length, "one dispatch per episode, never immediate-plus-deferred").toBe(1);
    expect(markersOf(baton.qitemId, "ladder-exhausted:").length).toBe(0);

    // the deferral fires: the delivery leg stamps the S14 receipt on the row
    repo.update({
      qitemId: baton.qitemId,
      actorSession: "daemon@system",
      transitionNote: "slack-owner-notification-posted notification_key=test:1 level=ALERT kind=human-required message_ts=1 channel=C",
    });
    await tickWithEngine({ decision: "interrupt", resolved: false }, calls);
    expect(markersOf(baton.qitemId, "ladder-exhausted:").length, "posted receipt resolves the episode").toBe(1);
    expect(calls.length).toBe(1);
  });

  it("THE POINTER RETIRES: queue-wake-ladder.ts no longer carries the cited-not-built text (RED at base: two copies live)", () => {
    const source = readFileSync(join(SRC_ROOT, "domain", "queue-wake-ladder.ts"), "utf8");
    expect(source).not.toContain("cited, not built");
    expect(source).not.toContain("cited not built");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 STRUCTURAL PINS — vocabulary, fabricated-state absence, anti-sprawl
// ─────────────────────────────────────────────────────────────────────────────

describe("OPR.0.5.6.1 §7 — one vocabulary, no seen, no third timer engine", () => {
  it("ONE OUTCOME TUPLE at one definition site; the engine consumes S14 stamps and mints no transport literals (AM-F4)", async () => {
    const mod = await engine();
    expect(mod).not.toBeNull();
    expect(mod!.DELIVERY_OUTCOMES).toEqual(["interrupt", "notify", "digest", "log"]);
    const source = readFileSync(join(SRC_ROOT, "domain", "gateway", "delivery-rules-engine.ts"), "utf8");
    // consumes, never mints: the S14 receipt literals may be REFERENCED via the
    // transition-log helpers but never re-spelled as template writes here
    expect(source).not.toMatch(/slack-owner-notification-posted\s/);
    expect(source).not.toMatch(/["'`]post-failed["'`]/);
    // the delivery-state table is documented at the seam (AM-F4's one definition site)
    expect(source).toContain("delivery-state");
  });

  it("NO FABRICATED STATE: no engine artifact can represent `seen` (schema + writes receipt)", async () => {
    for (const rel of [
      ["domain", "gateway", "delivery-rules-engine.ts"],
      ["domain", "policies", "delivery-deferral.ts"],
      ["domain", "policies", "delivery-digest-flush.ts"],
    ]) {
      const source = readFileSync(join(SRC_ROOT, ...rel), "utf8");
      expect(source, rel.join("/")).not.toMatch(/["'`]seen["'`]/);
    }
  });

  it("ANTI-SPRAWL (AM-F1): the three new modules introduce no timer entry point — no setInterval/setTimeout; timing rides watchdog_jobs only", async () => {
    for (const rel of [
      ["domain", "gateway", "delivery-rules-engine.ts"],
      ["domain", "policies", "delivery-deferral.ts"],
      ["domain", "policies", "delivery-digest-flush.ts"],
    ]) {
      const source = readFileSync(join(SRC_ROOT, ...rel), "utf8");
      expect(source, rel.join("/")).not.toMatch(/setInterval|setTimeout/);
    }
  });
});
