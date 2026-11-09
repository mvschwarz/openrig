import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenShellPodmanObserver } from "../src/adapters/openshell-podman-observer.js";
import type { EnvironmentBinding } from "../src/domain/environment-platform.js";
const closers: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
const supported = process.platform === "linux" && process.getuid?.() !== 0;
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "podman-observer-"))); closers.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = join(root, "engine.sock"), server: Server = createServer(); await new Promise<void>(resolve => server.listen(socket, resolve));
  closers.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const id = "compute-one", workloadId = "a".repeat(64), supervisorId = "b".repeat(64);
  let rows: Record<string, any>[] = [{ Id: workloadId, Names: ["workload"], Labels: { "openshell.managed": "true", "openshell.ai/sandbox-id": id, "openshell.ai/isolation-role": "sandbox", "openshell.ai/sandbox-workspace": "workspace" } },
    { Id: supervisorId, Names: [`openshell-supervisor-${id}`], Labels: {} }];
  let volumeStatus = 200;
  const paths: string[] = [];
  const observer = new OpenShellPodmanObserver(async (_socket, path) => {
    paths.push(path);
    if (path.startsWith("/containers/json")) return { status: 200, body: rows };
    if (path.startsWith("/containers/")) return { status: 200, body: { Id: path.includes(workloadId) ? workloadId : supervisorId,
      Mounts: [`openshell-sandbox-${id}-workspace`, `openshell-control-${id}`, `openshell-channel-${id}`].map(Name => ({ Type: "volume", Name })) } };
    return { status: volumeStatus, body: { Volumes: [], Warnings: [] } };
  });
  const binding = { resource: { id }, placement: { workspace: "workspace" } } as EnvironmentBinding;
  return { observer, binding, socket, paths, disappear: () => { rows = [{ Id: "c".repeat(64), Names: ["unrelated"], Labels: {} }]; }, failVolume: () => { volumeStatus = 500; } };
}
it.skipIf(!supported)("captures exact local workload/supervisor/volumes then ignores unrelated engine resources", async () => {
  const f = await fixture(), selected = await f.observer.capture(f.binding, f.socket);
  expect(selected).toMatchObject({ resourceId: "compute-one", workloadId: "a".repeat(64), supervisorId: "b".repeat(64) });
  f.disappear(); expect(await f.observer.observe(f.binding, selected)).toEqual({ workload: false, supervisor: false, volumes: false });
  expect(f.paths.every(path => path.startsWith("/containers/") || path === "/volumes")).toBe(true);
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
  // Exercise the real HTTP reader on macOS too; rootless socket selection has its Linux cells above.
  const selection = vi.spyOn(observer as unknown as { socket(path: string): unknown }, "socket")
    .mockImplementation(path => ({ socket: path, socketDevice: st.dev, socketInode: st.ino, uid: st.uid, host: "engine.test" }));
  closers.push(() => selection.mockRestore());
  return {
    observer, socket, requests, binding: { resource: { id }, placement: { workspace: "workspace" } } as EnvironmentBinding,
    retireContainers: () => { containers = [unrelated]; volumes = [ownedVolumes[0]!, "unrelated-volume"]; },
    retireVolumes: () => { volumes = ["unrelated-volume"]; },
    loseVolumeRoute: () => { volumeMissingRoute = true; },
  };
}

it("uses the engine's HTTP routes and positive inventories to verify exact dependent cleanup", async () => {
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

it.each(["404", "malformed"] as const)("keeps an HTTP %s inventory response unconfirmed", async failure => {
  const f = await httpFixture(failure);
  await expect(f.observer.capture(f.binding, f.socket)).rejects.toMatchObject({ code: "environment_cleanup_unconfirmed" });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.method).toBe("GET");
});

it("captures a custom-image sandbox without inventing a workspace volume or selecting user mounts", async () => {
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

it.each(["control", "channel"])("refuses an unattributable %s volume even when other mounts exist", async missing => {
  const volumes = ["openshell-control-compute-one", "openshell-channel-compute-one", "openshell-sandbox-compute-one-workspace"]
    .filter(name => name !== `openshell-${missing}-compute-one`);
  const f = await httpFixture(undefined, volumes);
  await expect(f.observer.capture(f.binding, f.socket)).rejects.toMatchObject({ code: "environment_cleanup_unconfirmed" });
});
