// OPR.0.7.0.2 (cost reporting, K4): the Pi runner's lookup of OpenRouter's actual charge for its own requests.
//
// Only with --openrouter-charge (usage.pi_openrouter_charge on, which needs usage.pi_cost_facts). The charge is
// looked up with the credential that generated the request, and only when that is established: Pi records no
// per-request credential, so the runner observes Pi's credential metadata at launch and at every refresh, and
// a request is eligible only when the observations before and after it both show the OPENROUTER_API_KEY OpenRig
// forwarded, no extension that could replace it, and no change in between (pi-readiness judgeChargeProvenance).
// Anything else records "unavailable" with that reason; no other credential is used, and nothing is decided
// from a later read.
//
// One lookup at a time, with a timeout covering the reply and a byte limit on it. "Not there yet" answers (404,
// 408, 429, 5xx, timeout, network) are retried later up to a cap; then, like a refusal, a malformed or
// oversized reply, they record "unavailable" with the reason. An outcome is done only once the daemon says it
// stored it (or already had it); an unacknowledged one is posted again on its own bounded schedule, without
// another lookup. Work never waits on any of this.
import { OPENROUTER_GENERATION_URL, openRouterChargeTarget, parseOpenRouterGeneration, type PiProviderCharge } from "../domain/openrouter-charge.js";
import type { PiUsageFact } from "../domain/pi-usage-facts.js";

/** Whether a request's credential is established (from pi-readiness judgeChargeProvenance). */
export type ChargeProvenance = { ok: true; credentialSource: string } | { ok: false; reason: string };

export type GenerationReply =
  | { status: number; body: unknown }
  | { status: number; malformed: true }
  | { status: number; tooLarge: true }
  | { error: "timeout" | "network" };

export interface ChargeLookupIo {
  /** GET /api/v1/generation?id=… with the forwarded key. Never throws. */
  fetchGeneration(generationId: string): Promise<GenerationReply>;
  /** POST the outcomes to the daemon; the entry ids it stored or already had (false when the post failed). */
  postCharges(piSessionId: string, charges: PiProviderCharge[]): Promise<ReadonlySet<string> | false>;
  schedule(fn: () => void, ms: number): void;
  /** A line for the seat's pane (an outcome the daemon kept refusing). */
  notice?(line: string): void;
}

/** The largest generation reply read; a larger one is an explicit "unavailable", never parsed. */
export const OPENROUTER_REPLY_LIMIT_BYTES = 64 * 1024;

/** Replace any string that contains `secret` (anywhere in the reply) with null, so a reply that reflects the key
 *  can never be stored or shown. */
function scrub(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.includes(secret) ? null : value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, secret));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secret)]));
  }
  return value;
}

/** The production lookup: GET /api/v1/generation?id=… with the given key, bounded by one timeout that covers the
 *  headers and the body, and by a byte limit on the body. Never throws; the key goes only into the Authorization
 *  header and is scrubbed from the reply. A body cut off by the timeout is a timeout; a complete body that isn't
 *  JSON is "malformed"; a body over the limit is "too large". */
export function openRouterGenerationFetcher(
  key: () => string | undefined,
  fetchImpl: typeof fetch | undefined = typeof fetch === "function" ? fetch : undefined,
  timeoutMs = 5000,
  limitBytes = OPENROUTER_REPLY_LIMIT_BYTES,
): (generationId: string) => Promise<GenerationReply> {
  return async (generationId) => {
    const apiKey = key()?.trim();
    if (!apiKey || !fetchImpl) return { error: "network" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${OPENROUTER_GENERATION_URL}?id=${encodeURIComponent(generationId)}`, {
        headers: { authorization: `Bearer ${apiKey}` }, signal: controller.signal, redirect: "error",
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { status: res.status, body: null };
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limitBytes) {
        await res.body?.cancel().catch(() => {});
        return { status: res.status, tooLarge: true };
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limitBytes) {
            await reader.cancel().catch(() => {});
            return { status: res.status, tooLarge: true };
          }
          chunks.push(value);
        }
      }
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      let body: unknown;
      try { body = JSON.parse(text); } catch { return { status: res.status, malformed: true }; }
      return { status: res.status, body: scrub(body, apiKey) };
    } catch {
      return { error: controller.signal.aborted ? "timeout" : "network" };
    } finally { clearTimeout(timeout); }
  };
}

export const OPENROUTER_CHARGE_MAX_ATTEMPTS = 5;
/** How often an outcome the daemon didn't acknowledge is posted again before it is given up (with a notice). */
export const OPENROUTER_CHARGE_MAX_POSTS = 5;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

type Pending = { piSessionId: string; entryId: string; generationId: string; attempts: number; provenance: ChargeProvenance; last?: string };
type Unposted = { piSessionId: string; charge: PiProviderCharge; posts: number };

export class OpenRouterChargeLookup {
  private readonly queue: Pending[] = [];
  /** Keys queued, being looked up, or finished (stored by the daemon). */
  private readonly known = new Set<string>();
  private readonly unposted = new Map<string, Unposted>();
  private running = false;
  private flushScheduled = false;

  constructor(private readonly io: ChargeLookupIo, private readonly retryDelaysMs = RETRY_DELAYS_MS) {}

  private delay(attempt: number): number {
    return this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] ?? 60_000;
  }

  /** Queue the own OpenRouter requests among facts the daemon has stored, each with its credential provenance;
   *  `charged` already have a charge there. */
  enqueue(piSessionId: string, items: Array<{ fact: PiUsageFact; provenance: ChargeProvenance }>, charged: ReadonlySet<string>): void {
    for (const { fact, provenance } of items) {
      if (fact.origin !== "own") continue; // a fork's history belongs to its parent occupant
      const target = openRouterChargeTarget(fact);
      const key = `${piSessionId}\u0000${fact.entryId}`;
      if (!("generationId" in target) || charged.has(fact.entryId) || this.known.has(key)) continue;
      this.known.add(key);
      this.queue.push({ piSessionId, entryId: fact.entryId, generationId: target.generationId, attempts: 0, provenance });
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        const outcome = await this.lookUp(next);
        if (outcome === "retry") {
          this.io.schedule(() => { this.queue.push(next); void this.pump(); }, this.delay(next.attempts));
          continue;
        }
        this.unposted.set(`${next.piSessionId}\u0000${next.entryId}`, { piSessionId: next.piSessionId, charge: outcome, posts: 0 });
        await this.flush();
      }
    } finally {
      this.running = false;
    }
  }

  /** Post the outcomes not yet acknowledged, per Pi session. What the daemon didn't acknowledge is posted again
   *  later on its own schedule (never looked up again), up to a cap, then given up with a notice. */
  private async flush(): Promise<void> {
    const bySession = new Map<string, Unposted[]>();
    for (const item of this.unposted.values()) bySession.set(item.piSessionId, [...(bySession.get(item.piSessionId) ?? []), item]);
    for (const [piSessionId, items] of bySession) {
      let acknowledged: ReadonlySet<string> | false = false;
      try { acknowledged = await this.io.postCharges(piSessionId, items.map((item) => item.charge)); } catch { acknowledged = false; }
      for (const item of items) {
        const key = `${piSessionId}\u0000${item.charge.entryId}`;
        if (acknowledged && acknowledged.has(item.charge.entryId)) { this.unposted.delete(key); continue; }
        item.posts += 1;
        if (item.posts >= OPENROUTER_CHARGE_MAX_POSTS) {
          this.unposted.delete(key);
          this.io.notice?.(`[pi-runner] OpenRouter charge outcome for entry ${item.charge.entryId}: the daemon didn't acknowledge storing it after ${item.posts} posts, so storage couldn't be confirmed; no further posts`);
        }
      }
    }
    const remaining = Math.max(0, ...[...this.unposted.values()].map((item) => item.posts));
    if (this.unposted.size > 0 && !this.flushScheduled) {
      this.flushScheduled = true;
      this.io.schedule(() => { this.flushScheduled = false; void this.flushAlone(); }, this.delay(remaining));
    }
  }

  /** A scheduled post retry on a quiet seat: posts only, never another lookup. */
  private async flushAlone(): Promise<void> {
    if (this.running) return; // the pump in progress flushes on its own
    this.running = true;
    try { await this.flush(); } finally {
      this.running = false;
      // A retry that came due during this post found the pump busy and only queued itself: run it now.
      if (this.queue.length > 0) void this.pump();
    }
  }

  private async lookUp(p: Pending): Promise<PiProviderCharge | "retry"> {
    const unavailable = (reason: string, credentialSource: string): PiProviderCharge => ({
      entryId: p.entryId, generationId: p.generationId, status: "unavailable", totalCostUsd: null, upstreamInferenceCostUsd: null,
      cacheDiscountUsd: null, isByok: null, providerName: null, model: null, apiType: null, workspaceId: null,
      generationCreatedAt: null, credentialSource, reason,
    });
    if (!p.provenance.ok) return unavailable(`the generating credential isn't established: ${p.provenance.reason}`, "not established");
    const credentialSource = p.provenance.credentialSource;
    p.attempts += 1;
    let reply: GenerationReply;
    try { reply = await this.io.fetchGeneration(p.generationId); } catch { reply = { error: "network" }; }
    const status = "error" in reply ? null : reply.status;
    if (status === null || status === 404 || status === 408 || status === 429 || status >= 500) {
      p.last = "error" in reply ? reply.error : `HTTP ${status}`;
      if (p.attempts < OPENROUTER_CHARGE_MAX_ATTEMPTS) return "retry";
      return unavailable(`not available after ${p.attempts} lookups (last: ${p.last})`, credentialSource);
    }
    if ("error" in reply) return unavailable("lookup failed", credentialSource);
    if (status === 401 || status === 403) return unavailable(`the generating key can't read this generation (HTTP ${status})`, credentialSource);
    if (status !== 200) return unavailable(`lookup refused (HTTP ${status})`, credentialSource);
    if ("tooLarge" in reply) return unavailable(`reply larger than ${OPENROUTER_REPLY_LIMIT_BYTES} bytes`, credentialSource);
    if ("malformed" in reply) return unavailable("malformed reply: not JSON", credentialSource);
    const parsed = parseOpenRouterGeneration(reply.body, p.generationId);
    if (!parsed.ok) return unavailable(parsed.reason, credentialSource);
    return { entryId: p.entryId, generationId: p.generationId, status: "charged", credentialSource, reason: null, ...parsed.fields };
  }
}
