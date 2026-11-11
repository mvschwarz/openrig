// `rig network` bindings: a selected local seat joined to one hub participant. The credential lives in a private file
// and never comes back over the API; disconnect stops the binding and removes the credential, and local work stays.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { NetworkBindingError, NetworkBindingStore, networkCredentialFile, readNetworkCredential } from "../src/domain/network/network-bindings.js";
import { networkRoutes } from "../src/routes/network.js";

describe("network bindings", () => {
  let db: Database.Database;
  let rigs: RigRepository;
  let home: string;
  let store: NetworkBindingStore;
  let seq = 0;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db);
    home = mkdtempSync(join(tmpdir(), "openrig-network-"));
    store = new NetworkBindingStore(db, home);
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  function seat(session: string) {
    const rig = rigs.listRigs().find((r) => r.name === "lab") ?? rigs.createRig("lab");
    const node = rigs.addNode(rig.id, `n${++seq}`, { runtime: "claude-code" });
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')").run(`s${seq}`, node.id, session);
    return node;
  }
  const connect = (session: string, over: Record<string, unknown> = {}) =>
    store.create({ session, hubUrl: "https://hub.example/mcp", hubSeat: "alex@team", token: "tok-123", ...over });

  it("binds a local seat by its node, keeps the token in a private file, and never lists it", () => {
    const node = seat("dev-impl@lab");
    const binding = connect("dev-impl@lab");
    expect(binding).toMatchObject({ nodeId: node.id, localSession: "dev-impl@lab", hubUrl: "https://hub.example/mcp", hubSeat: "alex@team",
      state: "active", lastContactAt: null });
    expect(binding.id).toMatch(/^netb-[0-9a-f]{20}$/);
    const file = networkCredentialFile(home, binding.id);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    expect(readNetworkCredential(home, binding.id)).toBe("tok-123");
    expect(JSON.stringify(store.list())).not.toContain("tok-123");
  });

  it("refuses an unknown seat, a second binding for a seat or a participant, and a credential in the URL", () => {
    expect(() => connect("nobody@lab")).toThrow(expect.objectContaining({ code: "seat_not_found", status: 404 }));
    seat("a@lab"); seat("b@lab");
    connect("a@lab");
    expect(() => connect("a@lab", { hubSeat: "other@team" })).toThrow(expect.objectContaining({ code: "seat_already_connected", status: 409 }));
    expect(() => connect("b@lab")).toThrow(expect.objectContaining({ code: "participant_already_connected", status: 409 }));
    expect(() => connect("b@lab", { hubSeat: "c@team", hubUrl: "https://user:secret@hub.example/mcp" })).toThrow(expect.objectContaining({ code: "invalid_hub_url" }));
    expect(() => connect("b@lab", { hubSeat: "c@team", token: "two words" })).toThrow(expect.objectContaining({ code: "invalid_token" }));
    expect(() => connect("b@lab", { hubSeat: "not-an-address" })).toThrow(expect.objectContaining({ code: "invalid_hub_seat" }));
    // Every refusal above left no credential behind.
    expect(store.list()).toHaveLength(1);
  });

  it("plain http needs the person's choice: refused with the remedy, then recorded and marked unencrypted with --allow-http", () => {
    seat("a@lab");
    const http = { hubUrl: "http://hub.internal:7433/mcp" };
    let message = "";
    try { connect("a@lab", http); } catch (error) {
      expect(error).toMatchObject({ code: "http_not_allowed", status: 400 });
      message = (error as Error).message;
    }
    expect(message).toContain("unencrypted");
    expect(message).toContain("https URL");
    expect(message).toContain("--allow-http");
    expect(store.list()).toHaveLength(0);
    expect(existsSync(join(home, "network-secrets"))).toBe(false);

    const binding = connect("a@lab", { ...http, allowHttp: true });
    // The scheme is kept as given, never switched.
    expect(binding).toMatchObject({ hubUrl: "http://hub.internal:7433/mcp", allowHttp: true, unencrypted: true });
    expect(store.list()).toEqual([expect.objectContaining({ id: binding.id, allowHttp: true, unencrypted: true })]);
    expect(JSON.stringify(store.list())).not.toContain("tok-123");
    // https needs no choice and isn't marked.
    seat("b@lab");
    expect(connect("b@lab", { hubSeat: "b@team" })).toMatchObject({ hubUrl: "https://hub.example/mcp", allowHttp: false, unencrypted: false });
  });

  it("disconnect ends the binding by id or by seat, removes the credential, and frees the seat to connect again", () => {
    seat("a@lab");
    const first = connect("a@lab");
    const ended = store.disconnect("a@lab", "moving to another account");
    expect(ended).toMatchObject({ id: first.id, state: "disconnected", stateReason: "moving to another account" });
    expect(existsSync(networkCredentialFile(home, first.id))).toBe(false);
    expect(() => readNetworkCredential(home, first.id)).toThrow(expect.objectContaining({ code: "credential_missing" }));
    // A second disconnect is the same answer, not an error.
    expect(store.disconnect(first.id).state).toBe("disconnected");
    const again = connect("a@lab");
    expect(again.id).not.toBe(first.id);
    expect(store.active().map((b) => b.id)).toEqual([again.id]);
    // Two binds in the same millisecond list in id order, so compare by id.
    expect(Object.fromEntries(store.list().map((b) => [b.id, b.state]))).toEqual({ [first.id]: "disconnected", [again.id]: "active" });
  });

  it("a revoked binding is ended the same way, and contact and errors are recorded on the active one", () => {
    seat("a@lab");
    const binding = connect("a@lab");
    store.recordError(binding.id, "hub answered 503");
    expect(store.get(binding.id)!.lastError).toBe("hub answered 503");
    // Hub text can carry terminal escapes; status prints it, so control characters are replaced.
    store.recordError(binding.id, "hub said \u001b[31mred\u0007");
    expect(store.get(binding.id)!.lastError).toBe("hub said  [31mred ");
    store.recordContact(binding.id, new Date("2026-11-11T18:30:00.000Z"));
    expect(store.get(binding.id)).toMatchObject({ lastContactAt: "2026-11-11T18:30:00.000Z", lastError: null });
    expect(store.markRevoked(binding.id, "the hub refused the credential")).toMatchObject({ state: "revoked", stateReason: "the hub refused the credential" });
    expect(existsSync(networkCredentialFile(home, binding.id))).toBe(false);
  });

  it("refuses a credential file that others can read", async () => {
    seat("a@lab");
    const binding = connect("a@lab");
    const { chmodSync } = await import("node:fs");
    chmodSync(networkCredentialFile(home, binding.id), 0o644);
    expect(() => readNetworkCredential(home, binding.id)).toThrow(NetworkBindingError);
    expect(readFileSync(networkCredentialFile(home, binding.id), "utf8")).toContain("tok-123");
  });

  it("a refused bind removes only what it created: a file already at the path stays, and a failed insert takes its credential with it", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    seat("a@lab");
    const fixed = "netb-00000000000000000001";
    const pinned = new NetworkBindingStore(db, home, () => new Date(), () => fixed);
    const path = networkCredentialFile(home, fixed);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, "someone else's file", { mode: 0o600 });
    expect(() => pinned.create({ session: "a@lab", hubUrl: "https://hub.example/mcp", hubSeat: "alex@team", token: "tok" })).toThrow(/EEXIST/);
    expect(readFileSync(path, "utf8")).toBe("someone else's file");
    expect(store.list()).toHaveLength(0);

    db.exec("CREATE TRIGGER refuse_bind BEFORE INSERT ON network_bindings BEGIN SELECT RAISE(ABORT, 'refused for the test'); END;");
    const other = new NetworkBindingStore(db, home, () => new Date(), () => "netb-00000000000000000002");
    expect(() => other.create({ session: "a@lab", hubUrl: "https://hub.example/mcp", hubSeat: "alex@team", token: "tok" })).toThrow(/refused for the test/);
    expect(existsSync(networkCredentialFile(home, "netb-00000000000000000002"))).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it("a disconnect whose credential can't be removed still ends the binding, says so, and the retry it names removes it", async () => {
    const { chmodSync } = await import("node:fs");
    seat("a@lab");
    const binding = connect("a@lab");
    const secrets = join(home, "network-secrets");
    chmodSync(secrets, 0o500);
    let message = "";
    try {
      try { store.disconnect("a@lab"); } catch (error) {
        expect(error).toMatchObject({ code: "credential_cleanup_failed", status: 500 });
        message = (error as Error).message;
      }
      expect(store.get(binding.id)!.state).toBe("disconnected");
      expect(store.active()).toHaveLength(0);
    } finally {
      chmodSync(secrets, 0o700);
    }
    // The seat's name no longer finds an ended binding, so the message names the id to retry with.
    expect(() => store.disconnect("a@lab")).toThrow(expect.objectContaining({ code: "binding_not_found" }));
    const retry = /`rig network disconnect (\S+)`/.exec(message)?.[1];
    expect(retry).toBe(binding.id);
    expect(store.disconnect(retry!).state).toBe("disconnected");
    expect(existsSync(networkCredentialFile(home, binding.id))).toBe(false);
  });

  it("a failed bind into a folder that was already there removes only its own credential file", async () => {
    const { mkdirSync, readFileSync: read, writeFileSync } = await import("node:fs");
    seat("a@lab");
    const id = "netb-00000000000000000004";
    const path = networkCredentialFile(home, id);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(join(path, "..", "other.txt"), "keep me");
    db.exec("CREATE TRIGGER refuse_bind BEFORE INSERT ON network_bindings BEGIN SELECT RAISE(ABORT, 'refused for the test'); END;");
    const pinned = new NetworkBindingStore(db, home, () => new Date(), () => id);
    expect(() => pinned.create({ session: "a@lab", hubUrl: "https://hub.example/mcp", hubSeat: "alex@team", token: "tok" })).toThrow(/refused for the test/);
    expect(existsSync(path)).toBe(false);
    expect(read(join(path, "..", "other.txt"), "utf8")).toBe("keep me");
  });

  it("the credential sweep removes folders whose binding isn't active and leaves the active one and other names", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    seat("a@lab"); seat("b@lab");
    const kept = connect("a@lab");
    const ended = connect("b@lab", { hubSeat: "b@team" });
    store.disconnect(ended.id);
    // An ended binding whose removal failed, a folder a stop left before its row, and a name that isn't a binding.
    const leftovers = [ended.id, "netb-00000000000000000009"];
    for (const id of leftovers) {
      mkdirSync(join(networkCredentialFile(home, id), ".."), { recursive: true, mode: 0o700 });
      writeFileSync(networkCredentialFile(home, id), "{}", { mode: 0o600 });
    }
    mkdirSync(join(home, "network-secrets", "notes"));
    expect(store.sweepCredentials()).toEqual({ removed: [...leftovers].sort(), failed: [] });
    for (const id of leftovers) expect(existsSync(join(networkCredentialFile(home, id), ".."))).toBe(false);
    expect(readNetworkCredential(home, kept.id)).toBe("tok-123");
    expect(existsSync(join(home, "network-secrets", "notes"))).toBe(true);
  });

  it("a corrupt credential file is refused by its path alone, without quoting what it holds", async () => {
    const { writeFileSync } = await import("node:fs");
    seat("a@lab");
    const binding = connect("a@lab");
    writeFileSync(networkCredentialFile(home, binding.id), "tok-SECRET-not-json", { mode: 0o600 });
    let message = "";
    try { readNetworkCredential(home, binding.id); } catch (error) {
      expect(error).toMatchObject({ code: "credential_invalid" });
      message = (error as Error).message;
    }
    expect(message).toContain(networkCredentialFile(home, binding.id));
    expect(message).not.toContain("SECRET");
  });

  describe("routes", () => {
    const app = (bearerToken: string | null = null) => {
      const router = new Hono();
      router.use("*", async (c, next) => { c.set("rigRepo" as never, rigs as never); await next(); });
      router.route("/api/network", networkRoutes({ bearerToken, home }));
      return router;
    };
    const post = (a: Hono, path: string, body: unknown, auth?: string) => a.request(path, {
      method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
    });

    it("connects, lists without the token, refuses with the store's code, and disconnects", async () => {
      seat("a@lab");
      const a = app();
      const created = await post(a, "/api/network/bindings", { session: "a@lab", hubUrl: "https://hub.example/mcp", hubSeat: "alex@team", token: "tok-9" });
      expect(created.status).toBe(201);
      const binding = await created.json() as { id: string };
      const listed = await (await a.request("/api/network/bindings")).text();
      expect(listed).toContain(binding.id);
      expect(listed).not.toContain("tok-9");
      const dup = await post(a, "/api/network/bindings", { session: "a@lab", hubUrl: "https://hub.example/mcp", hubSeat: "x@team", token: "tok-9" });
      expect(dup.status).toBe(409);
      expect(await dup.json()).toMatchObject({ error: "seat_already_connected" });
      const ended = await post(a, `/api/network/bindings/${binding.id}/disconnect`, { reason: "done" });
      expect(ended.status).toBe(200);
      expect(await ended.json()).toMatchObject({ state: "disconnected", stateReason: "done" });
    });

    it("with an operator bearer configured, writes need it and reads don't", async () => {
      seat("a@lab");
      const a = app("op-secret");
      const body = { session: "a@lab", hubUrl: "https://hub.example/mcp", hubSeat: "alex@team", token: "tok-9" };
      expect((await post(a, "/api/network/bindings", body)).status).toBe(401);
      expect((await a.request("/api/network/bindings")).status).toBe(200);
      const created = await post(a, "/api/network/bindings", body, "op-secret");
      expect(created.status).toBe(201);
      const { id } = await created.json() as { id: string };
      expect((await post(a, `/api/network/bindings/${id}/disconnect`, {})).status).toBe(401);
      expect((await post(a, `/api/network/bindings/${id}/disconnect`, {}, "op-secret")).status).toBe(200);
    });
  });
});
