import { afterEach, expect, it, vi } from "vitest";
import { createServer as createNetServer } from "node:net";
import { createServer, createServer as createHttpServer, type Server } from "node:http";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OpenShellPodmanObserver } from "../src/adapters/openshell-podman-observer.js";
import type { EnvironmentBinding } from "../src/domain/environment-platform.js";
const closers: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
const supported = process.platform === "win32" || process.platform === "linux" && process.getuid?.() !== 0;
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "podman-observer-"))); closers.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\openrig-owned-engine-${randomUUID()}` : join(root, "engine.sock");
  const server: Server = createServer((req, res) => {
    const path = req.url ?? ""; wirePaths.push(path);
    if (path === "/version") { res.end(JSON.stringify({ ApiVersion: "1.44", Components: [{ Name: engineName, Details: { APIVersion: apiVersion } }] })); return; }
    if (!path.startsWith("/v6.1.4/libpod/") && !path.startsWith("/containers/") && path !== "/volumes") { res.writeHead(404); res.end("Not Found\n"); return; }
    void engineRead(path.startsWith("/v6.1.4") ? path.slice("/v6.1.4".length) : path).then(result => { res.writeHead(result.status, { "content-type": "application/json" }); res.end(result.status === 404 ? "Not Found\n" : JSON.stringify(result.body)); });
  }); await new Promise<void>(resolve => server.listen(socket, resolve));
  closers.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const id = "compute-one", workloadId = "a".repeat(64), supervisorId = "b".repeat(64);
  let rows: Record<string, any>[] = [{ Id: workloadId, Names: ["workload"], Labels: { "openshell.managed": "true", "openshell.ai/sandbox-id": id, "openshell.ai/isolation-role": "sandbox", "openshell.ai/sandbox-workspace": "workspace" } },
    { Id: supervisorId, Names: [`openshell-supervisor-${id}`], Labels: {} }];
  let volumeStatus = 200;
  let rootless = true, graphRoot = "/home/owned/.local/share/containers/storage";
  let engineName = "Podman Engine", apiVersion = "6.1.4";
  const wirePaths: string[] = [];
  const paths: string[] = [];
  const engineRead = async (path: string) => {
    paths.push(path);
    if (path === "/libpod/info") return { status: 200, body: { host: { os: "linux", hostname: "owned-engine", security: { rootless }, idMappings: { uidmap: [{ container_id: 0, host_id: 1000 }] } }, store: { graphRoot } } };
    if (path.startsWith("/containers/json")) return { status: 200, body: rows };
    if (path.startsWith("/containers/")) return { status: 200, body: { Id: path.includes(workloadId) ? workloadId : supervisorId,
      Mounts: [`openshell-sandbox-${id}-workspace`, `openshell-control-${id}`, `openshell-channel-${id}`].map(Name => ({ Type: "volume", Name })) } };
    return { status: volumeStatus, body: { Volumes: [], Warnings: [] } };
  };
  const observer = new OpenShellPodmanObserver();
  const binding = { resource: { id }, placement: { workspace: "workspace" } } as EnvironmentBinding;
  return { observer, binding, socket, paths, wirePaths, incompatible: (name: string, version: string) => { engineName = name; apiVersion = version; }, disappear: () => { rows = [{ Id: "c".repeat(64), Names: ["unrelated"], Labels: {} }]; }, failVolume: () => { volumeStatus = 500; }, rootful: () => { rootless = false; }, replaceEngine: () => { graphRoot = "/different-engine"; } };
}
it.skipIf(!supported)("captures exact local workload/supervisor/volumes then ignores unrelated engine resources", async () => {
  const f = await fixture(), selected = await f.observer.capture(f.binding, f.socket);
  expect(selected).toMatchObject({ resourceId: "compute-one", workloadId: "a".repeat(64), supervisorId: "b".repeat(64) });
  f.disappear(); expect(await f.observer.observe(f.binding, selected)).toEqual({ workload: false, supervisor: false, volumes: false });
  expect(f.wirePaths).toContain("/version");
  expect(f.wirePaths.every(path => path === "/version" || path.startsWith("/v6.1.4/libpod/") || path.startsWith("/containers/") || path === "/volumes")).toBe(true);
  expect(f.paths.every(path => path.startsWith("/containers/") || path === "/volumes" || process.platform === "win32" && path === "/libpod/info")).toBe(true);
});
it.skipIf(!supported)("rejects Docker compatibility versions and malformed Podman API paths before inventory", async () => {
  const f = await fixture();
  for (const [name, version] of [["Docker Engine", "6.1.4"], ["Podman Engine", "6.1.4/../../other"]]) {
    f.incompatible(name, version);
    await expect(f.observer.capture(f.binding, f.socket)).rejects.toMatchObject({ code: "environment_engine_unsupported" });
  }
  expect(f.paths).toEqual([]);
});
it.skipIf(process.platform !== "win32")("requires a native owned pipe and a rootless engine identity, retaining that identity for absence checks", async () => {
  const f = await fixture();
  await expect(f.observer.capture(f.binding, "\\\\foreign\\pipe\\engine")).rejects.toMatchObject({ code: "environment_engine_changed" });
  const selected = await f.observer.capture(f.binding, f.socket);
  expect(selected.windowsPipe?.pid).toBe(process.pid);
  expect(selected.windowsPipe?.sid).toMatch(/^S-1-/);
  expect(selected.engineFingerprint).toMatch(/^[a-f0-9]{64}$/);
  f.replaceEngine(); f.disappear();
  await expect(f.observer.observe(f.binding, selected)).rejects.toMatchObject({ code: "environment_cleanup_unconfirmed" });
  f.rootful();
  await expect(f.observer.capture(f.binding, f.socket)).rejects.toMatchObject({ code: "environment_engine_unsupported" });
});
it.skipIf(!supported)("does not treat an engine error or missing original inventory as cleanup", async () => {
  const f = await fixture(), selected = await f.observer.capture(f.binding, f.socket); f.disappear(); f.failVolume();
  await expect(f.observer.observe(f.binding, selected)).rejects.toMatchObject({ code: "environment_cleanup_unconfirmed" });
  await expect(f.observer.observe(f.binding)).rejects.toMatchObject({ code: "environment_cleanup_unconfirmed" });
});

async function httpFixture(failure?: "404" | "malformed", mountedVolumes?: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "os-")));
  closers.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = join(root, "s"), id = "compute-one", workloadId = "a".repeat(64), supervisorId = "b".repeat(64);
  const ownedVolumes = mountedVolumes ?? [`openshell-sandbox-${id}-workspace`, `openshell-control-${id}`, `openshell-channel-${id}`];
  const unrelated = { Id: "c".repeat(64), Names: ["unrelated"], Labels: {} };
  let containers = [unrelated,
    { Id: workloadId, Names: ["workload"], Labels: { "openshell.managed": "true", "openshell.ai/sandbox-id": id, "openshell.ai/isolation-role": "sandbox", "openshell.ai/sandbox-workspace": "workspace" } },
    { Id: supervisorId, Names: [`openshell-supervisor-${id}`], Labels: {} }];
  let volumes = [...ownedVolumes, "unrelated-volume"], volumeMissingRoute = false;
  const requests: Array<{ method: string | undefined; path: string | undefined }> = [];
    const server = createHttpServer((req, res) => {
      requests.push({ method: req.method, path: req.url });
      // The reader discovers the Podman Libpod API version before every inventory read; the
      // compatibility API's own ApiVersion describes Docker, not Libpod. A failure cell targets the
      // inventory read, so the version probe still answers.
      if (req.url === "/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ApiVersion: "1.44", Components: [{ Name: "Podman Engine", Details: { APIVersion: "6.1.4" } }] }));
        return;
      }
      if (failure === "404" || req.url?.startsWith("/libpod/") || volumeMissingRoute && req.url === "/volumes") {
        res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not Found\n"); return;
      }
      if (failure === "malformed") { res.writeHead(200); res.end("not JSON\n"); return; }
    let body: unknown;
    if (req.url === "/containers/json?all=true") body = containers;
    else if (req.url === `/containers/${workloadId}/json` || req.url === `/containers/${supervisorId}/json`)
      body = { Id: req.url.split("/")[2], Mounts: ownedVolumes.map(Name => ({ Type: "volume", Name })) };
    else if (req.url === "/volumes") body = { Volumes: volumes.map(Name => ({ Name })), Warnings: [] };
    else { res.writeHead(404); res.end("Not Found\n"); return; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  closers.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const observer = new OpenShellPodmanObserver(), st = lstatSync(socket);
  const identity = { socketDevice: st.dev, socketInode: st.ino, uid: st.uid, host: "engine.test" };
  // Exercise the real HTTP reader on macOS too; rootless socket selection has its Linux cells above.
  const selection = vi.spyOn(observer as unknown as { socket(path: string): unknown }, "socket")
    .mockImplementation(path => ({ socket: path, ...identity }));
  closers.push(() => selection.mockRestore());
  return {
    observer, socket, requests, binding: { resource: { id }, placement: { workspace: "workspace" } } as EnvironmentBinding,
    // A restart or reboot that gives the same socket path a new socket object, or a different host or user.
    replaceSocket: (change: Partial<typeof identity>) => { Object.assign(identity, change); },
    retireContainers: () => { containers = [unrelated]; volumes = [ownedVolumes[0]!, "unrelated-volume"]; },
    retireVolumes: () => { volumes = ["unrelated-volume"]; },
    loseVolumeRoute: () => { volumeMissingRoute = true; },
  };
}

it.skipIf(process.platform === "win32")("uses the engine's HTTP routes and positive inventories to verify exact dependent cleanup", async () => {
  const f = await httpFixture(), selected = await f.observer.capture(f.binding, f.socket);
  expect(selected).toMatchObject({ resourceId: "compute-one", workloadId: "a".repeat(64), supervisorId: "b".repeat(64) });
  expect(await f.observer.observe(f.binding, selected)).toEqual({ workload: true, supervisor: true, volumes: true });
  f.retireContainers();
  expect(await f.observer.observe(f.binding, selected)).toEqual({ workload: false, supervisor: false, volumes: true });
  f.retireVolumes();
  expect(await f.observer.observe(f.binding, selected)).toEqual({ workload: false, supervisor: false, volumes: false });
  f.loseVolumeRoute();
  await expect(f.observer.observe(f.binding, selected)).rejects.toMatchObject({ code: "environment_cleanup_unconfirmed" });
  expect(f.requests.every(req => req.method === "GET")).toBe(true);
  expect(f.requests.some(req => req.path?.startsWith("/libpod/"))).toBe(false);
});

it.skipIf(process.platform === "win32").each(["404", "malformed"] as const)("keeps an HTTP %s inventory response unconfirmed", async failure => {
  const f = await httpFixture(failure);
  await expect(f.observer.capture(f.binding, f.socket)).rejects.toMatchObject({ code: "environment_cleanup_unconfirmed" });
  // The version probe succeeds and the first inventory read fails; nothing follows it.
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0]?.path).toBe("/version");
  expect(f.requests.every(req => req.method === "GET")).toBe(true);
});

it.skipIf(process.platform === "win32")("captures a custom-image sandbox without inventing a workspace volume or selecting user mounts", async () => {
  const volumes = ["openshell-control-compute-one", "openshell-channel-compute-one"];
  const f = await httpFixture(undefined, [...volumes, "user-data", "openshell-control-another"]);
  const selected = await f.observer.capture(f.binding, f.socket);
  expect(selected.volumes).toEqual(volumes);
  f.retireContainers();
  expect(await f.observer.observe(f.binding, selected)).toEqual({ workload: false, supervisor: false, volumes: true });
  f.retireVolumes();
  expect(await f.observer.observe(f.binding, selected)).toEqual({ workload: false, supervisor: false, volumes: false });
  expect(f.requests.every(req => req.method === "GET")).toBe(true);
});

it.skipIf(process.platform === "win32").each(["control", "channel"])("refuses an unattributable %s volume even when other mounts exist", async missing => {
  const volumes = ["openshell-control-compute-one", "openshell-channel-compute-one", "openshell-sandbox-compute-one-workspace"]
    .filter(name => name !== `openshell-${missing}-compute-one`);
  const f = await httpFixture(undefined, volumes);
  await expect(f.observer.capture(f.binding, f.socket)).rejects.toMatchObject({ code: "environment_cleanup_unconfirmed" });
});

it("reads recreation's cleanup on a replaced socket object and reports the change, while delete still refuses it", async () => {
  const f = await httpFixture(), selected = await f.observer.capture(f.binding, f.socket);
  expect(await f.observer.observeEndpoint(f.binding, selected)).toMatchObject({ endpointChanged: false, remaining: { workload: true, supervisor: true, volumes: true } });
  f.replaceSocket({ socketDevice: selected.socketDevice + 1, socketInode: selected.socketInode + 1 });
  // Delete's exact endpoint requirement is unchanged.
  await expect(f.observer.observe(f.binding, selected)).rejects.toMatchObject({ code: "environment_cleanup_unconfirmed", message: expect.stringContaining("absence is not established") });
  // Recreation reads the current engine: what's still present is reported present, not hidden by the change.
  expect(await f.observer.observeEndpoint(f.binding, selected)).toEqual({ endpointChanged: true, remaining: { workload: true, supervisor: true, volumes: true },
    endpoint: { socket: f.socket, socketDevice: selected.socketDevice + 1, socketInode: selected.socketInode + 1, uid: selected.uid, host: "engine.test" } });
  f.retireContainers(); f.retireVolumes();
  expect(await f.observer.observeEndpoint(f.binding, selected)).toMatchObject({ endpointChanged: true, remaining: { workload: false, supervisor: false, volumes: false } });
  // An unreadable inventory on the current engine is still not absence.
  f.loseVolumeRoute();
  await expect(f.observer.observeEndpoint(f.binding, selected)).rejects.toMatchObject({ code: "environment_cleanup_unconfirmed" });
  expect(f.requests.every(req => req.method === "GET")).toBe(true);
});

it.each([["host", { host: "another.test" }], ["user", { uid: 4242 }]] as const)("still refuses recreation's read when the socket belongs to another %s", async (_name, change) => {
  const f = await httpFixture(), selected = await f.observer.capture(f.binding, f.socket), before = f.requests.length;
  f.replaceSocket(change);
  await expect(f.observer.observeEndpoint(f.binding, selected)).rejects.toMatchObject({ code: "environment_cleanup_unconfirmed", message: expect.stringContaining("another host or user") });
  expect(f.requests).toHaveLength(before);
});
