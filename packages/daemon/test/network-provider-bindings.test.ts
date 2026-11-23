import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(store.get(b.id)!.provider).toEqual({ id: "openrig-cloud", installation: "local-account", participant: "alex", remoteInstallation: "original-account-install" });
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

  it("a provider refusal is unconfirmed with its code and stops retrying", async () => {
    const b = create(); store.disconnect(b.id);
    await runNetworkProviderRemovalPass(workerDeps((async () => new Response(JSON.stringify({ code: "wrong_epoch" }), { status: 403 })) as typeof fetch), store.pendingProviderRemovals()[0]!);
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
