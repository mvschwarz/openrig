import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
    if (!path.startsWith("/v6.1.4/libpod/")) { res.writeHead(404); res.end("Not Found\n"); return; }
    void engineRead(path.slice("/v6.1.4".length)).then(result => { res.writeHead(result.status, { "content-type": "application/json" }); res.end(result.status === 404 ? "Not Found\n" : JSON.stringify(result.body)); });
  }); await new Promise<void>(resolve => server.listen(socket, resolve));
  closers.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const id = "compute-one", workloadId = "a".repeat(64), supervisorId = "b".repeat(64);
  let rows: Record<string, any>[] = [{ Id: workloadId, Names: ["workload"], Labels: { "openshell.managed": "true", "openshell.ai/sandbox-id": id, "openshell.ai/isolation-role": "sandbox", "openshell.ai/sandbox-workspace": "workspace" } },
    { Id: supervisorId, Names: [`openshell-supervisor-${id}`], Labels: {} }];
  let volumeStatus = 404;
  let rootless = true, graphRoot = "/home/owned/.local/share/containers/storage";
  let engineName = "Podman Engine", apiVersion = "6.1.4";
  const wirePaths: string[] = [];
  const paths: string[] = [];
  const engineRead = async (path: string) => {
    paths.push(path);
    if (path === "/libpod/info") return { status: 200, body: { host: { os: "linux", hostname: "owned-engine", security: { rootless }, idMappings: { uidmap: [{ container_id: 0, host_id: 1000 }] } }, store: { graphRoot } } };
    if (path.startsWith("/libpod/containers/json")) return { status: 200, body: rows };
    if (path.startsWith("/libpod/containers/")) return { status: 200, body: { Id: path.includes(workloadId) ? workloadId : supervisorId,
      Mounts: [`openshell-sandbox-${id}-workspace`, `openshell-control-${id}`, `openshell-channel-${id}`].map(Name => ({ Type: "volume", Name })) } };
    return { status: volumeStatus, body: {} };
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
  expect(f.wirePaths.every(path => path === "/version" || path.startsWith("/v6.1.4/libpod/"))).toBe(true);
  expect(f.paths.every(path => path.startsWith("/libpod/containers/") || path.startsWith("/libpod/volumes/") || process.platform === "win32" && path === "/libpod/info")).toBe(true);
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
