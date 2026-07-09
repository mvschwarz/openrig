// OPR.0.4.6.MH1 FR-5/FR-6 — the narrow named host add/pair route family
// (arch pins P1–P4) + the daemon writer twin.
//
// Pins under test:
//   P2 — the daemon add route NEVER accepts secret VALUES (named negative).
//   P3 — the daemon writer is BYTE-PARITY-pinned to the CLI addHostEntry
//        (same entries in → identical yaml bytes out) and shares the
//        reader twin's validation (reserved ids surface verbatim).
//   FR-6 — pair-request mints ONE human approval moment (a human-routed
//        qitem via the shipped machinery); approval hands the bearer over
//        exactly once; deny/expiry persists nothing.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
// 044/048 carry the summary + evidence_ref columns — without them the
// repo's persistSummary/persistEvidenceRef silently no-op (the WF-2
// fixture lesson: migrate what you assert on).
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { isHumanSeatSessionRef, parseSessionName } from "../src/domain/session-name.js";
import { addHostEntry as daemonAddHostEntry } from "../src/domain/hosts/hosts-registry-writer.js";
import { addHostEntry as cliAddHostEntry } from "../../cli/src/host-registry.js";
import { hostsRoutes } from "../src/routes/hosts.js";

const BEARER = "test-bearer-token-fixture";

function buildApp(queueRepo: QueueRepository, bearerToken: string | null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, queueRepo);
    await next();
  });
  app.route("/api/hosts", hostsRoutes({ bearerToken }));
  return app;
}

describe("hosts-registry writer twin — P3 byte parity with the CLI addHostEntry", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), "mh1-parity-cli-"));
    dirB = mkdtempSync(join(tmpdir(), "mh1-parity-daemon-"));
  });
  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  const SEQUENCE: Array<Record<string, unknown>> = [
    { id: "vm-a", transport: "ssh", target: "vm-a.local", user: "admin" },
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "VPS_B_TOKEN" },
    { id: "vps-c", transport: "http", url: "http://vps-c:7433", bearer_file: "/tmp/tok", notes: "paired 2026-07-07" },
  ];

  it("same entry sequence in → identical yaml bytes out", () => {
    const pathA = join(dirA, "hosts.yaml");
    const pathB = join(dirB, "hosts.yaml");
    for (const entry of SEQUENCE) {
      expect(cliAddHostEntry(entry, pathA).ok).toBe(true);
      expect(daemonAddHostEntry(entry, pathB).ok).toBe(true);
    }
    expect(readFileSync(pathB, "utf8")).toBe(readFileSync(pathA, "utf8"));
  });

  it("identical validation verdicts: reserved id + exactly-one-bearer rejected by BOTH, same error text", () => {
    const pathA = join(dirA, "hosts.yaml");
    const pathB = join(dirB, "hosts.yaml");
    for (const bad of [
      { id: "local", transport: "ssh", target: "a" },
      { id: "../escape", transport: "ssh", target: "a" },
      { id: "x", transport: "http", url: "http://x" },
      { id: "x", transport: "http", url: "http://x", bearer_env: "T", bearer_file: "/f" },
    ]) {
      const a = cliAddHostEntry(bad, pathA);
      const b = daemonAddHostEntry(bad, pathB);
      expect(a.ok).toBe(false);
      expect(b.ok).toBe(false);
      // The error text embeds each writer's own registry PATH — normalize
      // it away; the parity pin is the validation message, not the tmp dir.
      if (!a.ok && !b.ok) expect(b.error.replaceAll(pathB, "<path>")).toBe(a.error.replaceAll(pathA, "<path>"));
    }
    expect(existsSync(pathA)).toBe(false);
    expect(existsSync(pathB)).toBe(false);
  });
});

describe("POST /api/hosts/add — the narrow named add seam", () => {
  let db: Database.Database;
  let app: Hono;
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mh1-hosts-add-"));
    savedHome = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = home;
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    app = buildApp(repo, BEARER);
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = savedHome;
  });

  const auth = { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" };

  it("writes a valid entry through the writer twin and the CLI-visible registry file", async () => {
    const res = await app.request("/api/hosts/add", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "vps-a", transport: "http", url: "http://vps-a:7433", bearer_env: "VPS_A_TOKEN" }),
    });
    expect(res.status).toBe(200);
    const yaml = readFileSync(join(home, "hosts.yaml"), "utf8");
    expect(yaml).toContain("vps-a");
    expect(yaml).toContain("bearer_env: VPS_A_TOKEN");
  });

  it("P2 named negative: a secret-value-shaped field is rejected and NOTHING is written", async () => {
    const res = await app.request("/api/hosts/add", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "vps-a", transport: "http", url: "http://vps-a:7433", token: "s3cr3t-value" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("no_secret_values");
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
  });

  it("reserved ids surface the validator error verbatim (FR-7 at the daemon door)", async () => {
    const res = await app.request("/api/hosts/add", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "kernel", transport: "ssh", target: "a" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain("reserved host id");
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
  });

  it("the write seam is bearer-gated (401 without the token when one is configured)", async () => {
    const res = await app.request("/api/hosts/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "vps-a", transport: "ssh", target: "a" }),
    });
    expect(res.status).toBe(401);
  });

  // rev1-r1 D: P1's "no generic registry-write route" pinned as a
  // NEGATIVE — the surface is exactly add + the pair handshake; anything
  // remove/edit-shaped does not exist.
  it("R1-D: no generic registry-write route exists (remove/edit/PUT/DELETE all 404)", async () => {
    for (const [method, url] of [
      ["POST", "/api/hosts/remove"],
      ["POST", "/api/hosts/edit"],
      ["PUT", "/api/hosts"],
      ["PUT", "/api/hosts/vps-a"],
      ["DELETE", "/api/hosts/vps-a"],
      ["PATCH", "/api/hosts/vps-a"],
    ] as const) {
      const res = await app.request(url, { method, headers: auth, body: method === "PUT" || method === "POST" || method === "PATCH" ? JSON.stringify({ id: "vps-a" }) : undefined });
      expect(res.status, `${method} ${url} must not exist`).toBe(404);
    }
  });
});

describe("pair-request — the target-side issuance handshake (FR-6)", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    // The REAL gate composition (startup.ts shape): human seats pass
    // before parse — pairing's approval item rides it.
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: (ref) => {
        if (isHumanSeatSessionRef(ref)) return true;
        return parseSessionName(ref).kind === "canonical";
      },
    });
    app = buildApp(repo, BEARER);
  });
  afterEach(() => db.close());

  async function issue(): Promise<{ pairId: string; code: string; approvalQitemId: string }> {
    const res = await app.request("/api/hosts/pair-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requester: "tester@somewhere" }),
    });
    expect(res.status).toBe(200);
    return await res.json() as { pairId: string; code: string; approvalQitemId: string };
  }

  it("a tokenless target refuses loudly with pair_target_no_bearer (nothing to issue)", async () => {
    const tokenless = buildApp(repo, null);
    const res = await tokenless.request("/api/hosts/pair-request", { method: "POST", body: "{}" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("pair_target_no_bearer");
  });

  it("issuance mints the ONE human approval moment: a human-routed qitem with code + summary + evidence_ref", async () => {
    const { code, approvalQitemId } = await issue();
    const item = repo.getById(approvalQitemId)!;
    expect(item.destinationSession).toBe("human-operator@kernel");
    expect(item.tier).toBe("human-gate");
    expect(item.summary).toContain(code);
    expect(item.evidenceRef).toContain("pair-request:");
    expect(item.state).toBe("pending");
  });

  it("approve (close done) → approved + the bearer token, SINGLE-SHOT; the pairing then dies", async () => {
    const { pairId, approvalQitemId } = await issue();

    const pending = await app.request(`/api/hosts/pair-request/${pairId}`);
    expect(((await pending.json()) as { status: string }).status).toBe("pending");

    await repo.update({ qitemId: approvalQitemId, actorSession: "human-operator@kernel", state: "done", closureReason: "no-follow-on" });

    const approved = await app.request(`/api/hosts/pair-request/${pairId}`);
    const body = await approved.json() as { status: string; token: string };
    expect(body.status).toBe("approved");
    expect(body.token).toBe(BEARER);

    const second = await app.request(`/api/hosts/pair-request/${pairId}`);
    expect(second.status).toBe(404);
  });

  it("deny → status denied, and the pairing dies (nothing to hand over)", async () => {
    const { pairId, approvalQitemId } = await issue();
    await repo.update({ qitemId: approvalQitemId, actorSession: "human-operator@kernel", state: "denied" });
    const res = await app.request(`/api/hosts/pair-request/${pairId}`);
    expect(((await res.json()) as { status: string }).status).toBe("denied");
    const second = await app.request(`/api/hosts/pair-request/${pairId}`);
    expect(second.status).toBe(404);
  });
});

describe("local pair-client seam — POST /pair + GET /pair/:id (the browser's write seam, B1)", () => {
  let db: Database.Database;
  let app: Hono;
  let home: string;
  let savedHome: string | undefined;
  let target: http.Server;
  let targetPort: number;
  let targetState: { status: string; token?: string };
  let targetRequests: number;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "mh1-pair-client-"));
    savedHome = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = home;
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    app = buildApp(new QueueRepository(db, new EventBus(db), { validateRig: () => true }), BEARER);

    targetState = { status: "pending" };
    targetRequests = 0;
    target = http.createServer((req, res) => {
      targetRequests += 1;
      if (req.method === "POST" && req.url === "/api/hosts/pair-request") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pairId: "remote-pair-1", code: "123456", approvalQitemId: "qitem-x" }));
      } else if (req.method === "GET" && req.url === "/api/hosts/pair-request/remote-pair-1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(targetState));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => target.listen(0, resolve));
    targetPort = (target.address() as { port: number }).port;
  });
  afterEach(() => {
    db.close();
    target.close();
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = savedHome;
  });

  const auth = { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" };

  it("approved walk: token file lands 0600 + registry entry via the writer twin", async () => {
    const started = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}`, id: "vps-paired" }),
    });
    expect(started.status).toBe(200);
    const { pairId, code } = await started.json() as { pairId: string; code: string };
    expect(code).toBe("123456");

    targetState = { status: "approved", token: "remote-bearer-value" };
    const done = await app.request(`/api/hosts/pair/${pairId}`, { headers: auth });
    const body = await done.json() as { status: string; entry: { id: string } };
    expect(body.status).toBe("approved");
    expect(body.entry.id).toBe("vps-paired");

    const tokenPath = join(home, "secrets", "host-vps-paired.token");
    expect(readFileSync(tokenPath, "utf8")).toBe("remote-bearer-value\n");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    const yaml = readFileSync(join(home, "hosts.yaml"), "utf8");
    expect(yaml).toContain("vps-paired");
    expect(yaml).toContain(`bearer_file: ${tokenPath}`);
    expect(yaml).not.toContain("remote-bearer-value");
  });

  it("denied walk: NOTHING persists (no token file, no registry entry)", async () => {
    const started = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}` }),
    });
    const { pairId } = await started.json() as { pairId: string };

    targetState = { status: "denied" };
    const done = await app.request(`/api/hosts/pair/${pairId}`, { headers: auth });
    expect(((await done.json()) as { status: string }).status).toBe("denied");
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
    expect(existsSync(join(home, "secrets"))).toBe(false);
  });

  // B1 fixback (guard code-review 2026-07-07): a failed pair must never
  // clobber or delete pre-existing credential/registry state, and must
  // fail BEFORE the target is ever contacted.
  it("B1: duplicate-id re-pair fails at PREFLIGHT — registry bytes, token contents and 0600 mode preserved; target NEVER contacted", async () => {
    const secretsDir = join(home, "secrets");
    const tokenPath = join(secretsDir, "host-vps-paired.token");
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, "live-credential\n", { mode: 0o600 });
    expect(daemonAddHostEntry({ id: "vps-paired", transport: "http", url: "http://old-target:7433", bearer_file: tokenPath }).ok).toBe(true);
    const yamlBefore = readFileSync(join(home, "hosts.yaml"), "utf8");

    const res = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}`, id: "vps-paired" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("invalid_host_entry");
    expect(body.message).toContain("duplicate host id");

    expect(targetRequests).toBe(0);
    expect(readFileSync(join(home, "hosts.yaml"), "utf8")).toBe(yamlBefore);
    expect(readFileSync(tokenPath, "utf8")).toBe("live-credential\n");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("B1: a pre-existing token file at the derived path rejects the pair before target contact — file untouched", async () => {
    const secretsDir = join(home, "secrets");
    const tokenPath = join(secretsDir, "host-127-0-0-1.token");
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, "stale-but-not-ours-to-delete\n", { mode: 0o600 });

    const res = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}` }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("pair_token_path_exists");

    expect(targetRequests).toBe(0);
    expect(readFileSync(tokenPath, "utf8")).toBe("stale-but-not-ours-to-delete\n");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
  });

  // rev1-r2 B1: path-bearing ids die at the registry-door preflight.
  it("rev1-r2 B1: a path-bearing id is rejected at POST /pair preflight; target never contacted", async () => {
    const res = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}`, id: "../escape" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("invalid_host_entry");
    expect(body.message).toContain("not a valid host id");
    expect(targetRequests).toBe(0);
    expect(existsSync(join(home, "secrets"))).toBe(false);
  });

  // rev1-r2 B3: exclusive-create ("wx") — a token file appearing during
  // the approval wait is refused, never overwritten or deleted.
  it("rev1-r2 B3: a token file appearing during the approval wait → 409, winner's contents preserved", async () => {
    const started = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}`, id: "vps-mid" }),
    });
    const { pairId } = await started.json() as { pairId: string };

    const tokenPath = join(home, "secrets", "host-vps-mid.token");
    mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, "winner-credential\n", { mode: 0o600 });

    targetState = { status: "approved", token: "issued-bearer" };
    const done = await app.request(`/api/hosts/pair/${pairId}`, { headers: auth });
    expect(done.status).toBe(409);
    expect(((await done.json()) as { error: string }).error).toBe("pair_token_path_exists");
    expect(readFileSync(tokenPath, "utf8")).toBe("winner-credential\n");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
  });

  it("B1: add failure AFTER approval (preflight/add race) removes only the token THIS pairing created; the racing entry survives", async () => {
    const started = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}`, id: "vps-race" }),
    });
    expect(started.status).toBe(200);
    const { pairId } = await started.json() as { pairId: string };

    // The TOCTOU window preflight cannot close: a conflicting entry lands
    // during the approval wait. addHostEntry stays authoritative.
    expect(daemonAddHostEntry({ id: "vps-race", transport: "http", url: "http://racer:7433", bearer_env: "RACER_TOKEN" }).ok).toBe(true);
    const yamlBefore = readFileSync(join(home, "hosts.yaml"), "utf8");

    targetState = { status: "approved", token: "issued-bearer" };
    const done = await app.request(`/api/hosts/pair/${pairId}`, { headers: auth });
    expect(done.status).toBe(400);
    expect(((await done.json()) as { error: string }).error).toBe("invalid_host_entry");

    expect(readFileSync(join(home, "hosts.yaml"), "utf8")).toBe(yamlBefore);
    expect(existsSync(join(home, "secrets", "host-vps-race.token"))).toBe(false);
  });
});
