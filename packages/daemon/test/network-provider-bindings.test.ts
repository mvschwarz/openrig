import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { NetworkBindingStore, networkCredentialFile, readNetworkCredential, writePrivateToken } from "../src/domain/network/network-bindings.js";
import { runNetworkProviderRemovalPass } from "../src/domain/network/network-provider-removal.js";
import { NetworkConnectorService, runNetworkBindingPass, type NetworkConnectorDeps } from "../src/domain/network/network-connector.js";
import { HubError } from "../src/domain/network/hub-client.js";
import { networkRoutes } from "../src/routes/network.js";

const provider = { id: "example-provider", installation: "local-install", remoteInstallation: "remote-install", participant: "alex" };
describe("provider-managed network bindings", () => {
  let db: Database.Database;
  let rigs: RigRepository;
  let home: string;
  let store: NetworkBindingStore;
  beforeEach(() => {
    db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db); home = mkdtempSync(join(tmpdir(), "openrig-provider-"));
    const rig = rigs.createRig("lab"); const node = rigs.addNode(rig.id, "a", { runtime: "codex" });
    db.prepare("INSERT INTO sessions (id,node_id,session_name,status) VALUES ('s',?,'a@lab','running')").run(node.id);
    store = new NetworkBindingStore(db, home);
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const create = () => store.create({ session: "a@lab", hubUrl: "https://hub.example/mcp", hubSeat: "alex@team", token: "work-one", provider,
    removal: { revision: "epoch-one", token: "removal-one" } });

  it("local disconnect durably records provider removal", () => {
    const b = create(); const ended = store.disconnect(b.id);
    expect(ended).toMatchObject({ id: b.id, state: "disconnected", provider, providerRemoval: "pending", providerRemovalRevision: "epoch-one" });
    expect(existsSync(networkCredentialFile(home, b.id))).toBe(false);
    expect(store.pendingProviderRemovals()).toHaveLength(1);
    expect(JSON.stringify(store.list())).not.toMatch(/work-one|removal-one/);
    const restored = new NetworkBindingStore(db, home);
    restored.sweepCredentials();
    expect(restored.readRemovalToken(restored.pendingProviderRemovals()[0]!)).toBe("removal-one");
    expect(restored.disconnect(b.id).providerRemoval).toBe("pending");
    expect(restored.pendingProviderRemovals()).toHaveLength(1);
  });

  it("rotates both credentials in place, preserving the binding and its identity", () => {
    const b = create();
    const rotated = store.rotateCredential(b.id, { expectedRevision: 0, provider, token: "work-two", removal: { revision: "epoch-two", token: "removal-two" } });
    expect(rotated).toMatchObject({ id: b.id, nodeId: b.nodeId, hubUrl: b.hubUrl, hubSeat: b.hubSeat, state: "active", credentialRevision: 1, provider });
    expect(readNetworkCredential(home, b.id, rotated.credentialRevision)).toBe("work-two");
    expect(() => store.rotateCredential(b.id, { expectedRevision: 0, provider, token: "work-old", removal: { revision: "old", token: "old-removal" } })).toThrow(expect.objectContaining({ code: "binding_revision_changed" }));
    store.disconnect(b.id);
    expect(store.pendingProviderRemovals()[0]).toMatchObject({ removalRevision: "epoch-two", credentialRevision: 1 });
    expect(store.readRemovalToken(store.pendingProviderRemovals()[0]!)).toBe("removal-two");
  });

  it("a failed DB rotation keeps the old usable credential and removes staged files", () => {
    const b = create();
    db.exec("CREATE TRIGGER fail_rotation BEFORE UPDATE OF credential_revision ON network_bindings BEGIN SELECT RAISE(ABORT,'injected rotation failure'); END");
    expect(() => store.rotateCredential(b.id, { expectedRevision: 0, provider, token: "work-two", removal: { revision: "epoch-two", token: "removal-two" } })).toThrow();
    expect(store.get(b.id)!.credentialRevision).toBe(0);
    expect(readNetworkCredential(home, b.id)).toBe("work-one");
    expect(existsSync(networkCredentialFile(home, b.id, 1))).toBe(false);
  });

  it("requires the original provider and removal revision before accepting a receipt", () => {
    const b = create(); store.disconnect(b.id);
    expect(() => store.reportProviderRemoval(b.id, { provider: { ...provider, remoteInstallation: "replacement" }, removalRevision: "epoch-one", status: "confirmed" })).toThrow(expect.objectContaining({ code: "provider_revision_changed" }));
    expect(() => store.reportProviderRemoval(b.id, { provider, removalRevision: "epoch-old", status: "confirmed" })).toThrow(expect.objectContaining({ code: "provider_revision_changed" }));
    expect(store.get(b.id)!.providerRemoval).toBe("pending");
    expect(store.reportProviderRemoval(b.id, { provider, removalRevision: "epoch-one", status: "superseded", reason: "newer-credential" }).providerRemoval).toBe("superseded");
    expect(store.pendingProviderRemovals()).toEqual([]);
  });

  it("direct bindings remain provider-free and legacy enrollment metadata is projected without reconnecting", () => {
    const b = store.create({ session: "a@lab", hubUrl: "https://hub.example/mcp", hubSeat: "alex@team", token: "old-work", installation: { id: "local-account", name: "alex", account: "original-account-install" } });
    expect(store.get(b.id)!.provider).toEqual({ id: "account", installation: "local-account", participant: "alex", remoteInstallation: "original-account-install" });
    expect(readNetworkCredential(home, b.id)).toBe("old-work");
    store.disconnect(b.id); store.markAccountRemoved(b.id);
    expect(store.get(b.id)!.providerRemoval).toBe("confirmed");
  });

  it("an interrupted staged rotation is swept before retry without losing the old selected credential", () => {
    const b = create();
    writePrivateToken(networkCredentialFile(home, b.id, 1), "uncommitted-work");
    const rotated = store.rotateCredential(b.id, { expectedRevision: 0, provider, token: "work-two", removal: { revision: "epoch-two", token: "removal-two" } });
    expect(readNetworkCredential(home, b.id, rotated.credentialRevision)).toBe("work-two");
  });

  it("a credential cleanup failure leaves local inactive and removal intent durable", () => {
    const b = create(); const folder = join(networkCredentialFile(home, b.id), "..");
    chmodSync(folder, 0o500);
    try {
      expect(() => store.disconnect(b.id)).toThrow(expect.objectContaining({ code: "credential_cleanup_failed" }));
      expect(store.get(b.id)).toMatchObject({ state: "disconnected", providerRemoval: "pending", credentialCleanup: "pending" });
    } finally { chmodSync(folder, 0o700); }
    expect(store.disconnect(b.id).providerRemoval).toBe("pending");
    expect(existsSync(networkCredentialFile(home, b.id))).toBe(false);
    expect(store.get(b.id)!.credentialCleanup).toBe("complete");
  });

  it("direct bindings remain provider-free", () => {
    const b = store.create({ session: "a@lab", hubUrl: "https://hub.example/mcp", hubSeat: "alex@team", token: "direct" });
    expect(store.get(b.id)).toMatchObject({ provider: null, credentialRevision: 0, providerRemoval: null });
    expect(store.disconnect(b.id).providerRemoval).toBeNull(); expect(store.pendingProviderRemovals()).toEqual([]);
  });

  const workerDeps = (removalFetch: typeof fetch) => ({ bindings: store, home, removalFetch } as NetworkConnectorDeps);
  const reply = (request: RequestInit, outcome: Record<string, unknown>) => new Response(JSON.stringify({ ...JSON.parse(String(request.body)), ...outcome }), { status: 200 });

  it.each(["bare-403", "missing-404", "non-403", "missing-marker", "invalid-code", "binding", "seat", "provider", "revision"] as const)("R2 non-contract refusal %s stays pending and can recover", async (variant) => {
    let now = Date.parse("2026-11-23T00:00:00Z");
    store = new NetworkBindingStore(db, home, () => new Date(now));
    const b = create(); store.disconnect(b.id); let calls = 0;
    const removalFetch: typeof fetch = async (_url, init) => {
      calls++;
      if (calls > 1) return reply(init!, { alreadyRemoved: true });
      if (variant === "bare-403") return new Response("<html>proxy refusal</html>", { status: 403 });
      if (variant === "missing-404") return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      const refusal: Record<string, unknown> = { ...JSON.parse(String(init!.body)), refused: true, code: "wrong_epoch" };
      if (variant === "missing-marker") delete refusal.refused;
      if (variant === "invalid-code") refusal.code = "not a contract code";
      if (variant === "binding") refusal.bindingId = "another-binding";
      if (variant === "seat") refusal.hubSeat = "another@team";
      if (variant === "provider") refusal.provider = { ...provider, installation: "another-install" };
      if (variant === "revision") refusal.removalRevision = "another-epoch";
      return new Response(JSON.stringify(refusal), { status: variant === "non-403" ? 401 : 403 });
    };
    await runNetworkProviderRemovalPass(workerDeps(removalFetch), store.pendingProviderRemovals()[0]!, { retryDelayMs: 5_000 });
    expect(store.get(b.id)!.providerRemoval).toBe("pending");
    expect(store.get(b.id)!.providerRemovalReason).toMatch(/unknown/);
    expect(store.pendingProviderRemovals()[0]).toMatchObject({ hasCapability: true, attempts: 1, nextAttemptAt: new Date(now + 5_000).toISOString() });
    expect(store.readRemovalToken(store.pendingProviderRemovals()[0]!)).toBe("removal-one");
    now += 5_000;
    await runNetworkProviderRemovalPass(workerDeps(removalFetch), store.pendingProviderRemovals()[0]!);
    expect(calls).toBe(2); expect(store.get(b.id)!.providerRemoval).toBe("confirmed");
  });

  it("R2 legacy no-capability removal stays manual across sweeps and reconstruction", async () => {
    const b = store.create({ session: "a@lab", hubUrl: "https://hub.example/mcp", hubSeat: "alex@team", token: "old-work", installation: { id: "local-account", name: "alex", account: "original-account-install" } });
    store.disconnect(b.id); store.sweepCredentials();
    store = new NetworkBindingStore(db, home); store.sweepCredentials();
    const removal = store.pendingProviderRemovals()[0]!;
    expect(removal).toMatchObject({ hasCapability: false, attempts: 0, removalRevision: "local-0" });
    let calls = 0;
    await runNetworkProviderRemovalPass(workerDeps(async (_url, init) => { calls++; return reply(init!, { alreadyRemoved: true }); }), removal);
    expect(calls).toBe(0);
    expect(store.pendingProviderRemovals()[0]).toMatchObject({ hasCapability: false, attempts: 0 });
    expect(store.get(b.id)!.providerRemovalReason).toBeNull();
  });

  it("R2 positive capability evidence stays durable when stored metadata is absent", () => {
    const b = create(); store.disconnect(b.id);
    db.prepare("UPDATE network_bindings SET removal_revision = NULL WHERE id = ?").run(b.id);
    store = new NetworkBindingStore(db, home); store.sweepCredentials();
    expect(store.pendingProviderRemovals()[0]).toMatchObject({ hasCapability: true, removalRevision: "epoch-one", attempts: 0 });
    expect(store.readRemovalToken(store.pendingProviderRemovals()[0]!)).toBe("removal-one");
  });

  it("R1 removal redirects stay pending without forwarding the capability", async () => {
    const b = create(); store.disconnect(b.id);
    let initialRequests = 0, redirectedRequests = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (request.url !== "/redirected") {
          initialRequests++;
          response.writeHead(307, { Location: "/redirected" }); response.end(); return;
        }
        redirectedRequests++;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ...JSON.parse(body), alreadyRemoved: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP fixture");
      const endpoint = "http://127.0.0.1:" + address.port;
      await runNetworkProviderRemovalPass(workerDeps((input, init) =>
        fetch(new URL(new URL(String(input)).pathname, endpoint), init)), store.pendingProviderRemovals()[0]!);
      expect(initialRequests).toBe(1);
      expect(redirectedRequests).toBe(0);
      expect(store.get(b.id)).toMatchObject({ providerRemoval: "pending", providerRemovalReason: "removal-effect-unknown" });
      expect(store.readRemovalToken(store.pendingProviderRemovals()[0]!)).toBe("removal-one");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([408, 429])("R1 HTTP %i stays pending with capability and backoff, then succeeds", async (status) => {
    let now = Date.parse("2026-11-23T00:00:00Z");
    store = new NetworkBindingStore(db, home, () => new Date(now));
    const b = create(); store.disconnect(b.id); let calls = 0;
    const removalFetch: typeof fetch = async (_url, init) => {
      calls++;
      return calls === 1 ? new Response("temporary", { status }) : reply(init!, { alreadyRemoved: true });
    };
    await runNetworkProviderRemovalPass(workerDeps(removalFetch), store.pendingProviderRemovals()[0]!, { retryDelayMs: 5_000 });
    expect(store.get(b.id)).toMatchObject({ providerRemoval: "pending", providerRemovalReason: "provider-temporary:http-" + status });
    expect(store.pendingProviderRemovals()[0]).toMatchObject({ attempts: 1, nextAttemptAt: new Date(now + 5_000).toISOString(), hasCapability: true });
    expect(store.readRemovalToken(store.pendingProviderRemovals()[0]!)).toBe("removal-one");
    now += 5_000;
    await runNetworkProviderRemovalPass(workerDeps(removalFetch), store.pendingProviderRemovals()[0]!);
    expect(calls).toBe(2);
    expect(store.get(b.id)!.providerRemoval).toBe("confirmed");
    expect(store.pendingProviderRemovals()).toEqual([]);
  });

  it("R1 local read errors keep removal pending across store reconstruction", async () => {
    let now = Date.parse("2026-11-23T00:00:00Z");
    store = new NetworkBindingStore(db, home, () => new Date(now));
    const b = create(); store.disconnect(b.id);
    const folder = dirname(networkCredentialFile(home, b.id)); let calls = 0;
    const removalFetch: typeof fetch = async (_url, init) => { calls++; return reply(init!, { alreadyRemoved: true }); };
    chmodSync(folder, 0o000);
    try {
      await runNetworkProviderRemovalPass(workerDeps(removalFetch), store.pendingProviderRemovals()[0]!, { retryDelayMs: 5_000 });
      expect(store.get(b.id)!.providerRemoval).toBe("pending");
      expect(store.get(b.id)!.providerRemovalReason).toMatch(/^local-/);
      expect(store.pendingProviderRemovals()[0]).toMatchObject({ hasCapability: true, attempts: 1, nextAttemptAt: new Date(now + 5_000).toISOString() });
      store = new NetworkBindingStore(db, home, () => new Date(now)); now += 5_000;
      await runNetworkProviderRemovalPass(workerDeps(removalFetch), store.pendingProviderRemovals()[0]!, { retryDelayMs: 5_000 });
      expect(calls).toBe(0);
      expect(store.pendingProviderRemovals()[0]).toMatchObject({ hasCapability: true, attempts: 2 });
    } finally { chmodSync(folder, 0o700); }
    now += 5_000; store.sweepCredentials();
    expect(store.readRemovalToken(store.pendingProviderRemovals()[0]!)).toBe("removal-one");
    await runNetworkProviderRemovalPass(workerDeps(removalFetch), store.pendingProviderRemovals()[0]!);
    expect(calls).toBe(1);
    expect(store.get(b.id)!.providerRemoval).toBe("confirmed");
  });

  it("R1 capability metadata survives an unreadable path and reconciles an old false flag", async () => {
    const b = create(); const folder = dirname(networkCredentialFile(home, b.id));
    chmodSync(folder, 0o000);
    try {
      expect(() => store.disconnect(b.id)).toThrow(expect.objectContaining({ code: "credential_cleanup_failed" }));
      expect(store.pendingProviderRemovals()[0]!.hasCapability).toBe(true);
    } finally { chmodSync(folder, 0o700); }
    db.prepare("UPDATE network_binding_removals SET has_capability = 0 WHERE binding_id = ?").run(b.id);
    store = new NetworkBindingStore(db, home); store.sweepCredentials();
    expect(store.pendingProviderRemovals()[0]!.hasCapability).toBe(true);
    expect(store.readRemovalToken(store.pendingProviderRemovals()[0]!)).toBe("removal-one");
    await runNetworkProviderRemovalPass(workerDeps(async (_url, init) => reply(init!, { alreadyRemoved: true })), store.pendingProviderRemovals()[0]!);
    expect(store.get(b.id)!.providerRemoval).toBe("confirmed");
  });

  it("R1 startup does not invent removal work for historical ended bindings", () => {
    const b = create(); store.disconnect(b.id);
    db.prepare("DELETE FROM network_binding_removals WHERE binding_id = ?").run(b.id);
    store = new NetworkBindingStore(db, home); store.sweepCredentials();
    expect(store.pendingProviderRemovals()).toEqual([]);
  });

  it("a lost reply remains pending across restart and retries with only the removal capability", async () => {
    const b = create(); store.disconnect(b.id);
    let seen: Record<string, unknown> | undefined;
    await runNetworkProviderRemovalPass(workerDeps((async (url, init) => {
      expect(String(url)).toBe("https://hub.example/mcp/bindings/leave");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer removal-one");
      seen = JSON.parse(String(init?.body)); throw new Error("lost reply after provider applied removal");
    }) as typeof fetch), store.pendingProviderRemovals()[0]!);
    expect(store.get(b.id)!.providerRemoval).toBe("pending");
    store = new NetworkBindingStore(db, home); store.sweepCredentials();
    await runNetworkProviderRemovalPass(workerDeps((async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(seen);
      return reply(init!, { removalRevision: "epoch-one", alreadyRemoved: true });
    }) as typeof fetch), store.pendingProviderRemovals()[0]!);
    expect(store.get(b.id)).toMatchObject({ providerRemoval: "confirmed", providerRemovalReceipt: { removalRevision: "epoch-one", alreadyRemoved: true } }); expect(store.pendingProviderRemovals()).toEqual([]);
  });

  it("does not confirm a receipt from a different revision or installation", async () => {
    const b = create(); store.disconnect(b.id);
    for (const outcome of [{ removalRevision: "older", alreadyRemoved: true }, { provider: { ...provider, remoteInstallation: "replacement" }, alreadyRemoved: true }]) {
      await runNetworkProviderRemovalPass(workerDeps((async (_url, init) => reply(init!, outcome)) as typeof fetch), store.pendingProviderRemovals()[0]!);
      expect(store.get(b.id)!.providerRemoval).toBe("pending");
    }
  });

  it("superseded is terminal without claiming removal", async () => {
    const b = create(); store.disconnect(b.id);
    await runNetworkProviderRemovalPass(workerDeps((async (_url, init) => reply(init!, { superseded: true })) as typeof fetch), store.pendingProviderRemovals()[0]!);
    expect(store.get(b.id)!.providerRemoval).toBe("superseded"); expect(store.pendingProviderRemovals()).toEqual([]);
  });

  it("R2 a matching contract refusal is unconfirmed with its code and stops retrying", async () => {
    const b = create(); store.disconnect(b.id);
    await runNetworkProviderRemovalPass(workerDeps((async (_url, init) => new Response(JSON.stringify({ ...JSON.parse(String(init!.body)), refused: true, code: "wrong_epoch" }), { status: 403 })) as typeof fetch), store.pendingProviderRemovals()[0]!);
    expect(store.get(b.id)).toMatchObject({ providerRemoval: "unconfirmed", providerRemovalReason: "provider-refused:wrong_epoch" });
    expect(store.pendingProviderRemovals()).toEqual([]);
    // An explicit later provider report may confirm the same unconfirmed revision; automatic retry stays stopped.
    expect(store.reportProviderRemoval(b.id, { provider, removalRevision: "epoch-one", status: "confirmed" }).providerRemoval).toBe("confirmed");
  });

  it("runs removal for ended bindings independently of an active-work pass", async () => {
    const b = create(); store.disconnect(b.id);
    let release!: (value: Response) => void;
    const deps = workerDeps((async (_url, init) => new Promise<Response>((resolve) => {
      release = () => resolve(reply(init!, { alreadyRemoved: true }));
    })) as typeof fetch);
    const connector = new NetworkConnectorService(deps);
    const removal = connector.roundRemovals();
    try {
      await connector.round(); // No active binding is needed, and the slow removal does not hold this pass.
      expect(store.get(b.id)!.providerRemoval).toBe("pending");
    } finally { release(new Response()); await removal; await connector.stop(); }
    expect(store.get(b.id)!.providerRemoval).toBe("confirmed");
  });

  it("a late revoked answer for the old credential cannot end its replacement", async () => {
    const b = create();
    const result = await runNetworkBindingPass({ db, bindings: store, home, connect: async () => {
      store.rotateCredential(b.id, { expectedRevision: 0, provider, token: "work-two", removal: { revision: "epoch-two", token: "removal-two" } });
      throw new HubError("revoked", "the old credential was revoked");
    } } as NetworkConnectorDeps, b);
    expect(result.error).toBe("credential_changed");
    expect(store.get(b.id)).toMatchObject({ state: "active", credentialRevision: 1, providerRemoval: null });
    expect(readNetworkCredential(home, b.id, 1)).toBe("work-two");
    let contacted = false;
    const stale = await runNetworkBindingPass({ db, bindings: store, home, connect: async () => { contacted = true; throw new Error("not reached"); } } as NetworkConnectorDeps, b);
    expect(stale.error).toBe("credential_changed"); expect(contacted).toBe(false);
  });

  it("new lifecycle writes use the existing operator bearer; GET never exposes credentials", async () => {
    const b = create();
    const app = new Hono(); app.use("*", async (c, next) => { (c.set as (key: string, value: unknown) => void)("rigRepo", rigs); await next(); });
    app.route("/api/network", networkRoutes({ home, bearerToken: "operator" }));
    for (const [method, path, body] of [
      ["POST", `/api/network/bindings/${b.id}/credential`, { expectedRevision: 0, provider, token: "work-two", removal: { revision: "epoch-two", token: "removal-two" } }],
      ["PATCH", `/api/network/bindings/${b.id}`, { providerRemoval: "confirmed", provider, removalRevision: "epoch-one" }],
    ] as const) {
      expect((await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(401);
    }
    const res = await app.request(`/api/network/bindings/${b.id}/credential`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer operator" }, body: JSON.stringify({ expectedRevision: 0, provider, token: "work-two", removal: { revision: "epoch-two", token: "removal-two" } }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: b.id, credentialRevision: 1 });
    const read = await app.request("/api/network/bindings"); expect(await read.text()).not.toMatch(/work-one|work-two|removal-one|removal-two/);
  });
});
