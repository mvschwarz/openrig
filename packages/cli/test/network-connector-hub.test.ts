// The outbound connector against a real hub: the daemon's routes behind `rig mcp serve --http` with a grant per
// participant, reached by the connector's own MCP client. A second, local queue takes the work, and what happens there
// comes back to the hub item: queued, picked up, the result, and a revoked grant ending the binding.
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type Database from "better-sqlite3";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
import { RigRepository } from "../../daemon/src/domain/rig-repository.js";
import { NetworkBindingStore } from "../../daemon/src/domain/network/network-bindings.js";
import { networkClosedElsewhere, runNetworkBindingPass, type NetworkConnectorDeps } from "../../daemon/src/domain/network/network-connector.js";
import { addGrant, revokeGrant, startMcpHttpServer } from "../src/mcp-http.js";

let hubDb: Database.Database;
let localDb: Database.Database;
let hubHome: string;
let localHome: string;
let hubRepo: QueueRepository;
let daemon: ServerType;
let hubUrl: string;
let tokenFile: string;
const closers: Array<() => Promise<void>> = [];
const saved = { home: process.env.OPENRIG_HOME, session: process.env.OPENRIG_SESSION_NAME };

const queue = (db: Database.Database) => {
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true as const, entities: [] }) });
  repo.attachOutbox(new OutboxHandler(db));
  return repo;
};

beforeEach(async () => {
  hubDb = createDb(":memory:");
  migrate(hubDb, ALL_MIGRATIONS);
  hubHome = fs.mkdtempSync(path.join(os.tmpdir(), "network-hub-"));
  localHome = fs.mkdtempSync(path.join(os.tmpdir(), "network-local-"));
  process.env.OPENRIG_HOME = hubHome;
  process.env.OPENRIG_SESSION_NAME = "env-seat@elsewhere";
  tokenFile = path.join(hubHome, "mcp-http-tokens.json");
  hubRepo = queue(hubDb);
  const inert = async () => ({ ok: false, error: "inert fixture" });
  const { app } = createTestApp(hubDb, { appDeps: {
    sessionTransport: { resolveSessions: async () => ({ ok: false, code: "not_found", error: "inert fixture" }), send: inert, capture: inert, broadcast: inert } as never,
    queueRepo: hubRepo,
  } });
  daemon = await new Promise<ServerType>((resolve) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
  const served = await startMcpHttpServer({ daemonUrl: `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`, host: "127.0.0.1", port: 0, tokenFile });
  closers.push(() => served.close());
  hubUrl = served.url;

  localDb = createDb(":memory:");
  migrate(localDb, ALL_MIGRATIONS);
  const rigs = new RigRepository(localDb);
  const node = rigs.addNode(rigs.createRig("lab").id, "impl", { runtime: "claude-code" });
  localDb.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', ?, 'dev-impl@lab', 'running')").run(node.id);
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
  hubDb.close();
  localDb.close();
  fs.rmSync(hubHome, { recursive: true, force: true });
  fs.rmSync(localHome, { recursive: true, force: true });
  if (saved.home === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = saved.home;
  if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = saved.session;
});

it("takes the participant's item over the wire, carries pickup and the result back, and a revoked grant ends the binding", async () => {
  const token = await addGrant(tokenFile, { name: "alex", seat: "alex@team", rigs: ["team"], roots: [], workspace: false, owner: false });
  // Longer than a list preview, with its end marked, so a shortened body would show.
  const body = `Summarize the release notes. ${"Context. ".repeat(400)}END-OF-BODY`;
  const task = await hubRepo.create({ sourceSession: "lead@team", destinationSession: "alex@team", summary: "Summarize the notes", body, nudge: false } as never);

  const localRepo = queue(localDb);
  const bindings = new NetworkBindingStore(localDb, localHome);
  // The test hub listens on loopback http, so the binding records the person's --allow-http choice.
  const binding = bindings.create({ session: "dev-impl@lab", hubUrl, hubSeat: "alex@team", token, allowHttp: true });
  const deps: NetworkConnectorDeps = { db: localDb, queueRepo: localRepo, bindings, home: localHome };
  const pass = () => runNetworkBindingPass(deps, bindings.get(binding.id)!);
  const notes = () => hubRepo.listTransitions(task.qitemId).map((t) => t.transitionNote).filter(Boolean);

  const first = await pass();
  expect(first.error).toBeUndefined();
  expect(first).toMatchObject({ taken: 1 });
  const [local] = localRepo.list({ limit: 50 });
  expect(local).toMatchObject({ sourceSession: "daemon@kernel", destinationSession: "dev-impl@lab", summary: "From lead@team via network hub: Summarize the notes", state: "pending" });
  expect(local!.body!.split("\n")[0]).toBe(`From lead@team through the network hub ${hubUrl}, as alex@team (hub item ${task.qitemId}).`);
  expect(local!.body).toContain(body);
  expect(hubRepo.getById(task.qitemId)!.state).toBe("in-progress");
  expect(notes().at(-1)).toBe(`Queued for the connected local seat as ${local!.qitemId}. Not picked up yet.`);
  expect(hubRepo.listTransitions(task.qitemId).find((t) => t.state === "in-progress")?.actorSession).toMatch(/^alex@team/);

  expect(await pass()).toMatchObject({ taken: 0, pickupsSent: 0 });
  expect(localRepo.list({ limit: 50 })).toHaveLength(1);

  localRepo.claim({ qitemId: local!.qitemId, destinationSession: "dev-impl@lab" });
  expect(await pass()).toMatchObject({ pickupsSent: 1 });
  expect(notes().at(-1)).toMatch(/^Picked up by the local seat at /);
  expect(hubRepo.getById(task.qitemId)!.state).toBe("in-progress");

  await localRepo.update({ qitemId: local!.qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "no-follow-on", resolution: "Three changes; none breaking." });
  expect(await pass()).toMatchObject({ resultsSent: 1 });
  expect(hubRepo.getById(task.qitemId)).toMatchObject({ state: "done", resolution: "Three changes; none breaking." });
  expect(bindings.get(binding.id)!.lastError).toBeNull();

  // A failure and a cancel close the hub item the way its queue takes them: failed, and done with closure reason canceled.
  const failing = await hubRepo.create({ sourceSession: "lead@team", destinationSession: "alex@team", summary: "Build it", body: "Build the release.", nudge: false } as never);
  const dropped = await hubRepo.create({ sourceSession: "lead@team", destinationSession: "alex@team", summary: "Skip it", body: "Maybe not.", nudge: false } as never);
  expect(await pass()).toMatchObject({ taken: 2 });
  const byHub = (id: string) => localRepo.list({ limit: 50 }).find((i) => (i.tags ?? []).includes(`network-hub-item:${id}`))!;
  await localRepo.update({ qitemId: byHub(failing.qitemId).qitemId, actorSession: "dev-impl@lab", state: "failed", transitionNote: "The build broke." });
  await localRepo.update({ qitemId: byHub(dropped.qitemId).qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "canceled", resolution: "Not needed." });
  expect(await pass()).toMatchObject({ resultsSent: 2 });
  expect(hubRepo.getById(failing.qitemId)).toMatchObject({ state: "failed", resolution: "The build broke." });
  expect(hubRepo.getById(dropped.qitemId)).toMatchObject({ state: "done", closureReason: "canceled", resolution: "Not needed." });

  // Two items the requester fails on the hub while they're queued here. Our failed and done results then aren't ours to
  // deliver: the hub items keep their failure, and the receipts say closed elsewhere.
  const theirs = [
    await hubRepo.create({ sourceSession: "lead@team", destinationSession: "alex@team", summary: "One", body: "First.", nudge: false } as never),
    await hubRepo.create({ sourceSession: "lead@team", destinationSession: "alex@team", summary: "Two", body: "Second.", nudge: false } as never),
  ];
  expect(await pass()).toMatchObject({ taken: 2 });
  for (const item of theirs) await hubRepo.update({ qitemId: item.qitemId, actorSession: "lead@team", state: "failed", resolution: "Dropped by the requester." } as never);
  await localRepo.update({ qitemId: byHub(theirs[0]!.qitemId).qitemId, actorSession: "dev-impl@lab", state: "failed", transitionNote: "Could not finish." });
  await localRepo.update({ qitemId: byHub(theirs[1]!.qitemId).qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "no-follow-on", resolution: "Finished it." });
  expect(await pass()).toMatchObject({ resultsSent: 0 });
  for (const item of theirs) expect(hubRepo.getById(item.qitemId)).toMatchObject({ state: "failed", resolution: "Dropped by the requester." });
  expect(localDb.prepare("SELECT DISTINCT outcome FROM network_receipts WHERE hub_qitem_id IN (?, ?)").all(theirs[0]!.qitemId, theirs[1]!.qitemId)).toEqual([{ outcome: "closed_on_hub" }]);

  // An operator on the hub hands the original on to another seat while it's queued here. It's closed to the connector:
  // nothing is written to it, the original and its successor are unchanged, status shows it, and it isn't retried.
  const handed = await hubRepo.create({ sourceSession: "lead@team", destinationSession: "alex@team", summary: "Three", body: "Third.", nudge: false } as never);
  expect(await pass()).toMatchObject({ taken: 1 });
  const { created: successor } = await hubRepo.handoff({ qitemId: handed.qitemId, fromSession: "lead@team", toSession: "other@team", nudge: false });
  const before = hubRepo.listTransitions(handed.qitemId).length;
  await localRepo.update({ qitemId: byHub(handed.qitemId).qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "no-follow-on", resolution: "Done here." });
  expect(await pass()).toMatchObject({ resultsSent: 0 });
  expect(hubRepo.getById(handed.qitemId)!.state).toBe("handed-off");
  expect(hubRepo.listTransitions(handed.qitemId)).toHaveLength(before);
  expect(hubRepo.getById(successor.qitemId)).toMatchObject({ state: "pending", destinationSession: "other@team" });
  expect(networkClosedElsewhere(localDb, binding.id)).toContainEqual(expect.objectContaining({ hubItem: handed.qitemId, localItem: byHub(handed.qitemId).qitemId,
    note: expect.stringContaining("closed elsewhere (handed-off") }));
  await pass();
  expect(hubRepo.listTransitions(handed.qitemId)).toHaveLength(before);

  await revokeGrant(tokenFile, "alex");
  expect(await pass()).toMatchObject({ error: "revoked" });
  expect(bindings.get(binding.id)!.state).toBe("revoked");
});

it("a lead's aggregate over its own local child work comes back once on the original hub request, and an open parent publishes nothing early", async () => {
  const token = await addGrant(tokenFile, { name: "alex", seat: "alex@team", rigs: ["team"], roots: [], workspace: false, owner: false });
  const task = await hubRepo.create({ sourceSession: "lead@team", destinationSession: "alex@team", summary: "Ship the fix", body: "Fix the bug and have it reviewed.", nudge: false } as never);
  const localRepo = queue(localDb);
  const bindings = new NetworkBindingStore(localDb, localHome);
  const binding = bindings.create({ session: "dev-impl@lab", hubUrl, hubSeat: "alex@team", token, allowHttp: true });
  const pass = () => runNetworkBindingPass({ db: localDb, queueRepo: localRepo, bindings, home: localHome }, bindings.get(binding.id)!);
  const hubItem = () => hubRepo.getById(task.qitemId)!;

  expect(await pass()).toMatchObject({ taken: 1 });
  const [parent] = localRepo.list({ limit: 50 });
  localRepo.claim({ qitemId: parent!.qitemId, destinationSession: "dev-impl@lab" });

  // The lead delegates through ordinary local rows and waits on each in turn.
  const build = await localRepo.create({ sourceSession: "dev-impl@lab", destinationSession: "builder@lab", summary: "Build the fix", body: "Fix the bug.", nudge: false } as never);
  const review = await localRepo.create({ sourceSession: "dev-impl@lab", destinationSession: "reviewer@lab", summary: "Review the fix", body: "Review the build.", nudge: false } as never);
  await localRepo.update({ qitemId: parent!.qitemId, actorSession: "dev-impl@lab", state: "blocked", blockedOn: build.qitemId, transitionNote: "Waiting on the build." });
  expect(await pass()).toMatchObject({ pickupsSent: 1, resultsSent: 0 });
  expect(hubItem()).toMatchObject({ state: "in-progress", resolution: null });

  localRepo.claim({ qitemId: build.qitemId, destinationSession: "builder@lab" });
  await localRepo.update({ qitemId: build.qitemId, actorSession: "builder@lab", state: "done", closureReason: "no-follow-on", resolution: "Built: the fix is in commit abc123." });
  await localRepo.update({ qitemId: parent!.qitemId, actorSession: "dev-impl@lab", state: "blocked", blockedOn: review.qitemId, transitionNote: "Waiting on the review." });
  // A finished child isn't a result: the parent is still open, so nothing final goes to the hub.
  expect(await pass()).toMatchObject({ resultsSent: 0 });
  expect(hubItem()).toMatchObject({ state: "in-progress", resolution: null });

  localRepo.claim({ qitemId: review.qitemId, destinationSession: "reviewer@lab" });
  await localRepo.update({ qitemId: review.qitemId, actorSession: "reviewer@lab", state: "done", closureReason: "no-follow-on", resolution: "Reviewed: approve." });
  const children = [localRepo.getById(build.qitemId)!, localRepo.getById(review.qitemId)!];
  const aggregate = children.map((child) => child.resolution).join(" ");
  await localRepo.update({ qitemId: parent!.qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "no-follow-on", resolution: aggregate });
  expect(await pass()).toMatchObject({ resultsSent: 1 });
  expect(hubItem()).toMatchObject({ state: "done", closureReason: "no-follow-on", resolution: "Built: the fix is in commit abc123. Reviewed: approve." });

  // Once: a further pass writes nothing, and the children's own words never reached the hub as notes.
  const transitions = hubRepo.listTransitions(task.qitemId);
  await pass();
  expect(hubRepo.listTransitions(task.qitemId)).toHaveLength(transitions.length);
  expect(transitions.filter((t) => t.state === "done")).toHaveLength(1);
  expect(transitions.map((t) => t.transitionNote ?? "").join("\n")).not.toMatch(/Waiting on|Built:.*\n.*Reviewed:/);
});
