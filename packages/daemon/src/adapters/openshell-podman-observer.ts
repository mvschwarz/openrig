import { request } from "node:http";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { inspectWindowsOwnedPipe } from "../domain/windows-owned-text.js";
import { EnvironmentError, type EnvironmentBinding } from "../domain/environment-platform.js";
import type { DependentObservation } from "../domain/environment-lifecycle.js";

export type PodmanCleanupSelection = { version: 1; socket: string; socketDevice: number; socketInode: number; uid: number; host: string;
  resourceId: string; workspace: string; workloadId: string; supervisorId: string; volumes: string[];
  windowsPipe?: { pid: number; started: string; sid: string }; engineFingerprint?: string };
type EngineRead = (socket: string, path: string) => Promise<{ status: number; body: unknown }>;
const readResponse: EngineRead = (socket, path) => new Promise((resolve, reject) => {
  const req = request({ socketPath: socket, path, method: "GET", timeout: 5000 }, res => {
    const chunks: Buffer[] = []; let bytes = 0;
    res.on("data", chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { req.destroy(new Error("Engine inventory exceeds its bound")); return; } chunks.push(chunk); });
    res.on("error", reject); res.on("end", () => { try {
      const status = res.statusCode ?? 0;
      resolve({ status, body: status >= 200 && status < 300 && chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null });
    } catch (error) { reject(error); } });
  });
  req.on("timeout", () => req.destroy(new Error("Engine inventory timed out"))); req.on("error", reject); req.end();
});
const read: EngineRead = async (socket, path) => {
  // The compatibility API's top-level ApiVersion describes Docker, not Libpod.
  // Discover the Podman component version on this endpoint before each read;
  // caching it could outlive a server replacement at the same socket name.
  const version = await readResponse(socket, "/version");
  const components = (version.body as { Components?: unknown } | null)?.Components;
  const engines = Array.isArray(components) ? components.filter(component => component?.Name === "Podman Engine") : [];
  const apiVersion = engines.length === 1 ? engines[0]?.Details?.APIVersion : undefined;
  if (version.status !== 200 || typeof apiVersion !== "string" || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(apiVersion)) {
    throw new EnvironmentError("environment_engine_unsupported", "The selected endpoint must advertise a Podman Libpod API version");
  }
  return readResponse(socket, `/v${apiVersion}${path}`);
};
/** Read-only local rootless engine inventory. No engine mutation or global-emptiness requirement. */
export class OpenShellPodmanObserver {
  constructor(private readonly get: EngineRead = read) {}
  private socket(path: string): Pick<PodmanCleanupSelection, "socket" | "socketDevice" | "socketInode" | "uid" | "host" | "windowsPipe"> {
    if (process.platform === "win32") {
      try { return { socket: path, socketDevice: 0, socketInode: 0, uid: -1, host: hostname(), windowsPipe: inspectWindowsOwnedPipe(path) }; }
      catch { throw new EnvironmentError("environment_engine_changed", "Select a local Podman named pipe whose server belongs to this Windows user"); }
    }
    if (process.platform !== "linux" || !isAbsolute(path) || process.getuid?.() === 0) throw new EnvironmentError("environment_engine_unsupported", "Select a local non-root Podman socket on the provider host");
    if (realpathSync(path) !== path) throw new EnvironmentError("environment_engine_changed", "The selected engine socket must not be a symlink");
    const stat = lstatSync(path), uid = process.getuid!();
    if (!stat.isSocket() || stat.uid !== uid) throw new EnvironmentError("environment_engine_changed", "The engine socket must belong to this rootless provider user");
    return { socket: path, socketDevice: stat.dev, socketInode: stat.ino, uid, host: hostname() };
  }
  private async engineFingerprint(socket: string): Promise<string | undefined> {
    if (process.platform !== "win32") return undefined;
    const result = await this.get(socket, "/libpod/info");
    const info = result.body as Record<string, any>;
    const uid = info?.host?.idMappings?.uidmap?.find((row: Record<string, unknown>) => row.container_id === 0)?.host_id;
    if (result.status !== 200 || info?.host?.os !== "linux" || info?.host?.security?.rootless !== true
      || !Number.isSafeInteger(uid) || uid <= 0 || typeof info?.host?.hostname !== "string" || !info.host.hostname
      || typeof info?.store?.graphRoot !== "string" || !info.store.graphRoot.startsWith("/")) {
      throw new EnvironmentError("environment_engine_unsupported", "The selected Windows pipe must expose a confirmed rootless Podman engine");
    }
    return createHash("sha256").update(JSON.stringify([info.host.hostname, uid, info.store.graphRoot])).digest("hex");
  }
  private unchanged(selected: Pick<PodmanCleanupSelection, "socket" | "socketDevice" | "socketInode" | "uid" | "host" | "windowsPipe">): void {
    const now = this.socket(selected.socket);
    if (now.host !== selected.host || now.uid !== selected.uid || now.socketDevice !== selected.socketDevice || now.socketInode !== selected.socketInode
      || JSON.stringify(now.windowsPipe) !== JSON.stringify(selected.windowsPipe)) {
      throw new EnvironmentError("environment_cleanup_unconfirmed", "The selected local engine endpoint changed; absence is not established");
    }
  }
  private async rows(socket: string): Promise<Array<Record<string, any>>> {
    const result = await this.get(socket, "/libpod/containers/json?all=true");
    if (result.status !== 200 || !Array.isArray(result.body)) throw new EnvironmentError("environment_cleanup_unconfirmed", "Complete local engine inventory is unavailable");
    return result.body;
  }
  async capture(binding: EnvironmentBinding, path: string): Promise<PodmanCleanupSelection> {
    const selected = this.socket(path), id = binding.resource!.id, rows = await this.rows(path);
    const engineFingerprint = await this.engineFingerprint(path);
    const owned = rows.filter(row => row.Labels?.["openshell.ai/sandbox-id"] === id && row.Labels?.["openshell.managed"] === "true");
    const workload = owned.filter(row => row.Labels?.["openshell.ai/isolation-role"] === "sandbox");
    const supervisor = rows.filter(row => Array.isArray(row.Names) && row.Names.some((name: string) => name.replace(/^\//, "") === `openshell-supervisor-${id}`));
    const workloadContainer = workload[0], supervisorContainer = supervisor[0];
    if (workload.length !== 1 || supervisor.length !== 1 || !workloadContainer || !supervisorContainer || workloadContainer.Labels?.["openshell.ai/sandbox-workspace"] !== binding.placement.workspace)
      throw new EnvironmentError("environment_cleanup_unconfirmed", "The exact local workload and supervisor must be observed before deletion");
    const volumes = [`openshell-sandbox-${id}-workspace`, `openshell-control-${id}`, `openshell-channel-${id}`];
    const containers = [workloadContainer, supervisorContainer];
    const mounted = new Set<string>();
    for (const container of containers) {
      if (typeof container.Id !== "string" || !/^[0-9a-f]{64}$/.test(container.Id)) throw new EnvironmentError("environment_cleanup_unconfirmed", "Engine container identity is malformed");
      const inspected = await this.get(path, `/libpod/containers/${container.Id}/json`);
      const actual = inspected.body as Record<string, any>;
      if (inspected.status !== 200 || actual?.Id !== container.Id || !Array.isArray(actual.Mounts)) throw new EnvironmentError("environment_cleanup_unconfirmed", "The captured container cannot be inspected");
      for (const mount of actual.Mounts) if (mount.Type === "volume" && typeof mount.Name === "string") mounted.add(mount.Name);
    }
    if (volumes.some(volume => !mounted.has(volume))) throw new EnvironmentError("environment_cleanup_unconfirmed", "Expected workspace/control/channel volumes are not attributable to the selected containers");
    this.unchanged(selected);
    return { version: 1, ...selected, ...(engineFingerprint ? { engineFingerprint } : {}), resourceId: id, workspace: binding.placement.workspace, workloadId: workloadContainer.Id, supervisorId: supervisorContainer.Id, volumes };
  }
  async observe(binding: EnvironmentBinding, selected?: PodmanCleanupSelection): Promise<DependentObservation> {
    if (!selected || selected.version !== 1 || selected.resourceId !== binding.resource!.id || selected.workspace !== binding.placement.workspace)
      throw new EnvironmentError("environment_cleanup_unconfirmed", "No pre-delete exact local engine inventory is retained");
    this.unchanged(selected);
    if (await this.engineFingerprint(selected.socket) !== selected.engineFingerprint)
      throw new EnvironmentError("environment_cleanup_unconfirmed", "The rootless engine identity changed; absence is not established");
    const rows = await this.rows(selected.socket);
    const workload = rows.some(row => row.Id === selected.workloadId || row.Labels?.["openshell.ai/sandbox-id"] === selected.resourceId && row.Labels?.["openshell.ai/isolation-role"] === "sandbox");
    const supervisor = rows.some(row => row.Id === selected.supervisorId || Array.isArray(row.Names) && row.Names.some((name: string) => name.replace(/^\//, "") === `openshell-supervisor-${selected.resourceId}`));
    let volumes = false;
    for (const name of selected.volumes) {
      const observed = await this.get(selected.socket, `/libpod/volumes/${encodeURIComponent(name)}/json`);
      if (observed.status === 200) volumes = true;
      else if (observed.status !== 404) throw new EnvironmentError("environment_cleanup_unconfirmed", "Volume lookup failed; it is not absence");
    }
    this.unchanged(selected);
    return { workload, supervisor, volumes };
  }
}
