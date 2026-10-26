// A hosted member (an outside tool on the team) whose roster entry declares a webhook is rung when work lands for it:
// a pointer to the row (never its body), the Authorization header from a secret, a timeout, and no redirect followed.
// A 2xx is "wake accepted", never delivered: pickup is the member's claim. Real SQLite, the real queue, a real local
// HTTP receiver. Native: no real tool was rung.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { hostedWakeFor, parseRoster, type RosterWake } from "../src/domain/rosters.js";
import { ringHostedWake } from "../src/domain/hosted-wake.js";

type Received = { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };
type Reply = { status: number; headers?: Record<string, string> } | "hang";

describe("a hosted member with a webhook trigger is rung when work lands for it", () => {
  let server: Server;
  let url: string;
  let received: Received[];
  let reply: Reply;
  let dir: string;

  beforeEach(async () => {
    received = [];
    reply = { status: 202 };
    dir = mkdtempSync(join(tmpdir(), "hosted-wake-"));
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => {
        received.push({ path: req.url ?? "", headers: req.headers, body: data ? JSON.parse(data) as Record<string, unknown> : {} });
        if (reply === "hang") return;
        res.writeHead(reply.status, reply.headers);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  const wake: RosterWake = { webhook: { url_ref: "GROK_WAKE_URL", authorization_ref: "GROK_WAKE_AUTH" } };
  const env = () => ({ GROK_WAKE_URL: url, GROK_WAKE_AUTH: "Bearer test-only-value" });
  const ring = { qitemId: "qitem-1", destination: "grok@lab", summary: "Find the release notes", source: "lead@lab" };

  it("rings with a pointer to the row and the Authorization header, and records wake accepted, not delivered", async () => {
    const outcome = await ringHostedWake(ring, wake, { env: env() });
    expect(outcome).toEqual({ classified: "indeterminate", nudgeResult: "wake-accepted:webhook (GROK_WAKE_URL) answered 202; pickup is the member's claim on this row" });
    expect(received).toHaveLength(1);
    expect(received[0]!.headers.authorization).toBe("Bearer test-only-value");
    expect(received[0]!.body).toEqual({ source: "openrig.queue", schema_version: 1, event: "work-waiting",
      qitem_id: "qitem-1", destination: "grok@lab", summary: "Find the release notes", from: "lead@lab" });
    // The URL can itself be a credential: the recorded result names its secret, never the URL.
    expect(outcome.nudgeResult).not.toContain(url);
  });

  it("records a failed ring for an error, a redirect it doesn't follow, a missing secret and a trigger that doesn't answer", async () => {
    reply = { status: 500 };
    expect(await ringHostedWake(ring, wake, { env: env() })).toEqual({ classified: "failed", nudgeResult: "failed:webhook (GROK_WAKE_URL) answered 500" });

    reply = { status: 302, headers: { location: "/elsewhere" } };
    expect((await ringHostedWake(ring, wake, { env: env() })).nudgeResult).toBe("failed:webhook (GROK_WAKE_URL) answered 302, a redirect, which isn't followed");
    expect(received.map((r) => r.path)).toEqual(["/hook", "/hook"]);

    expect((await ringHostedWake(ring, wake, { env: {} })).nudgeResult).toBe("failed:webhook (GROK_WAKE_URL) isn't set: no webhook URL to ring");
    expect((await ringHostedWake(ring, wake, { env: { GROK_WAKE_URL: url } })).nudgeResult)
      .toBe("failed:webhook (GROK_WAKE_URL) not rung: its Authorization value (GROK_WAKE_AUTH) isn't set");
    expect(received).toHaveLength(2);

    reply = "hang";
    expect((await ringHostedWake(ring, wake, { env: env(), timeoutMs: 100 })).nudgeResult).toBe("failed:webhook (GROK_WAKE_URL) didn't answer within 100 ms");
  });

  it("through the queue: work for the member rings its trigger from the roster's secrets file, never its terminal, and a claim stays a separate fact", async () => {
    const db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    // Real topology, so an address with no binding classifies as it does on a running daemon.
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-lab', 'lab')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('node-lead', 'rig-lab', 'lead', 'claude-code', '/tmp')").run();
    const secrets = join(dir, "grok.env");
    writeFileSync(secrets, `GROK_WAKE_URL=${url}\nGROK_WAKE_AUTH=Bearer test-only-value\n`, { mode: 0o600 });
    const declared: RosterWake = { webhook: { ...wake.webhook, secrets_env_file: secrets } };
    let typed = 0;
    let trigger: RosterWake | null = declared;
    const repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true, entities: [] }),
      transport: { send: async () => { typed += 1; return { ok: true, verified: true }; } },
      hostedWake: (destination) => destination === "grok@lab" ? trigger : null,
    });
    expect(repo.classifyDestinationOf("grok@lab")).toEqual({ class: "hosted", wake: declared });
    // The create's own wake rings it (this repository has no outbox, so the wake runs inline).
    const row = await repo.create({ sourceSession: "lead@lab", destinationSession: "grok@lab", body: "the full brief", summary: "Find the release notes" });
    expect(typed).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]!.body).toMatchObject({ qitem_id: row.qitemId, destination: "grok@lab", summary: "Find the release notes", from: "lead@lab" });
    expect(JSON.stringify(received[0]!.body)).not.toContain("the full brief");
    expect(repo.getById(row.qitemId)!.lastNudgeResult).toMatch(/^wake-accepted:webhook \(GROK_WAKE_URL\) answered 202/);
    repo.claim({ qitemId: row.qitemId, destinationSession: "grok@lab" });
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "in-progress", lastNudgeResult: expect.stringMatching(/^wake-accepted:/) });

    // A hosted member with no trigger stays unroutable, so its person is told (step 1, unchanged).
    trigger = null;
    expect(repo.classifyDestinationOf("grok@lab").class).toBe("unroutable");
    db.close();
  });

  it("reads the trigger from the authored roster for a hosted member on this host only", () => {
    const roster = {
      version: 1, id: "lab", name: "Lab", purpose: "trials", curator: { seat: "lead@lab", host: "h1" }, updated_at: "2026-10-26",
      members: [
        { seat: "grok@lab", host: "h1", capabilities: ["x search"], engagement: ["queue"], use_when: "live search", why: "fast", hosted: true, wake },
        { seat: "other@lab", host: "h1", capabilities: ["a"], engagement: ["queue"], use_when: "u", why: "w", wake },
      ],
    };
    writeFileSync(join(dir, "lab.json"), JSON.stringify(roster));
    expect(hostedWakeFor("grok@lab", dir, "h1")).toEqual(wake);
    expect(hostedWakeFor("grok@lab", dir, "h2")).toBeNull();
    expect(hostedWakeFor("grok@lab", dir, null)).toBeNull();
    expect(hostedWakeFor("other@lab", dir, "h1")).toBeNull(); // not hosted
    expect(() => parseRoster({ ...roster, members: [{ ...roster.members[0], wake: { webhook: { url: "https://example.invalid" } } }] }))
      .toThrow("A member's wake needs webhook.url_ref");
  });
});
