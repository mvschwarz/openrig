import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { createServer } from "node:http";
import { once } from "node:events";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";
import { DaemonClient } from "../../cli/src/client.js";
import { queueCommand } from "../../cli/src/commands/queue.js";
import { runProgram } from "../../cli/src/cli-error.js";

vi.mock("../../cli/src/daemon-lifecycle.js", () => ({
  getDaemonStatus: async () => ({ state: "running", healthy: true, port: 12345 }),
  getDaemonUrl: () => "http://queue.invalid",
  daemonStatusGuard: vi.fn(),
}));

const BODY = "Complete assignment\n" + "東京 🧭 preserve every byte\n".repeat(150);
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// Actual CLI/client deadline, Hono routes and SQLite transactions. Most controls
// substitute HTTP; pre-header-loss controls use private loopback sockets. Pane
// wake is substituted throughout; no native seats or disk DB.
function harness() {
  let endpoint: string | undefined;
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true });
  repo.attachOutbox(new OutboxHandler(db));
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, repo as never);
    c.set("eventBus" as never, bus as never);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  const requests: Array<{ path: string; body: Record<string, unknown>; stderr: string[] }> = [];
  const pending: Promise<Response>[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
  let beforeNextRequest: Promise<void> | undefined;
  let corruptNextResponse = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const gate = beforeNextRequest;
    beforeNextRequest = undefined;
    const corrupt = corruptNextResponse;
    corruptNextResponse = false;
    requests.push({ path: new URL(url).pathname, body: init?.body ? JSON.parse(String(init.body)) : {}, stderr: [...stderr] });
    const server = (async () => {
      if (gate) await gate;
      // A client abort does not undo an accepted server request. Deliberately
      // do not pass its signal to the server side of this simulated transport.
      const response = await app.request(url, { ...init, signal: undefined });
      return corrupt ? new Response("{", { status: response.status }) : response;
    })();
    pending.push(server);
    return new Promise<Response>((resolve, reject) => {
      const aborted = () => reject(init?.signal?.reason);
      if (init?.signal?.aborted) { aborted(); return; }
      init?.signal?.addEventListener("abort", aborted, { once: true });
      server.then(resolve, reject).finally(() => init?.signal?.removeEventListener("abort", aborted));
    });
  };
  async function run(args: string[], json = true) {
    stdout.length = 0;
    stderr.length = 0;
    process.exitCode = undefined;
    const program = new Command();
    program.addCommand(queueCommand({
      lifecycleDeps: {} as never,
      deliveryVerify: { timeoutMs: 0 },
      clientFactory: () => new DaemonClient(endpoint ?? "http://queue.invalid", endpoint ? { timeoutMs: 1500 } : { fetchImpl, timeoutMs: 40 }),
    }));
    const code = await runProgram(program, ["node", "rig", "queue", ...args, ...(json ? ["--json"] : [])], {
      out: (line) => stdout.push(line), err: (line) => stderr.push(line), exit: () => {},
    });
    if (json) expect(stdout).toHaveLength(1); // no pre-request receipt on machine stdout
    return { code: process.exitCode ?? code, data: json ? JSON.parse(stdout[0]!) : undefined, stdout: [...stdout], stderr: [...stderr] };
  }
  return {
    db, repo, requests, pending, run, app,
    networkEndpoint: (url: string) => { endpoint = url; },
    delayNext: (gate: Promise<void>) => { beforeNextRequest = gate; },
    corruptNext: () => { corruptNextResponse = true; },
    rows: () => db.prepare("SELECT qitem_id, state, body, handed_off_from FROM queue_items ORDER BY rowid").all() as Array<{ qitem_id: string; state: string; body: string; handed_off_from: string | null }>,
  };
}

const createArgs = ["create", "--destination", "reader@fixture", "--body", BODY, "--summary", "Retain assignment"];

describe("queue unknown-write reconciliation", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "writer@fixture");
    h = harness();
  });
  afterEach(async () => {
    await Promise.all(h.pending);
    await new Promise<void>((resolve) => setImmediate(resolve));
    h.db.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  it("emits the create ID before sending; a negative read before late commit does not require a new ID", async () => {
    const gate = deferred();
    h.delayNext(gate.promise);
    try {
      const first = await h.run(createArgs);
      expect(first.code).not.toBe(0);
      expect(h.rows()).toEqual([]); // request accepted but not yet transacted
      const id = h.requests[0]!.body.qitemId;
      // Use the offered recovery ID, if any. The old CLI offered none, so an
      // ordinary retry after this negative read reproduces two owed rows.
      if (typeof id === "string") expect(h.repo.getById(id)).toBeNull();
      const retry = await h.run([...createArgs, ...(typeof id === "string" ? ["--id", id] : []), "--no-nudge"]);
      expect(retry.code).toBe(0);
      gate.resolve();
      await Promise.all(h.pending);
      expect(h.rows()).toHaveLength(1);
      expect(typeof id).toBe("string");
      expect(h.requests[0]!.stderr.join("\n")).toContain(String(id));
      expect(JSON.stringify(first.data)).toContain(String(id));
      expect(JSON.stringify(first.data)).toContain("--id");
      expect(h.rows()).toEqual([{ qitem_id: id, state: "pending", body: BODY, handed_off_from: null }]);
    } finally { gate.resolve(); }
  });

  it("returns the committed create while its wake is held; same-ID retry adds no wake", async () => {
    const wake = deferred();
    const send = vi.fn(async () => { await wake.promise; return { ok: true, verified: true }; });
    h.repo.attachTransport({ send });
    try {
      const first = await h.run([...createArgs, "--id", "qitem-explicit"]);
      expect(first.code).toBe(0);
      expect(h.rows()).toHaveLength(1); // receipt precedes wake completion
      expect(send).toHaveBeenCalledTimes(1);
      const retry = await h.run([...createArgs, "--id", "qitem-explicit"]);
      expect(retry.code).toBe(0);
      expect(retry.data.body).toBe(BODY);
      expect(retry.data.qitemId).toBe("qitem-explicit");
      expect(send).toHaveBeenCalledTimes(1); // PK absorb does not repeat delivery
    } finally { wake.resolve(); }
    await Promise.all(h.pending);
    expect(h.rows()).toHaveLength(1);
  });

  it.each(["create", "handoff", "handoff-and-complete"])("%s returns an HTTP persistence receipt while wake delivery is held", async (verb) => {
    if (verb !== "create") {
      await h.repo.create({ qitemId: "qitem-source", sourceSession: "origin@fixture", destinationSession: "writer@fixture", body: BODY, nudge: false });
      h.repo.claim({ qitemId: "qitem-source", destinationSession: "writer@fixture" });
    }
    const wake = deferred();
    let released = false;
    const send = vi.fn(async () => { await wake.promise; return { ok: true, verified: true }; });
    h.repo.attachTransport({ send });
    const requests: Promise<void>[] = [];
    const server = createServer((req, res) => {
      const request = (async () => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const response = await h.app.request(`http://queue.invalid${req.url}`, {
          method: req.method, headers: req.headers as Record<string, string>, body,
        });
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(await response.text());
      })();
      requests.push(request);
      void request.catch((err) => res.destroy(err));
    });
    let recipientId: string | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing fixture address");
      h.networkEndpoint(`http://127.0.0.1:${address.port}`);
      const receipt = await h.run(verb === "create" ? [...createArgs, "--id", "qitem-http"]
        : [verb, "qitem-source", "--to", "reader@fixture", "--summary", "Retain assignment"]);
      expect(receipt.code).toBe(0); // actual HTTP response, before the client's deadline
      expect(released).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      const row = h.rows().find((r) => verb === "create" ? r.qitem_id === "qitem-http" : r.handed_off_from === "qitem-source")!;
      recipientId = row.qitem_id;
      expect(row).toMatchObject({ body: BODY, state: "pending" });
      expect(JSON.stringify(receipt.data)).toContain(recipientId);
      expect(h.repo.getById(recipientId)?.lastNudgeResult).toBeNull();
      expect(h.db.prepare("SELECT delivery_state, audit_pointer FROM outbox_entries WHERE outbox_id = ?").get(`wake-intent-${recipientId}`))
        .toEqual({ delivery_state: "sending", audit_pointer: recipientId });
      if (verb !== "create") expect(h.repo.getById("qitem-source")?.state).toBe(verb === "handoff" ? "handed-off" : "done");
    } finally {
      released = true;
      wake.resolve();
      await Promise.all(requests);
      // Delivery can finish after the response; keep the fixture DB open for it.
      const deliveredId = recipientId ?? h.rows().find((r) => r.qitem_id !== "qitem-source")?.qitem_id;
      if (deliveredId) await vi.waitFor(() => expect(h.repo.getById(deliveredId)?.lastNudgeResult).toBe("verified"));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the ID in an unreadable-response JSON error and reconciles the full stored body", async () => {
    h.corruptNext();
    const first = await h.run([...createArgs, "--no-nudge"]);
    expect(first.code).not.toBe(0);
    const id = h.rows()[0]!.qitem_id;
    expect(JSON.stringify(first.data)).toContain("unreadable response");
    expect(JSON.stringify(first.data)).toContain(id);
    const retry = await h.run([...createArgs, "--id", id, "--no-nudge"]);
    expect(retry.code).toBe(0);
    expect(retry.data.body).toBe(BODY);
    expect(h.rows()).toHaveLength(1);
  });

  it("does not conflate intentional new creates with equal content; retry must reuse --id", async () => {
    const first = await h.run([...createArgs, "--no-nudge"]);
    const second = await h.run([...createArgs, "--no-nudge"]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.data.qitemId).not.toBe(second.data.qitemId);
    expect(h.rows()).toHaveLength(2);
  });

  it("keeps same-ID/same-body retries successful and unchanged, without another event or wake", async () => {
    const send = vi.fn(async () => ({ ok: true, verified: true }));
    h.repo.attachTransport({ send });
    const first = await h.run([...createArgs, "--id", "qitem-same-body"]);
    const transitions = h.db.prepare("SELECT * FROM queue_transitions").all();
    const events = h.db.prepare("SELECT * FROM events").all();
    const retry = await h.run([...createArgs, "--id", "qitem-same-body"]);
    expect(retry.code).toBe(0);
    expect(retry.data).toEqual({ ...first.data,
      lastNudgeAttempt: retry.data.lastNudgeAttempt, lastNudgeResult: retry.data.lastNudgeResult,
    }); // delivery may settle between persistence receipts
    expect(retry.data.createWarning).toBeUndefined();
    expect(retry.stderr.join("\n")).not.toContain("not saved");
    expect(h.rows()).toHaveLength(1);
    expect(h.db.prepare("SELECT * FROM queue_transitions").all()).toEqual(transitions);
    expect(h.db.prepare("SELECT * FROM events").all()).toEqual(events);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { json: true, verify: false }, { json: false, verify: false },
    { json: true, verify: true }, { json: false, verify: true },
  ])("warns that a changed body was not saved (json=$json, verify=$verify)", async ({ json, verify }) => {
    const send = vi.fn(async () => ({ ok: true, verified: true }));
    h.repo.attachTransport({ send });
    const first = await h.run([...createArgs, "--id", "qitem-body-conflict"]);
    const before = {
      rows: h.db.prepare("SELECT * FROM queue_items").all(),
      transitions: h.db.prepare("SELECT * FROM queue_transitions").all(),
      events: h.db.prepare("SELECT * FROM events").all(),
    };
    // Difference is beyond the preview, including a final newline. Compare the
    // full body, not a truncated or whitespace-normalized rendering.
    const retry = await h.run([
      "create", "--destination", "reader@fixture", "--body", BODY + "changed tail\n",
      "--summary", "Retain assignment", "--id", "qitem-body-conflict", ...(verify ? ["--verify"] : []),
    ], json);
    expect(retry.code).toBe(0); // additive warning; existing retry callers keep success
    const returned = json ? retry.data : JSON.parse(retry.stdout.join("\n"));
    expect(returned.qitemId).toBe(first.data.qitemId);
    expect(returned.body).toBe(BODY);
    expect(returned.createWarning?.code).toBe("qitem_body_not_saved");
    expect(returned.createWarning?.message).toContain("not saved");
    expect(retry.stderr.join("\n")).toContain("not saved");
    if (verify) {
      // These fields refer to the returned original row, never to the rejected body.
      expect(returned.persisted).toBe(true);
      expect(returned.delivery.outcome).toBe("still-pending");
    }
    expect(h.db.prepare("SELECT * FROM queue_items").all()).toEqual(before.rows);
    expect(h.db.prepare("SELECT * FROM queue_transitions").all()).toEqual(before.transitions);
    expect(h.db.prepare("SELECT * FROM events").all()).toEqual(before.events);
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.repo.getById(first.data.qitemId)).not.toHaveProperty("createWarning");
  });

  // Review-R2's #410 pre-header-loss discriminator, retained as a real HTTP
  // control: the server commits the row, then closes without response headers.
  it.each([true, false])("reports unknown after committed create loses headers (json=%s)", async (json) => {
    let received = 0;
    const server = createServer(async (req, res) => {
      received++;
      let body = "";
      for await (const chunk of req) body += chunk;
      const response = await h.app.request(`http://queue.invalid${req.url}`, {
        method: req.method, headers: req.headers as Record<string, string>, body,
      });
      if (received === 1) res.destroy();
      else { res.writeHead(response.status, { "content-type": "application/json" }); res.end(await response.text()); }
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing fixture address");
      h.networkEndpoint(`http://127.0.0.1:${address.port}`);
      const first = await h.run([...createArgs, "--no-nudge"], json);
      expect(first.code).toBe(1);
      expect(received).toBe(1);
      expect(h.rows()).toHaveLength(1);
      const id = h.rows()[0]!.qitem_id;
      expect(h.rows()[0]!.body).toBe(BODY);
      const rendered = json ? JSON.stringify(first.data) : first.stderr.join("\n");
      expect(rendered).toContain(id);
      expect(rendered).toContain("--id");
      const retry = await h.run([...createArgs, "--id", id, "--no-nudge"]);
      expect(retry.code).toBe(0);
      expect(received).toBe(2);
      expect(h.rows()).toHaveLength(1);
      expect(rendered).not.toContain("The command was not delivered.");
      if (json) expect(first.data.error.consequence).toContain("UNKNOWN");
      else expect(first.stdout).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([true, false])("keeps daemon-down create actionable and reconcilable (json=%s)", async (json) => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h.networkEndpoint(`http://127.0.0.1:${address.port}`);
    const first = await h.run([...createArgs, "--no-nudge"], json);
    expect(first.code).toBe(1);
    expect(h.rows()).toEqual([]);
    const rendered = json ? JSON.stringify(first.data) : first.stderr.join("\n");
    expect(rendered).toContain("Cannot connect");
    expect(rendered).toContain("--id");
    expect(rendered).toContain("UNKNOWN");
    const action = json ? first.data.error.action : rendered;
    expect(action).toContain("rig daemon status");
    expect(action).toContain("rig daemon start");
    expect(action).toContain("before any retry");
  });

  it.each(["handoff", "handoff-and-complete"])("%s preserves the source and exactly one successor through delayed wake and retry", async (verb) => {
    await h.repo.create({ qitemId: "qitem-source", sourceSession: "origin@fixture", destinationSession: "writer@fixture", body: BODY, nudge: false });
    await h.repo.claim({ qitemId: "qitem-source", destinationSession: "writer@fixture" });
    const wake = deferred();
    const send = vi.fn(async () => { await wake.promise; return { ok: true, verified: true }; });
    h.repo.attachTransport({ send });
    const args = [verb, "qitem-source", "--to", "reader@fixture", "--summary", "Retain assignment"];
    try {
      const first = await h.run(args);
      expect(first.code).toBe(0);
      expect(h.rows()).toHaveLength(2);
      const [source, successor] = h.rows();
      expect(source).toMatchObject({ qitem_id: "qitem-source", body: BODY, state: verb === "handoff" ? "handed-off" : "done" });
      expect(successor).toMatchObject({ body: BODY, state: "pending", handed_off_from: "qitem-source" });
      expect(h.db.prepare("SELECT COUNT(*) n FROM outbox_entries").get()).toEqual({ n: 1 });
      const retry = await h.run(args);
      expect(retry.code).not.toBe(0);
      expect(retry.data.error).toBe("qitem_already_terminal");
      expect(h.rows()).toHaveLength(2);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { wake.resolve(); }
  });

  it.each(["handoff", "handoff-and-complete"])("%s leaves the source owned before a late commit and absorbs no second successor", async (verb) => {
    await h.repo.create({ qitemId: "qitem-source", sourceSession: "origin@fixture", destinationSession: "writer@fixture", body: BODY, nudge: false });
    await h.repo.claim({ qitemId: "qitem-source", destinationSession: "writer@fixture" });
    const gate = deferred();
    h.delayNext(gate.promise);
    const args = [verb, "qitem-source", "--to", "reader@fixture", "--summary", "Retain assignment", "--no-nudge"];
    try {
      expect((await h.run(args)).code).not.toBe(0);
      expect(h.rows()).toEqual([{ qitem_id: "qitem-source", state: "in-progress", body: BODY, handed_off_from: null }]);
      expect((await h.run(args)).code).toBe(0);
      gate.resolve();
      const [late] = await Promise.all(h.pending);
      expect(late!.status).toBe(409);
      expect(h.rows()).toHaveLength(2);
      expect(h.rows()[0]).toMatchObject({ body: BODY, state: verb === "handoff" ? "handed-off" : "done" });
      expect(h.rows()[1]).toMatchObject({ body: BODY, state: "pending", handed_off_from: "qitem-source" });
    } finally { gate.resolve(); }
  });
});
