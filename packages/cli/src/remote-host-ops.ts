import { DaemonClient, remoteDaemonClient } from "./client.js";
import { loadHostRegistry, resolveHost, resolveRemoteBearer, bearerAuthHeaders, classifyHttpFailedStep, classifyHttpError, type HttpHostEntry } from "./host-registry.js";
import { resolveOriginSelfHostId, type LifecycleDeps } from "./daemon-lifecycle.js";
import type { FailedStep } from "./cross-host-types.js";

export interface RemoteHostDeps {
  clientFactory: (url: string) => DaemonClient;
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  /**
   * A4: present ⇒ `runRemoteHttpOp` resolves THIS host's `selfHostId` (fail-open) and stamps the origin
   * TRIPLE on the remote request so the remote daemon renders the ORIGIN host. Absent (some test mocks)
   * ⇒ the 2-part header stamps, fail-open — no new failure mode. The 8 command modules that call this
   * pass their command deps (which carry `lifecycleDeps`), so the production remote path stamps the triple.
   */
  lifecycleDeps?: LifecycleDeps;
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
  // OPR.0.4.6.MH4 — optional per-call deadline (additive; absent = the
  // DaemonClient default). Every remote call site names its own budget.
  opts: { json?: boolean; timeoutMs?: number },
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

  // A4: the SINGLE remote-origin construction for the 8 modules that route through this chokepoint —
  // stamp the origin triple (fail-open to 2-part when the local selfHostId is unavailable / no lifecycleDeps).
  const originSelfHostId = deps.lifecycleDeps ? await resolveOriginSelfHostId(deps.lifecycleDeps) : undefined;
  const client = remoteDaemonClient(deps.clientFactory, httpHost.url, originSelfHostId);
  const headers = bearerAuthHeaders(bearerResult.token);
  const requestOptions = opts.timeoutMs !== undefined ? { headers, timeoutMs: opts.timeoutMs } : { headers };

  try {
    const res = method === "POST"
      ? await client.post<unknown>(apiPath, body, requestOptions)
      : await client.get<unknown>(apiPath, requestOptions);

    const failedStep = classifyHttpFailedStep(res.status);
    if (failedStep !== "none") {
      // Carry the origin response body on failures too (additive): the
      // remote route's own error text is the honest detail a caller
      // surfaces beside the step class.
      return { ok: false, failedStep, error: `HTTP ${res.status}`, data: res.data };
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
