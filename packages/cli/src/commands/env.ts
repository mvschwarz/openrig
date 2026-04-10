import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const LONG_RUNNING_TIMEOUT_MS = 45_000;

export function envCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("env")
    .description("Inspect and control rig environment services for service-backed rigs and managed apps")
    .addHelpText("after", `
Examples:
  rig env status secrets-manager
  rig env logs secrets-manager vault
  rig env down secrets-manager
`);
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("Daemon not running");
      return null;
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  async function resolveRigId(client: DaemonClient, rigRef: string): Promise<string> {
    const summaries = await client.get<Array<{ id: string; name: string }>>("/api/rigs/summary");
    const match = summaries.data.find((r) => r.name === rigRef || r.id === rigRef);
    if (!match) throw new Error(`Rig '${rigRef}' not found`);
    return match.id;
  }

  // rig env status <rig>
  cmd
    .command("status")
    .argument("<rig>", "Rig name or ID")
    .option("--json", "JSON output")
    .action(async (rig: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      let rigId: string;
      try { rigId = await resolveRigId(client, rig); } catch (err) {
        console.error((err as Error).message); process.exitCode = 1; return;
      }

      const res = await client.get<Record<string, unknown>>(`/api/rigs/${encodeURIComponent(rigId)}/env`);

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }

      if (!res.data["hasServices"]) {
        console.log("No services configured for this rig.");
        return;
      }

      const receipt = res.data["receipt"] as Record<string, unknown> | null;
      if (!receipt) {
        console.log("Services configured but no receipt available yet.");
        return;
      }

      console.log(`Env: ${res.data["kind"]} (${res.data["projectName"]})`);
      const services = receipt["services"] as Array<{ name: string; status: string; health?: string | null }>;
      if (services) {
        for (const svc of services) {
          const health = svc.health ? ` (${svc.health})` : "";
          console.log(`  ${svc.name}: ${svc.status}${health}`);
        }
      }
    });

  // rig env logs <rig> [service]
  cmd
    .command("logs")
    .argument("<rig>", "Rig name or ID")
    .argument("[service]", "Specific service name")
    .option("--tail <n>", "Number of lines", "100")
    .action(async (rig: string, service: string | undefined, opts: { tail: string }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      let rigId: string;
      try { rigId = await resolveRigId(client, rig); } catch (err) {
        console.error((err as Error).message); process.exitCode = 1; return;
      }

      const params = new URLSearchParams({ tail: opts.tail });
      if (service) params.set("service", service);

      const res = await client.get<{ ok: boolean; output?: string; error?: string }>(
        `/api/rigs/${encodeURIComponent(rigId)}/env/logs?${params}`,
      );

      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `Failed to get logs (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(res.data.output ?? "");
    });

  // rig env down <rig> [--volumes]
  cmd
    .command("down")
    .argument("<rig>", "Rig name or ID")
    .option("--volumes", "Also remove volumes")
    .action(async (rig: string, opts: { volumes?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      let rigId: string;
      try { rigId = await resolveRigId(client, rig); } catch (err) {
        console.error((err as Error).message); process.exitCode = 1; return;
      }

      const res = await client.post<{ ok: boolean; error?: string }>(
        `/api/rigs/${encodeURIComponent(rigId)}/env/down`,
        { volumes: opts.volumes ?? false },
        { timeoutMs: LONG_RUNNING_TIMEOUT_MS },
      );

      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `Failed to stop services (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(`Services stopped for ${rig}.`);
    });

  return cmd;
}
