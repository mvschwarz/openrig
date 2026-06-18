import { DaemonClient } from "./client.js";
import { loadHostRegistry, resolveHost, resolveRemoteBearer, classifyHttpFailedStep, classifyHttpError, type HttpHostEntry } from "./host-registry.js";
import type { FailedStep } from "./cross-host-types.js";

export interface RemoteHostDeps {
  clientFactory: (url: string) => DaemonClient;
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
}

export interface RemoteOpResult {
  ok: boolean;
  failedStep: FailedStep;
  data?: unknown;
  error?: string;
}

export async function runRemoteHttpOp(
  hostId: string,
  method: "GET" | "POST",
  apiPath: string,
  body: unknown | undefined,
  deps: RemoteHostDeps,
  opts: { json?: boolean },
): Promise<RemoteOpResult> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    return { ok: false, failedStep: "remote-daemon-unreachable", error: registry.error };
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    return { ok: false, failedStep: "remote-daemon-unreachable", error: resolved.error };
  }
  const host = resolved.host;

  if (host.transport === "ssh") {
    return { ok: false, failedStep: "remote-command-failed", error: `host ${hostId} uses SSH transport; HTTP --host not available` };
  }

  const httpHost = host as HttpHostEntry;
  const bearerResult = resolveRemoteBearer(httpHost);
  if (!bearerResult.ok) {
    return { ok: false, failedStep: bearerResult.failedStep, error: bearerResult.error };
  }

  const client = deps.clientFactory(httpHost.url);
  const headers = { Authorization: `Bearer ${bearerResult.token}` };

  try {
    const res = method === "POST"
      ? await client.post<unknown>(apiPath, body, { headers })
      : await client.get<unknown>(apiPath, { headers });

    const failedStep = classifyHttpFailedStep(res.status);
    if (failedStep !== "none") {
      return { ok: false, failedStep, error: `HTTP ${res.status}` };
    }
    return { ok: true, failedStep: "none", data: res.data };
  } catch (err) {
    return { ok: false, failedStep: classifyHttpError(err), error: (err as Error).message };
  }
}

export async function resolveRemoteRigId(
  hostId: string,
  handle: string,
  deps: RemoteHostDeps,
): Promise<{ ok: true; rigId: string } | { ok: false; error: string }> {
  const psResult = await runRemoteHttpOp(hostId, "GET", "/api/ps?includeArchived=true", undefined, deps, {});
  if (!psResult.ok) return { ok: false, error: `cannot resolve rig on host ${hostId}: ${psResult.error}` };

  const rigs = psResult.data as Array<{ rigId: string; name: string; archivedAt?: string | null }>;

  const exactId = rigs.find((r) => r.rigId === handle);
  if (exactId) return { ok: true, rigId: exactId.rigId };

  const byName = rigs.filter((r) => r.name === handle && !r.archivedAt);
  if (byName.length === 1) return { ok: true, rigId: byName[0]!.rigId };
  if (byName.length > 1) {
    return { ok: false, error: `ambiguous rig name "${handle}" on host ${hostId}: ${byName.length} active rigs share that name. Use the rig id instead.` };
  }
  return { ok: false, error: `rig "${handle}" not found on host ${hostId}` };
}
