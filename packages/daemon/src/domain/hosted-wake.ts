// Rings a hosted member (an outside tool on the team) when a row lands for it, through the trigger its roster entry
// declares. It sends a pointer to the row, never the row's body: the member reads the row under its own grant. A 2xx
// means the trigger accepted the ring, not that the member picked the work up: pickup is its claim on the row.
import { createHmac, randomUUID } from "node:crypto";
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
  /** The clock a signed ring's timestamp is read from, in milliseconds (Date.now by default). */
  now?: () => number;
}

/** A signing key from its secret, read the way receivers read it: `whsec_` followed by base64 is that base64's bytes
 *  (strict: the alphabet with its padding), and any other value is its own UTF-8 bytes. Null only for a `whsec_` with
 *  nothing, or not valid base64, after it: a ring is never signed with a key it wasn't given. */
export function standardWebhookKey(secret: string): Buffer | null {
  if (!secret.startsWith("whsec_")) return secret ? Buffer.from(secret, "utf8") : null;
  const encoded = secret.slice("whsec_".length);
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  return Buffer.from(encoded, "base64");
}

/** A Standard Webhooks v1 signature: HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.` and the body bytes exactly as
 *  sent, as `v1,<base64>`. */
export function standardWebhookSignature(key: Buffer, id: string, timestamp: number, body: Uint8Array): string {
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest("base64")}`;
}

/** The webhook URL can itself be a credential, so a result names the secret it came from, never the URL. */
const failed = (ref: string, detail: string) => ({ classified: "failed" as const, nudgeResult: `failed:webhook (${ref}) ${detail}` });

export async function ringHostedWake(
  ring: HostedWakeRing,
  wake: RosterWake,
  opts: HostedWakeOptions = {},
): Promise<{ classified: "indeterminate" | "failed"; nudgeResult: string }> {
  const { url_ref: urlRef, authorization_ref: authorizationRef, signing_secret_ref: signingRef, secrets_env_file: envFile } = wake.webhook;
  const lookup = { ...(opts.env ? { env: opts.env } : {}), ...(envFile ? { envFile } : {}) };
  const url = resolveSecret(urlRef, lookup);
  if (!url) return failed(urlRef, "isn't set: no webhook URL to ring");
  const authorization = authorizationRef ? resolveSecret(authorizationRef, lookup) : null;
  if (authorizationRef && !authorization) return failed(urlRef, `not rung: its Authorization value (${authorizationRef}) isn't set`);
  // A trigger set up to verify signatures gets a signed ring or none: a ring is never sent unsigned in its place.
  const signingSecret = signingRef ? resolveSecret(signingRef, lookup) : null;
  if (signingRef && !signingSecret) return failed(urlRef, `not rung: its signing secret (${signingRef}) isn't set, and the ring isn't sent unsigned`);
  const signingKey = signingSecret ? standardWebhookKey(signingSecret) : null;
  if (signingRef && !signingKey) {
    return failed(urlRef, `not rung: its signing secret (${signingRef}) starts with whsec_ but isn't followed by valid base64, and the ring isn't sent unsigned`);
  }
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
  const body = JSON.stringify({
    source: "openrig.queue", schema_version: 1, event: "work-waiting",
    qitem_id: ring.qitemId, destination: ring.destination, summary: ring.summary, from: ring.source,
  });
  // Signed over the body's UTF-8 bytes, which are the bytes fetch sends for this string. Each ring is its own message
  // with its own id: a row can be rung again for a new wake, which a receiver mustn't drop as a repeat.
  const signing: Record<string, string> = {};
  if (signingKey) {
    const id = `msg_${randomUUID().replaceAll("-", "")}`;
    const timestamp = Math.floor((opts.now ?? Date.now)() / 1000);
    signing["webhook-id"] = id;
    signing["webhook-timestamp"] = String(timestamp);
    signing["webhook-signature"] = standardWebhookSignature(signingKey, id, timestamp, Buffer.from(body, "utf8"));
  }
  try {
    const res = await (opts.fetchImpl ?? fetch)(target.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}), ...signing },
      body,
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
