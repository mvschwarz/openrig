import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { healthCommand, type HealthDeps } from "../src/commands/health.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";

function mockLifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
    ...overrides,
  };
}

function runningDeps(port: number, identity: HealthDeps["resolveIdentity"] = () => ({ sessionName: "guard@rig-a" })): HealthDeps {
  const state: DaemonState = { pid: 123, port, db: "test.sqlite", startedAt: "2026-09-05T00:00:00Z" };
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((path: string) => path === STATE_FILE),
      readFile: vi.fn((path: string) => path === STATE_FILE ? JSON.stringify(state) : null),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
    resolveIdentity: identity,
  };
}

function stoppedDeps(identity: HealthDeps["resolveIdentity"] = () => ({ sessionName: "guard@rig-a" })): HealthDeps {
  return {
    lifecycleDeps: mockLifecycleDeps(),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
    resolveIdentity: identity,
  };
}

async function run(args: string[], deps?: HealthDeps): Promise<{ logs: string[]; errors: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  console.error = (...values: unknown[]) => errors.push(values.join(" "));
  try {
    await healthCommand(deps).parseAsync(["node", "rig", ...args]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const exitCode = process.exitCode;
  process.exitCode = originalExitCode;
  return { logs, errors, exitCode };
}

const RECORD = {
  schema: "openrig.health/v0alpha1",
  id: "health-context-pressure-a1",
  detector: "context-pressure",
  category: "context",
  scope: { type: "seat", rigId: "rig-a", seatId: "node-a" },
  severity: "critical",
  confidence: "high",
  status: "indeterminate",
  startedAt: "2026-09-05T10:00:00.000Z",
  lastObservedAt: "2026-09-05T10:05:00.000Z",
  window: {
    source: "context-usage",
    startedAt: "2026-09-05T09:00:00.000Z",
    endedAt: "2026-09-05T10:10:00.000Z",
    limit: 3,
    retentionSeconds: 86400,
  },
  freshness: {
    state: "stale",
    evaluatedAt: "2026-09-05T10:10:00.000Z",
    newestSourceAt: "2026-09-05T10:05:00.000Z",
    maxAgeSeconds: 120,
    ageSeconds: 300,
  },
  summary: "Context pressure cannot be confirmed from fresh evidence.",
  evidence: [{
    type: "context-usage",
    sourceOrder: 0,
    observedAt: "2026-09-05T10:05:00.000Z",
    nodeId: "node-a",
    sessionId: "session-a",
    usedPercentage: 96,
    available: true,
    fresh: false,
  }],
  threshold: "critical when usedPercentage >= 95 and evidence is fresh",
  explanation: "The latest bounded context sample is stale, so pressure is indeterminate.",
  suggestedInspection: "rig whoami --node-id node-a --full",
  indeterminateReason: "source_stale",
} as const;

const LIST = {
  schema: "openrig.health-list/v0alpha1",
  evaluatedAt: "2026-09-05T10:10:00.000Z",
  total: 1,
  limit: 100,
  truncated: false,
  records: [RECORD],
};

describe("rig health — daemon-backed read-only projection", () => {
  let server: http.Server;
  let port: number;
  const seen: string[] = [];
  const methods: string[] = [];
  let whoamiStatus = 200;
  let healthStatus = 200;
  let empty = false;
  let partial = false;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = request.url ?? "";
      seen.push(url);
      methods.push(request.method ?? "");
      response.statusCode = url.startsWith("/api/whoami") ? whoamiStatus : healthStatus;
      response.setHeader("content-type", "application/json");
      if (url.startsWith("/api/whoami")) {
        if (whoamiStatus === 409) response.end(JSON.stringify({ error: "session_name_ambiguous" }));
        else response.end(JSON.stringify({ identity: { nodeId: "node-a", rigId: "rig-a" } }));
      } else if (url.startsWith("/api/health/")) {
        response.end(JSON.stringify(healthStatus === 404 ? { error: "health_finding_not_found" } : RECORD));
      } else if (healthStatus === 503) {
        response.end(JSON.stringify({ error: "health_projection_unavailable" }));
      } else if (healthStatus === 404) {
        response.end(JSON.stringify({ error: "not_found", path: "/api/health" }));
      } else {
        response.end(JSON.stringify(empty ? { ...LIST, total: 0, records: [] } : partial ? { ...LIST, total: 0, records: [], coverage: [{
          source: "passive-ceremony", evaluatedAt: LIST.evaluatedAt, unit: "handoff families", limit: 200, total: 634,
          evaluated: 200, omitted: 434, partial: true, order: "most queue transitions in the observation window, then lineage ID" }] } : LIST));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => server.close());

  it("resolves the current seat, forwards exact typed bounds, and preserves the canonical JSON list", async () => {
    seen.length = 0;
    const { logs, exitCode } = await run(["--severity", "critical", "--status", "indeterminate", "--json"], runningDeps(port));
    expect(exitCode).toBeUndefined();
    expect(seen[0]).toBe("/api/whoami?sessionName=guard%40rig-a&compact=1");
    expect(seen[1]).toContain("/api/health?");
    expect(seen[1]).toContain("scope_type=seat");
    expect(seen[1]).toContain("scope_id=node-a");
    expect(seen[1]).toContain("severity=critical");
    expect(seen[1]).toContain("status=indeterminate");
    expect(JSON.parse(logs.join("\n"))).toEqual(LIST);
  });

  it("passes exact seat, rig, and instance scopes to the daemon rather than inventing hierarchy", async () => {
    seen.length = 0;
    methods.length = 0;
    await run(["--seat", "node-b", "--limit", "7", "--json"], runningDeps(port));
    await run(["--rig", "rig-b", "--json"], runningDeps(port));
    await run(["--instance", "instance-b", "--json"], runningDeps(port));
    await run(["--instance", "--json"], runningDeps(port));
    expect(seen[0]).toContain("scope_type=seat&scope_id=node-b&limit=7");
    expect(seen[1]).toContain("scope_type=rig&scope_id=rig-b");
    expect(seen[2]).toContain("scope_type=instance&scope_id=instance-b");
    expect(seen[3]).toBe("/api/health?limit=100");
    expect(seen.every((url) => !url.startsWith("/api/whoami"))).toBe(true);
    expect(methods.every((method) => method === "GET")).toBe(true);
  });

  it("renders stable IDs and the daemon's status, confidence, scope, and stale freshness honestly", async () => {
    const { logs, exitCode } = await run(["--seat", "node-a"], runningDeps(port));
    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain(RECORD.id);
    expect(output).toContain("critical");
    expect(output).toContain("indeterminate");
    expect(output).toContain("high confidence");
    expect(output).toContain("seat:node-a");
    expect(output).toContain("stale");
    expect(output).toContain("source_stale");
  });

  it("renders an empty bounded query explicitly without asserting health", async () => {
    empty = true;
    const { logs, exitCode } = await run(["--rig", "rig-a"], runningDeps(port));
    empty = false;
    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain("No health findings match this bounded query");
    expect(output).toContain("not a healthy assertion");
    expect(output).toContain("rig health --instance");
  });

  it("says a partial evaluation is partial and that omitted families are not healthy", async () => {
    partial = true;
    const { logs, exitCode } = await run(["--instance"], runningDeps(port));
    partial = false;
    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain("PARTIAL: passive-ceremony evaluated 200 of 634 handoff families (limit 200; 434 omitted;");
    expect(output).toContain("Omitted handoff families were not evaluated and are not healthy.");
    expect(output).toContain("not a healthy assertion");
  });

  it("explains the exact daemon record, bounded evidence, freshness, literal rule, and next inspection", async () => {
    const { logs, exitCode } = await run(["explain", RECORD.id], runningDeps(port));
    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain(RECORD.id);
    expect(output).toContain(RECORD.window.startedAt);
    expect(output).toContain(RECORD.freshness.state);
    expect(output).toContain(RECORD.threshold);
    expect(output).toContain(RECORD.explanation);
    expect(output).toContain(RECORD.suggestedInspection);
    expect(output).toContain("context-usage");
    expect(output).toContain("96");
  });

  it("preserves the canonical record for health explain --json", async () => {
    const { logs, exitCode } = await run(["explain", RECORD.id, "--json"], runningDeps(port));
    expect(exitCode).toBeUndefined();
    expect(JSON.parse(logs.join("\n"))).toEqual(RECORD);
  });

  it("distinguishes unavailable local identity from daemon-reported ambiguity", async () => {
    const missing = await run(["--json"], runningDeps(port, () => null));
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.logs.join("\n"))).toMatchObject({
      schema: "openrig.health-error/v0alpha1",
      error: "health_identity_unavailable",
      nextInspection: "rig whoami --json",
    });

    whoamiStatus = 409;
    const ambiguous = await run(["--json"], runningDeps(port));
    whoamiStatus = 200;
    expect(ambiguous.exitCode).toBe(1);
    expect(JSON.parse(ambiguous.logs.join("\n"))).toMatchObject({
      schema: "openrig.health-error/v0alpha1",
      error: "health_identity_ambiguous",
      nextInspection: "rig ps --nodes -A",
    });
  });

  it("distinguishes an unavailable projection, an unknown finding ID, and an unresponsive daemon", async () => {
    healthStatus = 503;
    const unavailable = await run(["--rig", "rig-a", "--json"], runningDeps(port));
    healthStatus = 404;
    const unknown = await run(["explain", "health-missing", "--json"], runningDeps(port));
    healthStatus = 200;
    const daemon = await run(["--rig", "rig-a", "--json"], stoppedDeps());

    expect(JSON.parse(unavailable.logs.join("\n"))).toMatchObject({ error: "health_projection_unavailable" });
    expect(JSON.parse(unknown.logs.join("\n"))).toMatchObject({ error: "health_finding_not_found" });
    expect(JSON.parse(daemon.logs.join("\n"))).toMatchObject({ error: "health_daemon_unavailable" });
    expect(unavailable.exitCode).toBe(1);
    expect(unknown.exitCode).toBe(1);
    expect(daemon.exitCode).toBe(1);
  });

  it("reports an older daemon with no health route as projection-unavailable", async () => {
    healthStatus = 404;
    const result = await run(["--instance", "--json"], runningDeps(port));
    healthStatus = 200;
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.logs.join("\n"))).toMatchObject({
      error: "health_projection_unavailable",
      nextInspection: "rig --version",
    });
  });

  it("keeps a real stale daemon state byte-identical for both list and explain", async () => {
    const originalState = existsSync(STATE_FILE) ? readFileSync(STATE_FILE, "utf8") : null;
    const staleState = `${JSON.stringify({
      pid: 999_999_999,
      port: 1,
      db: "stale.sqlite",
      startedAt: "2026-09-05T00:00:00Z",
    })}\n`;

    try {
      const results: Array<{ present: boolean; bytes: string | null; output: unknown }> = [];
      for (const args of [["--instance", "--json"], ["explain", "health-stale", "--json"]]) {
        writeFileSync(STATE_FILE, staleState, "utf8");
        const result = await run(args);
        results.push({
          present: existsSync(STATE_FILE),
          bytes: existsSync(STATE_FILE) ? readFileSync(STATE_FILE, "utf8") : null,
          output: JSON.parse(result.logs.join("\n")),
        });
      }

      expect(results).toEqual([
        {
          present: true,
          bytes: staleState,
          output: expect.objectContaining({
            schema: "openrig.health-error/v0alpha1",
            error: "health_daemon_unavailable",
          }),
        },
        {
          present: true,
          bytes: staleState,
          output: expect.objectContaining({
            schema: "openrig.health-error/v0alpha1",
            error: "health_daemon_unavailable",
          }),
        },
      ]);
    } finally {
      if (originalState === null) rmSync(STATE_FILE, { force: true });
      else writeFileSync(STATE_FILE, originalState, "utf8");
    }
  });
});
