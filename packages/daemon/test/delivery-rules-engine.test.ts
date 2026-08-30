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
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
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

/** Instrument fix (visible, W2 findings 5-7): the structural pins grep CODE,
 *  not documentation — the module docs legitimately NAME the banned literals
 *  ("post-failed does not exist", "no setInterval anywhere here"). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

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
        // Fixture correction (visible, W2 finding 1-3): LEVEL IS NOT A MATRIX
        // AXIS — the ruled matrix is pref x availability x mode. Cells run at
        // ALERT (the human-required traffic the engine actually routes); the
        // dial-demotion semantic has its own dedicated test below at NOTICE.
        level: "ALERT",
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
    // Fixture correction (visible, W2 finding 4): the termination is the
    // ESCALATION record (A1.1/F-7) — the park carries the escalation tag.
    const row = await parkOnFounder(["escalation"]);
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

describe("OPR.0.5.6.1 §4 — the C/D digest flush (v3: transport truth first, redrive until success)", () => {
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

  function recordDigestDecision(qitemId: string, key: string, window: "4h" | "daily"): void {
    repo.update({
      qitemId, actorSession: "daemon@kernel",
      transitionNote: `delivery-decision: digest window=${window} notification_key=${key}`,
    });
  }

  function digestWire(posts: Array<Record<string, unknown>>, opts?: { failFetch?: boolean }) {
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    return buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl: async (url, init) => {
        if (opts?.failFetch) {
          return new Response(JSON.stringify({ ok: false, error: "fatal_error" }), { status: 500, headers: { "content-type": "application/json" } });
        }
        // Instrument fix (visible, W9 HOLD): count only REAL chat.postMessage
        // posts — the replay path's reconcile-by-marker channel SEARCH also
        // rides this fetch and must never inflate the post count.
        if (String(url).includes("chat.postMessage")) {
          posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true, ts: `1724.9${posts.length}` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
  }

  async function flushViaWire(mod: Record<string, unknown>, wire: ReturnType<typeof buildSlackGatewayWire>) {
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const flush = (mod as { runDeliveryDigestFlush: (deps: unknown) => Promise<{ dispatched: number; members: number }> }).runDeliveryDigestFlush;
    return flush({
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      home,
      dispatch: (op: string, ref: string, payload: unknown, opts?: unknown) => wire.dispatcher.dispatch(op, ref, payload, opts as never),
      window: "4h" as const,
    });
  }

  it("LOSSLESS + EXACTLY-ONCE (v3): N recorded digest decisions flush as ONE post through the REAL wire; receipts land only AFTER transport truth; a second flush dispatches nothing new (RED at base: no flush machinery exists)", async () => {
    const mod = await digestFlushModule();
    expect(mod, "policies/delivery-digest-flush must exist (RED at base: absent)").not.toBeNull();
    const rows = await nParks(3);
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const keys: Array<{ qid: string; key: string }> = [];
    for (const alert of await ports.listHumanAlerts({ minimumLevel: "NOTICE" })) {
      const key = alert.notificationKey ?? alert.qitemId;
      keys.push({ qid: alert.qitemId, key });
      recordDigestDecision(alert.qitemId, key, "4h");
    }
    const posts: Array<Record<string, unknown>> = [];
    const wire = digestWire(posts);
    try {
      wire.startServices?.();
      const first = await flushViaWire(mod!, wire);
      expect(first.members).toBe(3);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(posts.length, "ONE digest post through the real transport").toBe(1);
      const body = JSON.stringify(posts[0]);
      for (const row of rows) expect(body).toContain(row.qitemId);
      expect(body, "the digest is notify-class: no mention").not.toContain("<@UFOUNDER>");
      // receipts landed AFTER the post (transport truth), digest-tokened, per member
      for (const { qid, key } of keys) {
        const receipts = repo.listTransitions(qid).filter((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "));
        expect(receipts.length, `receipt on ${qid}`).toBe(1);
        expect(receipts[0]!.transitionNote).toContain(`notification_key=${key}`);
        expect(receipts[0]!.transitionNote).toContain("digest=");
      }
      const second = await flushViaWire(mod!, wire);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(second.members, "exactly-once: nothing left to flush").toBe(0);
      expect(posts.length).toBe(1);
    } finally {
      wire.stop();
    }
  });

  it("MESSAGE-TIME DECISION (R1 B-4): a prefs change between containment and flush neither drops nor reclassifies the recorded member", async () => {
    const mod = await digestFlushModule();
    expect(mod).not.toBeNull();
    const rows = await nParks(2);
    const cRegistry = registryWith({ deliveryClass: "C", availability: "available" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => cRegistry } as never);
    for (const alert of await ports.listHumanAlerts({ minimumLevel: "NOTICE" })) {
      recordDigestDecision(alert.qitemId, alert.notificationKey ?? alert.qitemId, "4h");
    }
    // the human flips to A AFTER containment recorded the digest decisions
    const posts: Array<Record<string, unknown>> = [];
    const wire = digestWire(posts);
    try {
      wire.startServices?.();
      const aRegistry = registryWith({ deliveryClass: "A", availability: "available" });
      const flush = (mod as { runDeliveryDigestFlush: (deps: unknown) => Promise<{ dispatched: number; members: number }> }).runDeliveryDigestFlush;
      const result = await flush({
        queueRepo: repo,
        registry: { loadHumanRegistry: () => aRegistry, resolveSlackHandle },
        home,
        dispatch: (op: string, ref: string, payload: unknown, opts?: unknown) => wire.dispatcher.dispatch(op, ref, payload, opts as never),
        window: "4h" as const,
      });
      expect(result.members, "recorded decisions survive later prefs drift").toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(posts.length).toBe(1);
      for (const row of rows) expect(JSON.stringify(posts[0])).toContain(row.qitemId);
    } finally {
      wire.stop();
    }
  });

  it("TRANSPORT-FAILURE REDRIVE (R1/R2 required discriminator): a failed post leaves members FLUSHABLE with zero false receipts; reconstruction replays the SAME durable decision to one eventual post and correctly keyed receipts (RED at candidate: pre-post receipts suppress recovery)", async () => {
    const mod = await digestFlushModule();
    expect(mod).not.toBeNull();
    await nParks(2);
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const keys: Array<{ qid: string; key: string }> = [];
    for (const alert of await ports.listHumanAlerts({ minimumLevel: "NOTICE" })) {
      const key = alert.notificationKey ?? alert.qitemId;
      keys.push({ qid: alert.qitemId, key });
      recordDigestDecision(alert.qitemId, key, "4h");
    }
    const posts: Array<Record<string, unknown>> = [];
    let trackedC!: QueueItem;
    const failing = digestWire(posts, { failFetch: true });
    try {
      failing.startServices?.();
      const first = await flushViaWire(mod!, failing);
      expect(first.members).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(posts.length, "transport failed: nothing posted").toBe(0);
      for (const { qid } of keys) {
        const receipts = repo.listTransitions(qid).filter((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "));
        expect(receipts.length, "NO false posted receipt on transport failure").toBe(0);
      }
    } finally {
      failing.stop();
    }
    // reconstruction: a fresh wire over the SAME home replays the retained
    // durable decision — one eventual post, receipts after transport truth
    const healthy = digestWire(posts);
    try {
      healthy.startServices?.();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(posts.length, "one eventual post after reconstruction").toBe(1);
      for (const { qid, key } of keys) {
        const receipts = repo.listTransitions(qid).filter((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "));
        expect(receipts.length, `receipt on ${qid} after redrive`).toBe(1);
        expect(receipts[0]!.transitionNote).toContain(`notification_key=${key}`);
      }
      // and the flush now finds nothing — exactly once end to end
      const after = await flushViaWire(mod!, healthy);
      expect(after.members).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts.length).toBe(1);
    } finally {
      healthy.stop();
    }
  });

  it("MEMBERSHIP EXCLUSIVITY (R1 HOLD c7818ceb required discriminator): with A+B pending receiptless, adding C mints a NON-OVERLAPPING digest — pending decisions never share a member, and after healing every member posts exactly once (RED at candidate: the set-hash mints an overlapping A/B/C decision)", async () => {
    const mod = await digestFlushModule();
    expect(mod).not.toBeNull();
    // A + B recorded, transport DOWN: their digest decision goes pending, zero receipts
    const firstRows = await nParks(2);
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    for (const alert of await ports.listHumanAlerts({ minimumLevel: "NOTICE" })) {
      recordDigestDecision(alert.qitemId, alert.notificationKey ?? alert.qitemId, "4h");
    }
    const posts: Array<Record<string, unknown>> = [];
    let trackedC!: QueueItem;
    const failing = digestWire(posts, { failFetch: true });
    try {
      failing.startServices?.();
      const first = await flushViaWire(mod!, failing);
      expect(first.members).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 40));
      // C arrives while A+B are pending receiptless
      const [cRowCreated] = await nParks(1);
      trackedC = cRowCreated!;
      for (const alert of await ports.listHumanAlerts({ minimumLevel: "NOTICE" })) {
        if (alert.qitemId === trackedC.qitemId) {
          recordDigestDecision(alert.qitemId, alert.notificationKey ?? alert.qitemId, "4h");
        }
      }
      const second = await flushViaWire(mod!, failing);
      await new Promise((resolve) => setTimeout(resolve, 40));
      // pending decisions must be member-exclusive: no key in more than one
      const pending = new DispatchBuffer(home).pending().filter((d) => d.decisionId.startsWith("digest:"));
      const seen = new Map<string, number>();
      for (const d of pending) {
        for (const m of ((d.payload as { memberReceipts?: Array<{ notificationKey: string }> }).memberReceipts ?? [])) {
          seen.set(m.notificationKey, (seen.get(m.notificationKey) ?? 0) + 1);
        }
      }
      for (const [key, count] of seen) {
        expect(count, `member ${key} rides exactly one pending decision — overlap is the double-delivery`).toBe(1);
      }
      expect(second.members, "the second mint covers ONLY the new member").toBe(1);
    } finally {
      failing.stop();
    }
    // transport heals: reconstruction replays BOTH exclusive decisions —
    // one human-visible post per member episode, each receipted exactly once
    const healthy = digestWire(posts);
    try {
      healthy.startServices?.();
      await new Promise((resolve) => setTimeout(resolve, 80));
      // R1 e22e804f correction: EVERY tracked member — A, B, AND C — must
      // appear in exactly ONE posted digest and carry exactly ONE receipt.
      // (The prior firstRows-only count with a <=1 receipt bound could not
      // refuse a zero-C outcome — the exact proof gap the HOLD named.)
      const tracked = [...firstRows, trackedC];
      const memberAppearances = new Map<string, number>();
      for (const post of posts) {
        const text = JSON.stringify(post);
        for (const row of tracked) {
          if (text.includes(row.qitemId)) memberAppearances.set(row.qitemId, (memberAppearances.get(row.qitemId) ?? 0) + 1);
        }
      }
      for (const row of tracked) {
        expect(memberAppearances.get(row.qitemId) ?? 0, `${row.qitemId} appears in exactly one posted digest`).toBe(1);
        const receipts = repo.listTransitions(row.qitemId).filter((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "));
        expect(receipts.length, `exactly one posted receipt on ${row.qitemId}`).toBe(1);
      }
    } finally {
      healthy.stop();
    }
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

  it("DEFERRAL ARMS DURABLY AND FIRES EXACTLY ONCE AT T+30, surviving a daemon restart mid-window (v3: dispatch at T+30, terminal only on the observed receipt — never zero, never two)", async () => {
    const mod = await deferralPolicyModule();
    expect(mod, "policies/delivery-deferral must exist (RED at base: absent)").not.toBeNull();
    const row = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-founder@external",
      body: "escalation",
      nudge: false,
    });
    const arm = (mod as { armDeliveryDeferral: (deps: unknown) => { jobId: string } }).armDeliveryDeferral;
    const armed = arm({ jobsRepo: jobs, queueRepo: repo, qitemId: row.qitemId, entityId: "human-founder", minutes: 30, notificationKey: `${row.qitemId}:ep1` });
    expect(armed.jobId).toBeTruthy();
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
      deliverInterrupt: async (qitemId: string, key: string) => {
        interrupts.push(qitemId);
        // the delivery seam's act: the receipt lands after transport truth
        repo.update({ qitemId, actorSession: "daemon@kernel",
          transitionNote: `slack-owner-notification-posted notification_key=${key} level=ALERT kind=human-required message_ts=1 thread_ts=1` });
        return { ok: true as const };
      },
    };
    // before T+30: not due
    expect((await fire({ ...deps, now: new Date(Date.now() + 10 * 60_000) })).fired).toBe(false);
    expect(interrupts.length).toBe(0);
    // at T+30: dispatches exactly once (job stays active pending the receipt observation)
    expect((await fire({ ...deps, now: new Date(Date.now() + 31 * 60_000) })).fired).toBe(false);
    expect(interrupts).toEqual([row.qitemId]);
    // the next evaluation observes the receipt: fired + terminal, no re-delivery
    expect((await fire({ ...deps, now: new Date(Date.now() + 32 * 60_000) })).fired).toBe(true);
    expect(interrupts.length).toBe(1);
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
    const raw = readFileSync(join(SRC_ROOT, "domain", "gateway", "delivery-rules-engine.ts"), "utf8");
    const source = stripComments(raw);
    // consumes, never mints: the S14 receipt literals may be REFERENCED via the
    // transition-log helpers but never re-spelled as template writes here
    expect(source).not.toMatch(/slack-owner-notification-posted\s/);
    expect(source).not.toMatch(/["'`]post-failed["'`]/);
    // the delivery-state table is documented at the seam (AM-F4's one definition site)
    expect(raw).toContain("delivery-state");
  });

  it("NO FABRICATED STATE: no engine artifact can represent `seen` (schema + writes receipt)", async () => {
    for (const rel of [
      ["domain", "gateway", "delivery-rules-engine.ts"],
      ["domain", "policies", "delivery-deferral.ts"],
      ["domain", "policies", "delivery-digest-flush.ts"],
    ]) {
      const source = stripComments(readFileSync(join(SRC_ROOT, ...rel), "utf8"));
      expect(source, rel.join("/")).not.toMatch(/["'`]seen["'`]/);
    }
  });

  it("ANTI-SPRAWL (AM-F1): the three new modules introduce no timer entry point — no setInterval/setTimeout; timing rides watchdog_jobs only", async () => {
    for (const rel of [
      ["domain", "gateway", "delivery-rules-engine.ts"],
      ["domain", "policies", "delivery-deferral.ts"],
      ["domain", "policies", "delivery-digest-flush.ts"],
    ]) {
      const source = stripComments(readFileSync(join(SRC_ROOT, ...rel), "utf8"));
      expect(source, rel.join("/")).not.toMatch(/setInterval|setTimeout/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 PRODUCTION COMPOSITION (R2 BLOCKING repair, artifact 57abf60f...): the
// live paths must be REACHABLE — an injected-port green does not buy them.
// ─────────────────────────────────────────────────────────────────────────────

async function operatorEngineModule(): Promise<Record<string, unknown> | null> {
  try {
    return (await import("../src/domain/gateway/operator-delivery-engine.js")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("OPR.0.5.6.1 §8 — the production composition is live (R2 B-1/B-2/B-3)", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    ensureFinalColumns(db);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    home = mkdtempSync(join(tmpdir(), "s01-prod-"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function realWire(prefs: Record<string, unknown>, posts: Array<Record<string, unknown>>) {
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
        return new Response(JSON.stringify({ ok: true, ts: `1724.100${posts.length}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
  }

  it("B-1: the deferred-fire payload dispatches the ADVERTISED op through the REAL dispatcher and reaches the delivery seam (RED at candidate: startup hardcodes outbound_post, which the capability refuses)", async () => {
    const mod = await operatorEngineModule();
    expect(mod, "operator-delivery-engine module must exist").not.toBeNull();
    const posts: Array<Record<string, unknown>> = [];
    const wire = realWire({ deliveryClass: "A", availability: "available" }, posts);
    try {
      wire.startServices?.();
      const row = await repo.create({
        sourceSession: "orch-lead@v-openrig-build",
        destinationSession: "human-founder@external",
        body: "deferred escalation",
        nudge: false,
      });
      const buildFire = (mod as { buildDeferralFirePayload: (row: QueueItem, notificationKey: string) => Record<string, unknown> }).buildDeferralFirePayload;
      const payload = buildFire(row, `${row.qitemId}:test-episode`);
      const res = wire.dispatcher.dispatch(OUTBOUND_OP, String(payload["destinationSession"] ?? ""), payload);
      expect(res).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts.length, "the fire must reach the delivery seam, not die at capability refusal").toBe(1);
      // R1 B-3: the receipt carries the EPISODE key, never the bare qitemId fallback
      const receipts = repo.listTransitions(row.qitemId).filter((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "));
      expect(receipts.length).toBe(1);
      expect(receipts[0]!.transitionNote).toContain(`notification_key=${row.qitemId}:test-episode`);
    } finally {
      wire.stop();
    }
  });

  it("B-3 ladder binding: a keyed dispatched-to-engine episode resolves ONLY on its own key — a stale receipt with another key never closes the rung (RED at candidate: any historical note resolves)", async () => {
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    const { created } = await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: "worker@r", nudge: false });
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), "failed:tmux session not found", created.qitemId);
    const KEY = `${created.qitemId}:episode-7`;
    const tickDeps = {
      db, queueRepo: repo,
      attemptWake: async () => "failed:tmux session not found",
      resolveOrchestrator: () => null,
      retryIntervalSeconds: 1, retryCap: 0,
      log: () => {},
      deliveryEngine: {
        dispatchEscalation: async () => ({ decision: "interrupt", resolved: false, notificationKey: KEY }),
      },
    };
    await runWakeLadderTick(tickDeps as never);
    // a receipt under a DIFFERENT episode key must NOT resolve
    repo.update({ qitemId: created.qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-posted notification_key=${created.qitemId}:older-episode level=ALERT kind=human-required message_ts=1 thread_ts=1` });
    await runWakeLadderTick(tickDeps as never);
    const exhaustedEarly = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(created.qitemId) as Array<{ transition_note: string | null }>)
      .map((r) => r.transition_note ?? "").filter((n) => n.startsWith("ladder-exhausted:"));
    expect(exhaustedEarly.length, "a stale-episode receipt never closes the rung").toBe(0);
    // the DISPATCHED episode's receipt resolves
    repo.update({ qitemId: created.qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-posted notification_key=${KEY} level=ALERT kind=human-required message_ts=2 thread_ts=2` });
    await runWakeLadderTick(tickDeps as never);
    const exhausted = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(created.qitemId) as Array<{ transition_note: string | null }>)
      .map((r) => r.transition_note ?? "").filter((n) => n.startsWith("ladder-exhausted:"));
    expect(exhausted.length).toBe(1);
  });

  it("B-3 ladder binding PRE-MARKER (R2 003f4786 required discriminator): an OLDER keyed receipt already on the row before a new dispatch marker never closes the new rung — the key derives BEFORE any resolution note is evaluated", async () => {
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    const { created } = await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: "worker@r", nudge: false });
    // the OLD episode's receipt lands FIRST (before any ladder activity)
    repo.update({ qitemId: created.qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-posted notification_key=${created.qitemId}:older-episode level=ALERT kind=human-required message_ts=1 thread_ts=1` });
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), "failed:tmux session not found", created.qitemId);
    const KEY = `${created.qitemId}:new-episode`;
    const tickDeps = {
      db, queueRepo: repo,
      attemptWake: async () => "failed:tmux session not found",
      resolveOrchestrator: () => null,
      retryIntervalSeconds: 1, retryCap: 0,
      log: () => {},
      deliveryEngine: { dispatchEscalation: async () => ({ decision: "interrupt", resolved: false, notificationKey: KEY }) },
    };
    await runWakeLadderTick(tickDeps as never); // dispatches, marker keyed
    await runWakeLadderTick(tickDeps as never); // must NOT exhaust on the pre-marker receipt
    const exhausted = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(created.qitemId) as Array<{ transition_note: string | null }>)
      .map((r) => r.transition_note ?? "").filter((n) => n.startsWith("ladder-exhausted:"));
    expect(exhausted.length, "the pre-existing old-episode receipt must not close the NEW keyed rung").toBe(0);
    repo.update({ qitemId: created.qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-posted notification_key=${KEY} level=ALERT kind=human-required message_ts=2 thread_ts=2` });
    await runWakeLadderTick(tickDeps as never);
    const after = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(created.qitemId) as Array<{ transition_note: string | null }>)
      .map((r) => r.transition_note ?? "").filter((n) => n.startsWith("ladder-exhausted:"));
    expect(after.length).toBe(1);
  });

  it("B-1 structural: startup.ts carries no unadvertised outbound_post literal (RED at candidate: it does)", () => {
    const source = readFileSync(join(SRC_ROOT, "startup.ts"), "utf8");
    expect(source).not.toContain('"outbound_post"');
  });

  it("B-2 structural: the production index composition supplies deliveryEngine to the real tick (RED at candidate: only the test double exists)", () => {
    const source = readFileSync(join(SRC_ROOT, "index.ts"), "utf8");
    expect(source).toContain("deliveryEngine");
    expect(source).toContain("makeOperatorDeliveryEngine");
  });

  it("B-2 behavioral: the REAL tick with the PRODUCTION port drives an operator-rung escalation to dispatched-to-engine, the post lands, and the receipt resolves the ladder (RED at candidate: no production port exists)", async () => {
    const mod = await operatorEngineModule();
    expect(mod).not.toBeNull();
    const posts: Array<Record<string, unknown>> = [];
    const wire = realWire({ deliveryClass: "B", availability: "available" }, posts);
    try {
      wire.startServices?.();
      const make = (mod as { makeOperatorDeliveryEngine: (deps: unknown) => { dispatchEscalation: (row: QueueItem, reason: string) => Promise<{ decision: string; resolved: boolean }> } }).makeOperatorDeliveryEngine;
      const port = make({ home, queueRepo: repo, dispatch: (op: string, ref: string, payload: unknown) => wire.dispatcher.dispatch(op, ref, payload), registry: { loadHumanRegistry: () => registryWith({ deliveryClass: "B", availability: "available" }) } });

      const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
      const { created } = await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: "worker@r", nudge: false });
      db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
        .run(new Date(Date.now() - 10 * 60_000).toISOString(), "failed:tmux session not found", created.qitemId);

      const tickDeps = {
        db, queueRepo: repo,
        attemptWake: async () => "failed:tmux session not found",
        resolveOrchestrator: () => null,
        retryIntervalSeconds: 1, retryCap: 0,
        log: () => {},
        deliveryEngine: port,
      };
      await runWakeLadderTick(tickDeps as never);
      const notes = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(created.qitemId) as Array<{ transition_note: string | null }>).map((r) => r.transition_note ?? "");
      expect(notes.join("\n")).toContain("dispatched-to-engine");
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(posts.length, "the escalation post reaches the delivery seam through the real wire").toBe(1);
      // the S14 receipt now on the row resolves the episode on the next tick
      await runWakeLadderTick(tickDeps as never);
      const exhausted = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(created.qitemId) as Array<{ transition_note: string | null }>)
        .map((r) => r.transition_note ?? "").filter((n) => n.startsWith("ladder-exhausted:"));
      expect(exhausted.length, "receipt resolution exhausts — never silent, never premature").toBe(1);
    } finally {
      wire.stop();
    }
  });

  it("B-3 v3 REDRIVE POSTURE (R1 26eee9b85 + R2 003f4786: exactly-once, never zero): at delivery time the job is ACTIVE with a distinct pending dispatching marker — terminal comes only from the observed receipt", async () => {
    const mod = await deferralPolicyModule();
    expect(mod).not.toBeNull();
    const jobs = new WatchdogJobsRepository(db);
    const row = await repo.create({ sourceSession: "a@r", destinationSession: "human-founder@external", body: "x", nudge: false });
    const arm = (mod as { armDeliveryDeferral: (deps: unknown) => { jobId: string } }).armDeliveryDeferral;
    const armed = arm({ jobsRepo: jobs, queueRepo: repo, qitemId: row.qitemId, entityId: "human-founder", minutes: 30, notificationKey: `${row.qitemId}:ep1` });
    const fire = (mod as { fireDeliveryDeferralIfDue: (deps: unknown) => Promise<{ fired: boolean }> }).fireDeliveryDeferralIfDue;
    const statesAtDelivery: string[] = [];
    const first = await fire({
      jobsRepo: jobs, queueRepo: repo, jobId: armed.jobId,
      deliverInterrupt: async () => {
        statesAtDelivery.push((db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(armed.jobId) as { state: string }).state);
        return { ok: true };
      },
      now: new Date(Date.now() + 31 * 60_000),
    });
    // the job stays ACTIVE through delivery (redrive-until-receipt), fired only on receipt
    expect(statesAtDelivery).toEqual(["active"]);
    expect(first.fired).toBe(false);
    const notes = repo.listTransitions(row.qitemId).map((t) => t.transitionNote ?? "");
    expect(notes.some((n) => n.startsWith("delivery-deferral-dispatching")), "the pending state is distinct from fired/terminal").toBe(true);
    expect(notes.some((n) => n.startsWith("delivery-deferral-fired"))).toBe(false);
    // the receipt lands (the delivery seam's act) -> the next evaluation completes the episode
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-posted notification_key=${row.qitemId}:ep1 level=ALERT kind=human-required message_ts=1 thread_ts=1` });
    const second = await fire({
      jobsRepo: jobs, queueRepo: repo, jobId: armed.jobId,
      deliverInterrupt: async () => { throw new Error("must not re-deliver a receipted episode"); },
      now: new Date(Date.now() + 32 * 60_000),
    });
    expect(second.fired).toBe(true);
    expect((db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(armed.jobId) as { state: string }).state).toBe("terminal");
    expect(repo.listTransitions(row.qitemId).some((t) => t.transitionNote?.startsWith("delivery-deferral-fired"))).toBe(true);
  });

  it("B-3 v3 NEVER ZERO (R2 required discriminator): a death mid-delivery leaves the job ACTIVE; reconstructed repositories REDRIVE to exactly one delivery, one receipt, then terminal", async () => {
    const mod = await deferralPolicyModule();
    expect(mod).not.toBeNull();
    const jobs = new WatchdogJobsRepository(db);
    const row = await repo.create({ sourceSession: "a@r", destinationSession: "human-founder@external", body: "x", nudge: false });
    const arm = (mod as { armDeliveryDeferral: (deps: unknown) => { jobId: string } }).armDeliveryDeferral;
    const armed = arm({ jobsRepo: jobs, queueRepo: repo, qitemId: row.qitemId, entityId: "human-founder", minutes: 30, notificationKey: `${row.qitemId}:ep1` });
    const fire = (mod as { fireDeliveryDeferralIfDue: (deps: unknown) => Promise<{ fired: boolean }> }).fireDeliveryDeferralIfDue;
    // death mid-call: the adapter throws before any enqueue
    await fire({
      jobsRepo: jobs, queueRepo: repo, jobId: armed.jobId,
      deliverInterrupt: async () => { throw new Error("process death"); },
      now: new Date(Date.now() + 31 * 60_000),
    });
    expect((db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(armed.jobId) as { state: string }).state, "no lost fire: the job survives the crash ACTIVE").toBe("active");
    // reconstruction: fresh repositories over the same DB — the redrive delivers exactly once
    const jobs2 = new WatchdogJobsRepository(db);
    let deliveries = 0;
    await fire({
      jobsRepo: jobs2, queueRepo: repo, jobId: armed.jobId,
      deliverInterrupt: async (_q: string, key: string) => {
        deliveries += 1;
        repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel",
          transitionNote: `slack-owner-notification-posted notification_key=${key} level=ALERT kind=human-required message_ts=9 thread_ts=9` });
        return { ok: true };
      },
      now: new Date(Date.now() + 33 * 60_000),
    });
    const done = await fire({
      jobsRepo: jobs2, queueRepo: repo, jobId: armed.jobId,
      deliverInterrupt: async () => { deliveries += 1; return { ok: true }; },
      now: new Date(Date.now() + 34 * 60_000),
    });
    expect(deliveries, "exactly one delivery across death + reconstruction").toBe(1);
    expect(done.fired).toBe(true);
    expect((db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(armed.jobId) as { state: string }).state).toBe("terminal");
  });

  it("B-3 delivery-seam guard: a deferral-fire payload for an already-receipted episode posts NOTHING (replay/second-decision belt — RED at candidate: it posts)", async () => {
    const mod = await operatorEngineModule();
    expect(mod).not.toBeNull();
    const posts: Array<Record<string, unknown>> = [];
    const wire = realWire({ deliveryClass: "A", availability: "available" }, posts);
    try {
      wire.startServices?.();
      const row = await repo.create({ sourceSession: "a@r", destinationSession: "human-founder@external", body: "x", nudge: false });
      const key = `${row.qitemId}:episode-1`;
      repo.update({
        qitemId: row.qitemId, actorSession: "daemon@kernel",
        transitionNote: `slack-owner-notification-posted notification_key=${key} level=ALERT kind=human-required message_ts=1 thread_ts=1`,
      });
      const buildFire = (mod as { buildDeferralFirePayload: (row: QueueItem, notificationKey: string) => Record<string, unknown> }).buildDeferralFirePayload;
      const payload = buildFire(row, key);
      const res = wire.dispatcher.dispatch(OUTBOUND_OP, String(payload["destinationSession"] ?? ""), payload);
      expect(res).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts.length, "an episode with a posted receipt never posts again").toBe(0);
    } finally {
      wire.stop();
    }
  });
});
