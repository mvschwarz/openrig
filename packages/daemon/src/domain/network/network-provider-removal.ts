import { NetworkBindingError, type NetworkProviderRemoval } from "./network-bindings.js";
import type { NetworkConnectorDeps } from "./network-connector.js";

/** One removal attempt, independent of the binding's work state and credential. A lost or invalid reply is pending,
 *  not successful removal. Terminal receipts are matched to the original provider and opaque revision by the store. */
export async function runNetworkProviderRemovalPass(deps: NetworkConnectorDeps, removal: NetworkProviderRemoval,
  opts: { signal?: AbortSignal; retryDelayMs?: number } = {}): Promise<void> {
  if (!removal.hasCapability) return; // Legacy callback/manual reconciliation stays in place.
  const defer = (reason: string) => deps.bindings.deferProviderRemoval(removal, reason, opts.retryDelayMs ?? 5_000);
  let token: string;
  try { token = deps.bindings.readRemovalToken(removal); }
  catch (error) {
    defer(error instanceof NetworkBindingError ? "local-" + error.code : "local-credential-unavailable");
    deps.log?.("network leave: local credential unavailable");
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.passTimeoutMs ?? 60_000); timer.unref?.();
  const stop = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  opts.signal?.addEventListener("abort", stop, { once: true });
  try {
    const url = new URL(removal.hubUrl); url.pathname = url.pathname.replace(/\/+$/, "") + "/bindings/leave";
    const response = await (deps.removalFetch ?? fetch)(url, { method: "POST", signal: controller.signal, redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bindingId: removal.bindingId, provider: removal.provider, hubSeat: removal.hubSeat, removalRevision: removal.removalRevision }) });
    if (response.status === 408 || response.status === 429) {
      defer("provider-temporary:http-" + response.status); return;
    }
    if (response.status >= 400 && response.status < 500) {
      let code = `http-${response.status}`;
      try { const refusal = await response.json() as { code?: unknown }; if (typeof refusal.code === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(refusal.code)) code = refusal.code; } catch { /* Status alone still cannot confirm removal. */ }
      deps.bindings.reportProviderRemoval(removal.bindingId, { provider: removal.provider, removalRevision: removal.removalRevision,
        status: "unconfirmed", reason: `provider-refused:${code}` });
      deps.log?.("network leave: refused"); return;
    }
    if (!response.ok) { defer("provider-unavailable"); deps.log?.("network leave: store-unreachable"); return; }
    const body = await response.json() as Record<string, unknown>;
    const sameProvider = body?.provider && typeof body.provider === "object" && Object.entries(removal.provider).every(([k, v]) => (body.provider as Record<string, unknown>)[k] === v)
      && Object.keys(body.provider).length === Object.keys(removal.provider).length;
    const outcomes = [typeof body?.removedAt === "string" && body.removedAt.length > 0, body?.alreadyRemoved === true, body?.superseded === true].filter(Boolean).length;
    if (body?.bindingId !== removal.bindingId || body?.hubSeat !== removal.hubSeat || body?.removalRevision !== removal.removalRevision || !sameProvider || outcomes !== 1) {
      defer("invalid-removal-receipt"); return;
    }
    deps.bindings.reportProviderRemoval(removal.bindingId, { provider: removal.provider, removalRevision: removal.removalRevision,
      status: body.superseded === true ? "superseded" : "confirmed", reason: body.superseded === true ? "newer-provider-revision" : undefined,
      receipt: { bindingId: removal.bindingId, hubSeat: removal.hubSeat, provider: removal.provider, removalRevision: removal.removalRevision,
        ...(typeof body.removedAt === "string" ? { removedAt: body.removedAt } : body.alreadyRemoved === true ? { alreadyRemoved: true } : { superseded: true }) } });
    deps.log?.("network leave: acked");
  } catch { defer("removal-effect-unknown"); deps.log?.("network leave: store-unreachable"); }
  finally { clearTimeout(timer); opts.signal?.removeEventListener("abort", stop); }
}
