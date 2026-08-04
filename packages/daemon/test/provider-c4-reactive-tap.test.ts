import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import type { AgentActivity } from "../src/domain/types.js";

const NOW = "2026-08-04T12:00:00.000Z";
const EVENT_AT = "2026-08-04T11:59:00.000Z";
const STALE_AFTER = "2026-08-04T12:04:00.000Z";
const SESSION = "dev-impl@test-rig";
const ACCOUNT = "work";

interface FixtureOptions {
  now?: string;
  runtime?: string;
  registryRuntime?: string;
  accountRef?: string;
  includeRegistry?: boolean;
}

interface Fixture {
  db: Database.Database;
  bus: EventBus;
  store: AgentActivityStore;
  service: ProviderServiceImpl;
  rigId: string;
  nodeId: string;
  sessionName: string;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(options: FixtureOptions = {}): Fixture {
  const now = options.now ?? NOW;
  const runtime = options.runtime ?? "codex";
  const registryRuntime = options.registryRuntime ?? "codex";
  const accountRef = options.accountRef ?? ACCOUNT;
  const includeRegistry = options.includeRegistry ?? true;
  const db = createFullTestDb();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "provider-c4-codex-"));
  cleanups.push(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  cleanups.push(() => db.close());

  fs.mkdirSync(path.join(codexHome, "auth-profiles"), { recursive: true });
  if (accountRef.length > 0) {
    fs.writeFileSync(path.join(codexHome, "auth-profiles", `${accountRef}.json`), "{}\n");
  }
  if (includeRegistry) {
    fs.writeFileSync(
      path.join(codexHome, "auth-seat-registry.tsv"),
      `seat\trig\truntime\tcwd\tauth_profile\tupdated_ts\n${SESSION}\ttest-rig\t${registryRuntime}\t/project\t${accountRef}\t${EVENT_AT}\n`,
    );
  }

  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "test-rig");
  db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
    .run("pod-1", "rig-1", "dev", "Dev");
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id, agent_ref, profile, resolved_spec_name, resolved_spec_version, resolved_spec_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("node-1", "rig-1", "dev.impl", runtime, "/project", "pod-1", "local:agents/impl", "default", "impl", "1.0.0", "abc123");
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)")
    .run("session-1", "node-1", SESSION, "running", "ready");
  db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)")
    .run("binding-1", "node-1", SESSION);

  const bus = new EventBus(db);
  const store = new AgentActivityStore({ db, eventBus: bus, now: () => new Date(now) });
  // Intentionally inject the real shipped detector. A separate source pin below proves production
  // startup also supplies this singleton, preventing the C3-style "test-only injection" false green.
  const serviceDeps = {
    db,
    listRigs: () => [{ id: "rig-1" }],
    env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
    now: () => now,
    agentActivityStore: store,
  };
  const service = new ProviderServiceImpl(serviceDeps);
  return { db, bus, store, service, rigId: "rig-1", nodeId: "node-1", sessionName: SESSION };
}

function recordToken(fx: Fixture, token: string, source: "rawSubtype" | "rawEvent" = "rawEvent", occurredAt = EVENT_AT): void {
  const result = fx.store.recordHookEvent({
    runtime: "codex",
    sessionName: fx.sessionName,
    hookEvent: source === "rawEvent" ? token : "Notification",
    subtype: source === "rawSubtype" ? token : undefined,
    occurredAt,
  });
  expect(result.ok).toBe(true);
}

function emitActivity(fx: Fixture, activity: AgentActivity): void {
  fx.bus.emit({
    type: "agent.activity",
    rigId: fx.rigId,
    nodeId: fx.nodeId,
    sessionName: fx.sessionName,
    runtime: "codex",
    activity,
  });
}

function activity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    state: "needs_input",
    reason: "rate_limit",
    evidenceSource: "runtime_hook",
    sampledAt: NOW,
    evidence: "rate_limit",
    eventAt: EVENT_AT,
    rawEvent: "rate_limit",
    rawSubtype: null,
    runtime: "codex",
    fallback: false,
    stale: false,
    ...overrides,
  };
}

const acceptedTokens = [
  ["at_limit", "allow_switch_decision"],
  ["rate_limit", "allow_switch_decision"],
  ["rate_limited", "allow_switch_decision"],
  ["stream_failure", "advisory_only"],
  ["stream_fail", "advisory_only"],
  ["stop_error", "advisory_only"],
] as const;

describe("Slice-04 C4 — production reactive activity tap", () => {
  it.each(acceptedTokens)("maps exact structured event class %s through real getReadModel", async (token, automationUse) => {
    const fx = fixture();
    recordToken(fx, token);

    const model = await fx.service.getReadModel();
    expect(model.signals).toEqual([{
      provider: "codex",
      accountRef: ACCOUNT,
      sourceClass: "provider_event",
      authority: "reactive_error",
      asOf: EVENT_AT,
      staleAfter: STALE_AFTER,
      automationUse,
    }]);
    expect(model.signals[0]?.usedPercent).toBeUndefined();
  });

  it("binds classification to the event class only — a rawSubtype/reason token is not a producer", async () => {
    const fx = fixture();
    // The interruption token sits only in the (relay tool_name) rawSubtype and the derived
    // reason, while the event class is a generic lifecycle event. Neither rawSubtype nor
    // reason is a structured producer, so no actionable row is emitted.
    emitActivity(fx, activity({ rawEvent: "PermissionRequest", rawSubtype: "rate_limit", reason: "rate_limit" }));
    expect((await fx.service.getReadModel()).signals).toEqual([]);
  });

  it.each([
    "not_rate_limit",
    "rate_limit_warning",
    "stream_failure_recovered",
    "upstream_fail",
    "stop_errors",
  ])("rejects near-match/substring token %s", async (token) => {
    const fx = fixture();
    recordToken(fx, token);
    expect((await fx.service.getReadModel()).signals).toEqual([]);
  });

  it("emits no reactive row when there is no activity event", async () => {
    const fx = fixture();
    expect((await fx.service.getReadModel()).signals).toEqual([]);
  });

  it("drops activity older than the detector freshness window", async () => {
    const fx = fixture();
    recordToken(fx, "rate_limit", "rawEvent", "2026-08-04T11:54:59.999Z");
    expect((await fx.service.getReadModel()).signals).toEqual([]);
  });

  it("drops activity exactly at staleAfter, matching BR-2's inclusive now >= staleAfter rule", async () => {
    const fx = fixture({ now: STALE_AFTER });
    recordToken(fx, "rate_limit");
    expect((await fx.service.getReadModel()).signals).toEqual([]);
  });

  it.each([
    ["missing", activity({ eventAt: undefined })],
    ["unparseable", activity({ eventAt: "not-a-timestamp" })],
  ] as const)("drops %s eventAt from the real persisted EventBus path", async (_label, event) => {
    const fx = fixture();
    emitActivity(fx, event);
    expect((await fx.service.getReadModel()).signals).toEqual([]);
  });

  it.each([
    ["missing registry row", { includeRegistry: false }],
    ["empty account ref", { accountRef: "" }],
    ["non-Codex registry row", { registryRuntime: "claude-code" }],
    ["non-Codex runtime seat", { runtime: "claude-code" }],
  ] as const)("drops interruption evidence with %s", async (_label, options) => {
    const fx = fixture(options);
    recordToken(fx, "rate_limit");
    const signals = (await fx.service.getReadModel()).signals;
    expect(signals.filter((signal) => signal.sourceClass === "provider_event")).toEqual([]);
  });

  it("does not relabel a generic PermissionRequest/needs_input block as provider exhaustion", async () => {
    const fx = fixture();
    const result = fx.store.recordHookEvent({
      runtime: "codex",
      sessionName: fx.sessionName,
      hookEvent: "PermissionRequest",
      subtype: "Bash",
      occurredAt: EVENT_AT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.activity.state).toBe("needs_input");
    expect((await fx.service.getReadModel()).signals).toEqual([]);
  });

  it("production startup injects the already-created AgentActivityStore singleton", () => {
    const startup = fs.readFileSync(path.join(import.meta.dirname, "../src/startup.ts"), "utf8");
    const start = startup.indexOf("providerService: new ProviderServiceImpl({");
    const end = startup.indexOf("restoreOrchestrator,", start);
    expect(start, "ProviderServiceImpl production construction must exist").toBeGreaterThanOrEqual(0);
    expect(end, "startup provider-service block must be bounded").toBeGreaterThan(start);
    expect(startup.slice(start, end)).toMatch(/\bagentActivityStore\s*,/);
  });

  it("reactive tap import closure contains no pane capture or session-transport dependency", () => {
    const entry = path.join(import.meta.dirname, "../src/domain/provider/reactive-tap.ts");
    expect(fs.existsSync(entry), "production reactive tap module must exist").toBe(true);
    if (!fs.existsSync(entry)) return;

    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(/capturePane|capture-pane|session-transport/);
      for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const specifier = match[1]!;
        const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
        if (resolved.includes(`${path.sep}src${path.sep}domain${path.sep}`) && fs.existsSync(resolved)) visit(resolved);
      }
    };
    visit(entry);
  });
});

// Slice-04 C4 CORRECTION (baton ce3e52a0) — PUBLIC-ALTITUDE eligibility gate +
// structured-producer binding. These drive the real authenticated public hook
// path (POST /api/activity/hooks → store → ProviderServiceImpl.getReadModel),
// reproducing review50-r2's three failed probes as pins (verdict 82268f5d):
//   HIGH-1a: a claude-code activity must never emit a Codex row (event.runtime).
//   HIGH-1b: a registry ref absent from auth-profiles must not fabricate a row.
//   HIGH-2 : a managed PermissionRequest tool-name `rate_limit` subtype is a
//            permission block, not an interruption producer (bind to event class).
describe("Slice-04 C4 correction — public-altitude eligibility gate + producer binding", () => {
  const TOKEN = "review-token";

  interface PublicFixtureOptions {
    profileExists?: boolean;
    registryRuntime?: string;
    seatRuntime?: string;
    now?: string;
  }

  function publicFixture(options: PublicFixtureOptions = {}) {
    const db = createFullTestDb();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "c4-pub-codex-"));
    cleanups.push(() => fs.rmSync(codexHome, { recursive: true, force: true }));
    cleanups.push(() => db.close());

    fs.mkdirSync(path.join(codexHome, "auth-profiles"), { recursive: true });
    if (options.profileExists !== false) {
      fs.writeFileSync(path.join(codexHome, "auth-profiles", `${ACCOUNT}.json`), "{}\n");
    }
    fs.writeFileSync(
      path.join(codexHome, "auth-seat-registry.tsv"),
      `seat\trig\truntime\tcwd\tauth_profile\tupdated_ts\n${SESSION}\ttest-rig\t${options.registryRuntime ?? "codex"}\t/project\t${ACCOUNT}\t${EVENT_AT}\n`,
    );

    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-1", "rig-1", "dev", "Dev");
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id, agent_ref, profile, resolved_spec_name, resolved_spec_version, resolved_spec_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("node-1", "rig-1", "dev.impl", options.seatRuntime ?? "codex", "/project", "pod-1", "local:agents/impl", "default", "impl", "1.0.0", "abc123");
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)").run("session-1", "node-1", SESSION, "running", "ready");
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)").run("binding-1", "node-1", SESSION);

    const testApp = createTestApp(db, { activityHookToken: TOKEN });
    const service = new ProviderServiceImpl({
      db,
      listRigs: () => [{ id: "rig-1" }],
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      now: () => options.now ?? NOW,
      agentActivityStore: testApp.agentActivityStore,
    });
    return { app: testApp.app, service };
  }

  async function postHook(
    app: ReturnType<typeof createTestApp>["app"],
    input: { runtime?: string; hookEvent?: string; subtype?: string; occurredAt?: string },
  ): Promise<Response> {
    return app.request("/api/activity/hooks", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        sessionName: SESSION,
        runtime: input.runtime,
        hookEvent: input.hookEvent ?? "Notification",
        subtype: input.subtype,
        occurredAt: input.occurredAt ?? EVENT_AT,
      }),
    });
  }

  function reactiveRows(model: Awaited<ReturnType<ProviderServiceImpl["getReadModel"]>>) {
    return model.signals.filter((signal) => signal.sourceClass === "provider_event");
  }

  it("positive: an honest Codex rate_limit event through the public hook path yields one actionable row", async () => {
    const fx = publicFixture();
    expect((await postHook(fx.app, { runtime: "codex", hookEvent: "rate_limit" })).status).toBe(200);
    expect(reactiveRows(await fx.service.getReadModel())).toEqual([{
      provider: "codex",
      accountRef: ACCOUNT,
      sourceClass: "provider_event",
      authority: "reactive_error",
      asOf: EVENT_AT,
      staleAfter: STALE_AFTER,
      automationUse: "allow_switch_decision",
    }]);
  });

  it("HIGH-1a: a claude-code activity attached to a Codex seat must NOT emit a Codex row", async () => {
    const fx = publicFixture();
    expect((await postHook(fx.app, { runtime: "claude-code", hookEvent: "rate_limit" })).status).toBe(200);
    expect(reactiveRows(await fx.service.getReadModel())).toEqual([]);
  });

  it("HIGH-1b: a registry ref with no matching auth profile must NOT fabricate a reactive row", async () => {
    const fx = publicFixture({ profileExists: false });
    expect((await postHook(fx.app, { runtime: "codex", hookEvent: "rate_limit" })).status).toBe(200);
    expect(reactiveRows(await fx.service.getReadModel())).toEqual([]);
  });

  it("HIGH-2: a managed PermissionRequest with a rate_limit tool-name subtype must NOT become exhaustion", async () => {
    const fx = publicFixture();
    expect((await postHook(fx.app, { runtime: "codex", hookEvent: "PermissionRequest", subtype: "rate_limit" })).status).toBe(200);
    expect(reactiveRows(await fx.service.getReadModel())).toEqual([]);
  });

  it("the shipped managed Codex hook set contains no structured interruption producer", () => {
    const config = fs.readFileSync(
      path.join(import.meta.dirname, "../assets/plugins/openrig-core/hooks/codex.json"),
      "utf8",
    );
    const managedEvents = Object.keys((JSON.parse(config) as { hooks: Record<string, unknown> }).hooks);
    const interruptionTokens = ["at_limit", "rate_limit", "rate_limited", "stream_failure", "stream_fail", "stop_error"];
    expect(managedEvents.filter((event) => interruptionTokens.includes(event))).toEqual([]);
    expect(managedEvents).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"]);
  });
});
