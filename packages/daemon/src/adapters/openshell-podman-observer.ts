import { request } from "node:http";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { hostname } from "node:os";
import { EnvironmentError, type EnvironmentBinding } from "../domain/environment-platform.js";
import type { DependentObservation } from "../domain/environment-lifecycle.js";

export type PodmanCleanupSelection = { version: 1; socket: string; socketDevice: number; socketInode: number; uid: number; host: string;
  resourceId: string; workspace: string; workloadId: string; supervisorId: string; volumes: string[] };
type EngineRead = (socket: string, path: string) => Promise<{ status: number; body: unknown }>;
const read: EngineRead = (socket, path) => new Promise((resolve, reject) => {
  const req = request({ socketPath: socket, path, method: "GET", timeout: 5000 }, res => {
    const chunks: Buffer[] = []; let bytes = 0;
    res.on("data", chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { req.destroy(new Error("Engine inventory exceeds its bound")); return; } chunks.push(chunk); });
    res.on("error", reject); res.on("end", () => {
      const status = res.statusCode ?? 0, text = Buffer.concat(chunks).toString("utf8");
      try { resolve({ status, body: status === 200 && text ? JSON.parse(text) : text }); }
      catch { reject(new EnvironmentError("environment_cleanup_unconfirmed", "The local engine returned malformed inventory JSON")); }
    });
  });
  req.on("timeout", () => req.destroy(new Error("Engine inventory timed out"))); req.on("error", reject); req.end();
});
/** Read-only local rootless engine inventory. No engine mutation or global-emptiness requirement. */
export class OpenShellPodmanObserver {
  constructor(private readonly get: EngineRead = read) {}
  private socket(path: string): { socket: string; socketDevice: number; socketInode: number; uid: number; host: string } {
    if (process.platform !== "linux" || !isAbsolute(path) || process.getuid?.() === 0) throw new EnvironmentError("environment_engine_unsupported", "Select a local non-root Podman socket on the provider host");
    if (realpathSync(path) !== path) throw new EnvironmentError("environment_engine_changed", "The selected engine socket must not be a symlink");
    const stat = lstatSync(path), uid = process.getuid!();
    if (!stat.isSocket() || stat.uid !== uid) throw new EnvironmentError("environment_engine_changed", "The engine socket must belong to this rootless provider user");
    return { socket: path, socketDevice: stat.dev, socketInode: stat.ino, uid, host: hostname() };
  }
  private async rows(socket: string): Promise<Array<Record<string, any>>> {
    const result = await this.get(socket, "/containers/json?all=true");
    if (result.status !== 200 || !Array.isArray(result.body)) throw new EnvironmentError("environment_cleanup_unconfirmed", `Complete local engine inventory is unavailable (HTTP ${result.status})`);
    return result.body;
  }
  async capture(binding: EnvironmentBinding, path: string): Promise<PodmanCleanupSelection> {
    const selected = this.socket(path), id = binding.resource!.id, rows = await this.rows(path);
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
      const inspected = await this.get(path, `/containers/${container.Id}/json`);
      const actual = inspected.body as Record<string, any>;
      if (inspected.status !== 200 || actual?.Id !== container.Id || !Array.isArray(actual.Mounts)) throw new EnvironmentError("environment_cleanup_unconfirmed", "The captured container cannot be inspected");
      for (const mount of actual.Mounts) if (mount.Type === "volume" && typeof mount.Name === "string") mounted.add(mount.Name);
    }
    if (volumes.some(volume => !mounted.has(volume))) throw new EnvironmentError("environment_cleanup_unconfirmed", "Expected workspace/control/channel volumes are not attributable to the selected containers");
    return { version: 1, ...selected, resourceId: id, workspace: binding.placement.workspace, workloadId: workloadContainer.Id, supervisorId: supervisorContainer.Id, volumes };
  }
  async observe(binding: EnvironmentBinding, selected?: PodmanCleanupSelection): Promise<DependentObservation> {
    if (!selected || selected.version !== 1 || selected.resourceId !== binding.resource!.id || selected.workspace !== binding.placement.workspace)
      throw new EnvironmentError("environment_cleanup_unconfirmed", "No pre-delete exact local engine inventory is retained");
    const now = this.socket(selected.socket);
    if (now.host !== selected.host || now.uid !== selected.uid || now.socketDevice !== selected.socketDevice || now.socketInode !== selected.socketInode)
      throw new EnvironmentError("environment_cleanup_unconfirmed", "The selected local engine endpoint changed; absence is not established");
    const rows = await this.rows(selected.socket);
    const workload = rows.some(row => row.Id === selected.workloadId || row.Labels?.["openshell.ai/sandbox-id"] === selected.resourceId && row.Labels?.["openshell.ai/isolation-role"] === "sandbox");
    const supervisor = rows.some(row => row.Id === selected.supervisorId || Array.isArray(row.Names) && row.Names.some((name: string) => name.replace(/^\//, "") === `openshell-supervisor-${selected.resourceId}`));
    // A route-level 404 is not volume absence. Require a complete positive inventory.
    const observed = await this.get(selected.socket, "/volumes");
    const listing = observed.body as { Volumes?: unknown; Warnings?: unknown } | null;
    const inventory = listing?.Volumes, warnings = listing?.Warnings;
    if (observed.status !== 200 || !Array.isArray(inventory) || inventory.some(volume => typeof volume?.Name !== "string")
      || warnings != null && (!Array.isArray(warnings) || warnings.length !== 0))
      throw new EnvironmentError("environment_cleanup_unconfirmed", `Complete local volume inventory is unavailable (HTTP ${observed.status})`);
    const volumes = selected.volumes.some(name => inventory.some(volume => volume.Name === name));
    return { workload, supervisor, volumes };
  }
}
