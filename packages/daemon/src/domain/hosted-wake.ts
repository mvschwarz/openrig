// Rings a hosted member (an outside tool on the team) when a row lands for it, through the trigger its roster entry
// declares. It sends a pointer to the row, never the row's body: the member reads the row under its own grant. A 2xx
// means the trigger accepted the ring, not that the member picked the work up: pickup is its claim on the row.
import type { RosterWake } from "./rosters.js";
import { resolveSecret } from "./gateway/slack/secrets.js";
import { safeDecodeURIComponent, validateOutboundUrl } from "./mission-control/outbound-url-validator.js";

/** How long a trigger may take to answer. After that the ring is unconfirmed, not failed: the trigger may have it. */
export const HOSTED_WAKE_TIMEOUT_MS = 10_000;

export interface HostedWakeRing {
  qitemId: string;
  destination: string;
  summary: string | null;
  source: string | null;
}

export interface HostedWakeOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** The webhook URL can itself be a credential, so a result names the secret it came from, never the URL. */
const failed = (ref: string, detail: string) => ({ classified: "failed" as const, nudgeResult: `failed:webhook (${ref}) ${detail}` });

export async function ringHostedWake(
  ring: HostedWakeRing,
  wake: RosterWake,
  opts: HostedWakeOptions = {},
): Promise<{ classified: "indeterminate" | "failed"; nudgeResult: string }> {
  const { url_ref: urlRef, authorization_ref: authorizationRef, secrets_env_file: envFile } = wake.webhook;
  const lookup = { ...(opts.env ? { env: opts.env } : {}), ...(envFile ? { envFile } : {}) };
  const url = resolveSecret(urlRef, lookup);
  if (!url) return failed(urlRef, "isn't set: no webhook URL to ring");
  const authorization = authorizationRef ? resolveSecret(authorizationRef, lookup) : null;
  if (authorizationRef && !authorization) return failed(urlRef, `not rung: its Authorization value (${authorizationRef}) isn't set`);
  const checked = validateOutboundUrl(url);
  if (!checked.valid) return failed(urlRef, `not rung: the URL is invalid (${checked.reason})`);
  // Credentials in the URL go in the Authorization header (the validator's contract), so the request URL carries none.
  const target = new URL(checked.parsedUrl!.toString());
  let auth = authorization;
  if (target.username || target.password) {
    auth ??= `Basic ${Buffer.from(`${safeDecodeURIComponent(target.username)}:${safeDecodeURIComponent(target.password)}`).toString("base64")}`;
    target.username = "";
    target.password = "";
  }
  try {
    const res = await (opts.fetchImpl ?? fetch)(target.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({
        source: "openrig.queue", schema_version: 1, event: "work-waiting",
        qitem_id: ring.qitemId, destination: ring.destination, summary: ring.summary, from: ring.source,
      }),
      // A redirect isn't followed: the ring goes only where the roster says.
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? HOSTED_WAKE_TIMEOUT_MS),
    });
    void res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) {
      return { classified: "indeterminate", nudgeResult: `wake-accepted:webhook (${urlRef}) answered ${res.status}; pickup is the member's claim on this row` };
    }
    if (res.status >= 300 && res.status < 400) return failed(urlRef, `answered ${res.status}, a redirect, which isn't followed`);
    return failed(urlRef, `answered ${res.status}`);
  } catch (err) {
    // An error's text can carry the URL, so only a fixed classification is recorded: the timeout, or the error code.
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    // The POST may have reached the trigger and started a run, so the ring is unknown, like an unconfirmed send: it isn't
    // rung again blindly (see hostedRingMayHaveArrived), and the member's claim is still the pickup.
    if (timedOut) {
      return { classified: "indeterminate", nudgeResult: `indeterminate:webhook (${urlRef}) didn't answer within ${opts.timeoutMs ?? HOSTED_WAKE_TIMEOUT_MS} ms, `
        + "so it may have the ring; it isn't rung again, and pickup is the member's claim on this row" };
    }
    const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
    return failed(urlRef, `couldn't be reached (${typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "network error"})`);
  }
}

/** A ring the trigger accepted, or one it may have received before it stopped answering. Either can start a run, so
 *  recovery doesn't ring that wake intent again. A ring that never left (no URL, an invalid one, a refused connection)
 *  is neither. */
export function hostedRingMayHaveArrived(nudgeResult: string): boolean {
  return nudgeResult.startsWith("wake-accepted:webhook ") || nudgeResult.startsWith("indeterminate:webhook ");
}
