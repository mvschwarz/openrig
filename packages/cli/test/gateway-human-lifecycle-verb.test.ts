import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { createProgram } from "../src/index.js";
import { gatewayCommand, daemonQueueRows, type HumanRowsLookup } from "../src/commands/gateway.js";
import { humansDir, addHumanFragment, loadHumanRegistry } from "@openrig/daemon/gateway-human-registry";

// OPR.0.5.5.12 — `rig gateway human list|show|set|remove` verb wiring. Same harness as the
// add-verb test: temp OPENRIG_HOME, real command end-to-end, fs effects asserted at source.
// remove's queue-row check is injected (HumanRowsLookup) so these tests never need a daemon —
// the INDETERMINATE path is pinned with a lookup that fails like an unreachable daemon.

async function runAdd(name: string, extra: string[] = []): Promise<void> {
  const p = createProgram();
  p.exitOverride();
  await p.parseAsync([
    "node", "rig", "gateway", "human", "add", name,
    "--display-name", name,
    "--binding", `slack:main:vault://slack/${name}:primary`,
    "--delivery-class", "B",
    ...extra,
  ]);
}

/** The hand-authoring path (registry surface, not the verb) — how a second fragment
 *  legitimately comes to exist under A1. */
function seedSecondHuman(name: string): void {
  const res = addHumanFragment({
    entityId: name,
    class: "human",
    displayName: name,
    address: `${name}@external`,
    connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: `vault://slack/${name}`, role: "primary" }],
    prefs: { deliveryClass: "A" },
  });
  if (!res.ok) throw new Error(`seedSecondHuman failed: ${res.error}`);
}

/** Stub daemon honoring /api/queue/list `limit` over REAL HTTP: `total` active rows exist;
 *  a request returns min(limit, total) — exactly the shape that hid the 500-cap omission. */
function stubQueueDaemon(total: number): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url!, "http://x");
      if (!u.pathname.endsWith("/api/queue/list")) { res.writeHead(404); res.end("{}"); return; }
      const limit = Number.parseInt(u.searchParams.get("limit") ?? "100", 10);
      const n = Math.min(limit, total);
      const rows = Array.from({ length: n }, (_, i) => ({ qitemId: `qitem-load-${i}`, state: "pending", summary: `row ${i}` }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rows));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("rig gateway human lifecycle verbs (S12)", () => {
  let home: string;
  let prevHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "s12-verb-"));
    prevHome = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = home;
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log");
    errSpy = vi.spyOn(console, "error");
    await runAdd("mike");
    logSpy.mockClear();
  });

  it("records binding changes and repeats without embedding binding secrets or handles", async () => {
    const args = ["node", "rig", "human", "set", "mike", "binding.0", "slack:backup:vault://private-marker:primary:handle=U-PRIVATE", "--reason", "change primary connector"];
    await gatewayCommand().parseAsync(args);
    await gatewayCommand().parseAsync(args);
    const rows = readFileSync(join(home, "state", "human-channel-operations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.effect !== "started");
    expect(rows.slice(-2).map((row) => row.effect)).toEqual(["applied", "no-op"]);
    expect(rows.at(-1)).toMatchObject({ action: "binding", subject: "mike@external", reason: "change primary connector", provenance: "claimed:v1" });
    expect(JSON.stringify(rows)).not.toMatch(/private-marker|U-PRIVATE/);
  });

  const ready = async () => ({
    state: "ready" as const,
    configured: true,
    enabled: true,
    active: true,
    ready: true,
    reason: "connector accepted live readiness probes",
    nextAction: null,
  });

  const program = () => createProgram({ gatewayDeps: { humanReadiness: ready } });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (prevHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("is wired via createProgram: list, show, set, remove all exist under gateway human", () => {
    const gw = program().commands.find((c) => c.name() === "gateway")!;
    const human = gw.commands.find((c) => c.name() === "human")!;
    for (const verb of ["list", "show", "set", "remove"]) {
      expect(human.commands.find((c) => c.name() === verb), `gateway human ${verb}`).toBeDefined();
    }
  });

  it("list --json emits the complete records", async () => {
    const p = program();
    p.exitOverride();
    await p.parseAsync(["node", "rig", "gateway", "human", "list", "--json"]);
    expect(process.exitCode).toBeUndefined();
    const out = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as { ok: boolean; humans: Array<Record<string, unknown>> };
    expect(out.ok).toBe(true);
    expect(out.humans).toHaveLength(1);
    expect(out.humans[0]!.entityId).toBe("mike");
    expect(out.humans[0]!.deliveryClass).toBe("B");
    expect(out.humans[0]!.deliveryReadiness).toMatchObject({ state: "ready", configured: true, enabled: true, active: true, ready: true });
  });

  it("preserves readiness uncertainty through real HTTP in list/show JSON and human output", async () => {
    const valid = await ready();
    let status = 200;
    let body: unknown;
    let requests = 0;
    const server = createServer((req, res) => {
      expect(req.url).toBe("/api/gateway/human/mike/readiness");
      requests++;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const previousUrl = process.env.OPENRIG_URL;
    process.env.OPENRIG_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const cases = [
      { status: 503, body: { error: "human_registry_unavailable", message: "fixture projection unavailable" }, detail: /HTTP 503.*human_registry_unavailable/ },
      { status: 200, body: { ok: true }, detail: /HTTP 200.*malformed/i },
      { status: 200, body: { ok: false, readiness: valid }, detail: /HTTP 200.*malformed/i },
      { status: 200, body: { ok: true, readiness: { ...valid, enabled: "true" } }, detail: /HTTP 200.*malformed/i },
      { status: 200, body: { ok: true, readiness: { ...valid, state: "indeterminate" } }, detail: /HTTP 200.*malformed/i },
      { status: 200, body: { ok: true, readiness: valid }, detail: null },
    ];
    try {
      for (const entry of cases) {
        status = entry.status;
        body = entry.body;
        for (const command of [["list"], ["show", "mike"]]) {
          for (const json of [true, false]) {
            logSpy.mockClear();
            const p = createProgram(); // default helper and real DaemonClient, no readiness injection
            p.exitOverride();
            await p.parseAsync(["node", "rig", "gateway", "human", ...command, ...(json ? ["--json"] : [])]);
            expect(process.exitCode).toBeUndefined();
            const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
            if (json) {
              const result = JSON.parse(output);
              const readiness = (command[0] === "list" ? result.humans[0] : result.record).deliveryReadiness;
              if (!entry.detail) expect(readiness).toEqual(valid);
              else {
                expect(readiness).toMatchObject({ state: "indeterminate", configured: null, enabled: null, active: null, ready: false, nextAction: "rig status" });
                expect(readiness.reason).toMatch(entry.detail);
              }
            } else if (entry.detail) {
              expect(output).toContain("indeterminate");
              expect(output).toMatch(entry.detail);
              expect(output).toContain("next: rig status");
            } else expect(output).toMatch(/delivery(?:-readiness: |=)ready/);
          }
        }
      }
      expect(requests).toBe(cases.length * 4);
    } finally {
      if (previousUrl === undefined) delete process.env.OPENRIG_URL; else process.env.OPENRIG_URL = previousUrl;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("A1 advisory receipt: with several hand-authored fragments list --json renders all + the 0.5.7 advisory", async () => {
    // Fix-r1 F1: the SECOND human arrives by hand-authoring (the registry surface), never
    // through the add verb — the verb is the single-human boundary.
    seedSecondHuman("ana");
    logSpy.mockClear();
    const p = program();
    p.exitOverride();
    await p.parseAsync(["node", "rig", "gateway", "human", "list", "--json"]);
    const out = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as { ok: boolean; humans: unknown[]; advisory?: string };
    expect(out.ok).toBe(true);
    expect(out.humans).toHaveLength(2); // honest display
    expect(out.advisory).toContain("0.5.7"); // never a management surface
  });

  it("show --json carries authored-vs-default provenance and the fragment path", async () => {
    const p = program();
    p.exitOverride();
    await p.parseAsync(["node", "rig", "gateway", "human", "show", "mike", "--json"]);
    const out = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as { ok: boolean; record: { prefs: { away: { source: string } }; fragmentPath: string; deliveryReadiness: Record<string, unknown> } };
    expect(out.ok).toBe(true);
    expect(out.record.prefs.away.source).toBe("default");
    expect(out.record.fragmentPath).toContain("mike.yaml");
    expect(out.record.deliveryReadiness).toMatchObject({ state: "ready", ready: true });
  });

  it("set delivery-class lands in the fragment (verified at source, not from the echo)", async () => {
    const p = program();
    p.exitOverride();
    await p.parseAsync(["node", "rig", "gateway", "human", "set", "mike", "delivery-class", "D"]);
    expect(process.exitCode).toBeUndefined();
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.entities[0]!.prefs.deliveryClass).toBe("D");
  });

  it("set with a bad enum exits 1 and names the allowed set", async () => {
    const p = program();
    p.exitOverride();
    try { await p.parseAsync(["node", "rig", "gateway", "human", "set", "mike", "delivery-class", "Z"]); } catch { /* exitCode path */ }
    expect(process.exitCode).toBe(1);
    const err = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toMatch(/A.*B.*C.*D/);
  });

  it("remove refuses with a teaching refusal enumerating in-flight rows from the injected lookup", async () => {
    const rows: HumanRowsLookup = async () => ({ ok: true, rows: [{ id: "qitem-777", state: "pending", summary: "ping mike" }] });
    const p = program();
    p.exitOverride();
    const gw = gatewayCommand({ queueRows: rows });
    // Drive the injected command directly (same commander surface the program mounts).
    gw.exitOverride();
    try { await gw.parseAsync(["node", "gateway", "human", "remove", "mike"], { from: "node" as never }); } catch { /* exitCode */ }
    expect(process.exitCode).toBe(1);
    const err = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toContain("qitem-777");
    expect(err).toContain("--force");
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(true);
  });

  it("remove with an UNREACHABLE rows lookup refuses as INDETERMINATE — force does not override ignorance", async () => {
    const rows: HumanRowsLookup = async () => ({ ok: false, error: "daemon unreachable at http://127.0.0.1:9" });
    for (const args of [["remove", "mike"], ["remove", "mike", "--force"]]) {
      process.exitCode = undefined;
      const gw = gatewayCommand({ queueRows: rows });
      gw.exitOverride();
      try { await gw.parseAsync(["node", "gateway", "human", ...args], { from: "node" as never }); } catch { /* exitCode */ }
      expect(process.exitCode).toBe(1);
    }
    const err = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toContain("could not be checked"); // names the unchecked surface, never fabricates absence
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(true);
  });

  // ── fix-r1 F1: the add verb IS the single-human boundary ──

  it("F1: a second DISTINCT add REFUSES with teaching (existing human named, hand-authoring + 0.5.7 pointed at) and writes ZERO fragment bytes", async () => {
    const dirBefore = readdirSync(humansDir(home)).sort();
    const mikeBytes = readFileSync(join(humansDir(home), "mike.yaml"), "utf8");
    const p = program();
    p.exitOverride();
    try { await p.parseAsync([
      "node", "rig", "gateway", "human", "add", "ana",
      "--display-name", "Ana",
      "--binding", "slack:main:vault://slack/ana:primary",
      "--delivery-class", "A",
    ]); } catch { /* exitCode path */ }
    expect(process.exitCode).toBe(1);
    const err = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toContain("mike");        // the existing human, named
    expect(err).toContain("0.5.7");       // where multi-human management lives
    expect(err).toContain("hand-author"); // the sanctioned several-fragment path
    // Zero new fragment bytes: directory unchanged, existing fragment byte-identical.
    expect(readdirSync(humansDir(home)).sort()).toEqual(dirBefore);
    expect(readFileSync(join(humansDir(home), "mike.yaml"), "utf8")).toBe(mikeBytes);
  });

  it("F1 companion: re-add of the SAME human with --replace stays allowed (boundary blocks distinct humans only)", async () => {
    const p = createProgram();
    p.exitOverride();
    await p.parseAsync([
      "node", "rig", "gateway", "human", "add", "mike",
      "--display-name", "Mike Replaced",
      "--binding", "slack:main:vault://slack/mike:primary",
      "--delivery-class", "C",
      "--replace",
    ]);
    expect(process.exitCode).toBeUndefined();
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.entities[0]!.displayName).toBe("Mike Replaced");
  });

  it.each([
    { status: 503, body: { error: "queue_unavailable" } },
    { status: 500, body: [] },
    { status: 200, body: { error: "invalid_queue_projection" } },
    { status: 200, body: null },
    { status: 204, body: undefined },
  ].flatMap((entry) => [false, true].map((force) => ({ ...entry, force }))))("keeps human removal indeterminate for HTTP $status (force=$force)", async ({ status, body, force }) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const previousUrl = process.env.OPENRIG_URL;
    process.env.OPENRIG_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const fragment = join(humansDir(home), "mike.yaml");
    const before = readFileSync(fragment, "utf8");
    try {
      const command = gatewayCommand();
      command.exitOverride();
      await command.parseAsync(["node", "gateway", "human", "remove", "mike", ...(force ? ["--force"] : [])]);
      expect(process.exitCode).toBe(1);
      expect(readFileSync(fragment, "utf8")).toBe(before);
      const rows = await daemonQueueRows("mike@external");
      expect(rows.ok).toBe(false);
      if (!rows.ok) expect(rows.error).toContain(`HTTP ${status}`);
      expect(errSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("queue could not be checked");
    } finally {
      if (previousUrl === undefined) delete process.env.OPENRIG_URL; else process.env.OPENRIG_URL = previousUrl;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("allows human removal after HTTP 200 proves the queue is empty", async () => {
    const { server, url } = await stubQueueDaemon(0);
    const previousUrl = process.env.OPENRIG_URL;
    process.env.OPENRIG_URL = url;
    try {
      expect(await daemonQueueRows("mike@external")).toEqual({ ok: true, rows: [] });
      const command = gatewayCommand();
      command.exitOverride();
      await command.parseAsync(["node", "gateway", "human", "remove", "mike"]);
      expect(process.exitCode).toBeUndefined();
      expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(false);
    } finally {
      if (previousUrl === undefined) delete process.env.OPENRIG_URL; else process.env.OPENRIG_URL = previousUrl;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ── fix-r1 F2: the remove guard's row read enumerates to EXHAUSTION ──

  it("F2: daemonQueueRows at cap+1 (501 active rows) returns ALL 501 or refuses — silent truncation ABSENT", async () => {
    const { server, url } = await stubQueueDaemon(501);
    const prevUrl = process.env.OPENRIG_URL;
    process.env.OPENRIG_URL = url;
    try {
      const res = await daemonQueueRows("mike@external");
      if (res.ok) {
        expect(res.rows).toHaveLength(501); // exhaustive — every stranded row surfaced
      } else {
        expect(res.error).toContain("complete"); // or an honest completeness refusal
      }
    } finally {
      if (prevUrl === undefined) delete process.env.OPENRIG_URL; else process.env.OPENRIG_URL = prevUrl;
      server.close();
    }
  });

  it("F2 end-to-end: remove --force over 501 live rows records 501 orphans — reconciliation, no silent omission", async () => {
    const { server, url } = await stubQueueDaemon(501);
    const prevUrl = process.env.OPENRIG_URL;
    process.env.OPENRIG_URL = url;
    try {
      const gw = gatewayCommand(); // REAL default lookup — the exhaustion path under test
      gw.exitOverride();
      await gw.parseAsync(["node", "gateway", "human", "remove", "mike", "--force"], { from: "node" as never });
      expect(process.exitCode).toBeUndefined();
      const out = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as { ok: boolean; orphanRecordPath?: string };
      expect(out.ok).toBe(true);
      expect(out.orphanRecordPath).toBeDefined();
      const orphans = JSON.parse(readFileSync(out.orphanRecordPath!, "utf8")) as { orphaned: Array<{ id: string }> };
      expect(orphans.orphaned).toHaveLength(501);
      const ids = new Set(orphans.orphaned.map((o) => o.id));
      expect(ids.has("qitem-load-0")).toBe(true);
      expect(ids.has("qitem-load-500")).toBe(true); // the row the 500-cap silently dropped
    } finally {
      if (prevUrl === undefined) delete process.env.OPENRIG_URL; else process.env.OPENRIG_URL = prevUrl;
      server.close();
    }
  });

  it("remove with a clean board archives and reports the archive path", async () => {
    const rows: HumanRowsLookup = async () => ({ ok: true, rows: [] });
    const gw = gatewayCommand({ queueRows: rows });
    gw.exitOverride();
    await gw.parseAsync(["node", "gateway", "human", "remove", "mike"], { from: "node" as never });
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(false);
    const out = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as { ok: boolean; archivedPath: string };
    expect(out.ok).toBe(true);
    expect(existsSync(out.archivedPath)).toBe(true);
  });
});
