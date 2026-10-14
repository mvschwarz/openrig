import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalOrigin } from "../src/local-origin.js";
import { DaemonClient, remoteDaemonClient } from "../src/client.js";
import { resolveOriginSelfHostId } from "../src/daemon-lifecycle.js";

let home: string;
let dbPath: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "openrig-qa-origin-"));
  dbPath = join(home, "source.sqlite");
  vi.stubEnv("OPENRIG_HOME", home); vi.stubEnv("OPENRIG_DB", dbPath);
  vi.stubEnv("RIGGED_DB", ""); vi.stubEnv("OPENRIG_URL", "http://forwarded-endpoint:7433");
  vi.stubEnv("RIGGED_URL", ""); vi.stubEnv("OPENRIG_SESSION_NAME", "rig-admin@ops");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(home, {recursive: true, force: true}); });
function seed(id: string, file = dbPath) {
  const db = new Database(file);
  db.exec("CREATE TABLE self_host_identity (singleton INTEGER PRIMARY KEY, host_id TEXT)");
  db.prepare("INSERT INTO self_host_identity VALUES (1, ?)").run(id); db.close();
}
function client(targetId?: string) {
  const requests: Array<{url: string; headers: Record<string,string>}> = [];
  const factory = (url: string) => new DaemonClient(url, { fetchImpl: (async (url, init) => {
    requests.push({url: String(url), headers: (init?.headers ?? {}) as Record<string,string>});
    return new Response(JSON.stringify(String(url).endsWith("/healthz") ? {selfHostId: targetId} : {ok:true}));
  }) as typeof fetch });
  return {requests, factory};
}
describe("local durable origin", () => {
  it("does not create a missing database or infer the remote identity", async () => {
    expect(readLocalOrigin()).toBeUndefined(); expect(existsSync(dbPath)).toBe(false);
    const fetch = vi.fn(async () => ({ok:true,json:async()=>({selfHostId:"wrong-destination"})}));
    expect(await resolveOriginSelfHostId({fetch} as never)).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  });
  it("reads the minted id despite a different configured display name", () => {
    seed("host-a1b2c3d4"); writeFileSync(join(home,"config.json"),JSON.stringify({host:{name:"new-display-name"}}));
    expect(readLocalOrigin()).toBe("host-a1b2c3d4");
  });
  it("keeps explicit DB configuration above the previous launch record", () => {
    seed("configured-origin"); const previous=join(home,"old.sqlite"); seed("old-origin",previous);
    writeFileSync(join(home,"daemon.json"),JSON.stringify({db:previous})); expect(readLocalOrigin()).toBe("configured-origin");
  });
  it("retains an explicit --db from the last launch when no DB override exists", () => {
    seed("launch-origin"); vi.stubEnv("OPENRIG_DB","");
    writeFileSync(join(home,"daemon.json"),JSON.stringify({db:dbPath})); expect(readLocalOrigin()).toBe("launch-origin");
  });
  it("honors a file-configured DB", () => {
    seed("file-origin"); vi.stubEnv("OPENRIG_DB","");
    writeFileSync(join(home,"config.json"),JSON.stringify({db:{path:dbPath}})); expect(readLocalOrigin()).toBe("file-origin");
  });
  it.each(["", "local", "localhost", "has@separator"])("does not promote invalid identity %s", id => {
    seed(id); expect(readLocalOrigin()).toBeUndefined();
  });
  it("unreadable schema stays unknown", () => { writeFileSync(dbPath,"not sqlite"); expect(readLocalOrigin()).toBeUndefined(); });
});
describe("direct endpoint attribution", () => {
  it.each(["parent-origin", undefined])("carries origin when target %s is remote or unproved", async target => {
    seed("vm-origin"); const {factory,requests}=client(target); const c=factory("http://127.0.0.1:12345");
    await c.post("/write",{}); await c.post("/again",{});
    expect(requests.filter(r=>r.url.endsWith("/healthz"))).toHaveLength(1);
    expect(requests.at(-1)?.headers["X-OpenRig-Session"]).toBe("rig-admin@ops@vm-origin");
  });
  it("proven-local direct endpoint preserves bare addressing", async () => {
    seed("vm-origin"); const {factory,requests}=client("vm-origin"); await factory("http://alias:7433").post("/write",{});
    expect(requests.at(-1)?.headers["X-OpenRig-Session"]).toBe("rig-admin@ops");
  });
  it("unknown origin delivers a durable uncertainty marker and diagnostic", async () => {
    const {factory,requests}=client("parent-origin"); await factory("http://parent:7433").post("/write",{});
    expect(requests.at(-1)?.headers).toMatchObject({"X-OpenRig-Session":"rig-admin@ops","X-OpenRig-Origin-Unknown":"true"});
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Origin instance unknown"));
  });
  it("ordinary default local requests do not need an origin read/probe", async () => {
    vi.stubEnv("OPENRIG_URL",""); const {factory,requests}=client(); await factory("http://localhost:7433").post("/write",{});
    expect(requests).toHaveLength(1); expect(requests[0]?.headers).toMatchObject({"X-OpenRig-Session":"rig-admin@ops"});
  });
  it("already-qualified sender survives unavailable local evidence", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME","rig-admin@ops@upstream"); const {factory,requests}=client(); await factory("http://parent:7433").post("/write",{});
    expect(requests).toHaveLength(1); expect(requests[0]?.headers["X-OpenRig-Session"]).toBe("rig-admin@ops@upstream");
  });
  it("registered remote construction uses local durable fallback, never its target", async () => {
    seed("vm-origin"); const {factory,requests}=client("parent-origin"); await remoteDaemonClient(factory,"http://parent:7433").post("/write",{});
    expect(requests).toHaveLength(1); expect(requests[0]?.headers["X-OpenRig-Session"]).toBe("rig-admin@ops@vm-origin");
  });
});

describe("local instance proof for terminal attachment", () => {
  it.each([
    ["local-instance", true], ["remote-instance", false], [undefined, false],
  ] as const)("compares the loopback endpoint's identity %s with this home's durable identity", async (target, expected) => {
    seed("local-instance");
    // Attachment also requires proof outside an agent seat and without OPENRIG_URL.
    vi.stubEnv("OPENRIG_SESSION_NAME", ""); vi.stubEnv("RIGGED_SESSION_NAME", ""); vi.stubEnv("OPENRIG_URL", "");
    const { factory, requests } = client(target);
    expect(await factory("http://127.0.0.1:12345").isLocalInstance()).toBe(expected);
    expect(requests.map(r => r.url)).toEqual(["http://127.0.0.1:12345/healthz"]);
  });

  it("does not accept the endpoint's identity when the local store is absent", async () => {
    const { factory, requests } = client("remote-instance");
    expect(await factory("http://localhost:7433").isLocalInstance()).toBe(false);
    expect(requests).toEqual([]);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("does not use a caller-supplied origin or a registered remote as local proof", async () => {
    seed("local-instance");
    const { factory } = client("remote-instance");
    const c = factory("http://localhost:7433");
    c.originSelfHostId = "remote-instance";
    expect(await c.isLocalInstance()).toBe(false);
    const same = client("local-instance");
    expect(await remoteDaemonClient(same.factory, "http://localhost:7433").isLocalInstance()).toBe(false);
    expect(same.requests).toEqual([]);
  });

  it("bounds an unresponsive identity probe and cancels it", async () => {
    seed("local-instance");
    let signal: AbortSignal | null | undefined;
    const c = new DaemonClient("http://127.0.0.1:12345", { timeoutMs: 25, fetchImpl: (async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    }) as typeof fetch });
    expect(await c.isLocalInstance()).toBe(false);
    expect(signal?.aborted).toBe(true);
  });
});
