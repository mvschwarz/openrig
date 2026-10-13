// OPR.0.7.0.2 (cost reporting, K4): the Pi runner's lookup of OpenRouter's actual charge for its own requests.
//
// Only with --openrouter-charge (usage.pi_openrouter_charge on, which needs usage.pi_cost_facts). The charge is
// looked up with the credential that generated the request, and only when OpenRig knows which one that is:
// Pi's credential source for OpenRouter (pi-readiness's metadata-only classifier, checked again before every
// lookup) must be the OPENROUTER_API_KEY OpenRig forwarded into this seat. A stored sign-in or key, a
// models.json key, or an unknown source records "unavailable" with that reason; no other credential is used.
//
// One lookup at a time, each with a timeout. "Not there yet" answers (404, 408, 429, 5xx, timeout, network) are
// retried later up to a cap; then, like a refusal or a malformed reply, they record "unavailable" with the
// reason. An outcome is done only once the daemon has stored it. Work never waits on any of this.
import type { PiCredentialSource } from "./pi-readiness.js";
import { OPENROUTER_GENERATION_URL, openRouterChargeTarget, parseOpenRouterGeneration, type PiProviderCharge } from "../domain/openrouter-charge.js";
import type { PiUsageFact } from "../domain/pi-usage-facts.js";

export type GenerationReply = { status: number; body: unknown } | { error: "timeout" | "network" };

export interface ChargeLookupIo {
  /** GET /api/v1/generation?id=… with the forwarded key. Never throws. */
  fetchGeneration(generationId: string): Promise<GenerationReply>;
  /** Pi's credential source for OpenRouter in this seat, from metadata only. */
  credentialSource(): PiCredentialSource;
  /** POST the outcomes to the daemon; true when it stored them. */
  postCharges(piSessionId: string, charges: PiProviderCharge[]): Promise<boolean>;
  schedule(fn: () => void, ms: number): void;
}

/** The production lookup: GET /api/v1/generation?id=… with the given key, bounded by a timeout. Never throws and
 *  never puts the key anywhere but the Authorization header. */
export function openRouterGenerationFetcher(
  key: () => string | undefined,
  fetchImpl: typeof fetch | undefined = typeof fetch === "function" ? fetch : undefined,
  timeoutMs = 5000,
): (generationId: string) => Promise<GenerationReply> {
  return async (generationId) => {
    const apiKey = key()?.trim();
    if (!apiKey || !fetchImpl) return { error: "network" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${OPENROUTER_GENERATION_URL}?id=${encodeURIComponent(generationId)}`, {
        headers: { authorization: `Bearer ${apiKey}` }, signal: controller.signal,
      });
      return { status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
    } catch {
      return { error: controller.signal.aborted ? "timeout" : "network" };
    } finally { clearTimeout(timeout); }
  };
}

export const OPENROUTER_CHARGE_MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

type Pending = { piSessionId: string; entryId: string; generationId: string; attempts: number; last?: string };

export class OpenRouterChargeLookup {
  private readonly queue: Pending[] = [];
  /** Keys queued, being looked up, or finished (stored by the daemon). */
  private readonly known = new Set<string>();
  private readonly unposted = new Map<string, { piSessionId: string; charge: PiProviderCharge }>();
  private running = false;

  constructor(private readonly io: ChargeLookupIo, private readonly retryDelaysMs = RETRY_DELAYS_MS) {}

  /** Queue the own OpenRouter requests among facts the daemon has stored; `charged` already have a charge. */
  enqueue(piSessionId: string, facts: PiUsageFact[], charged: ReadonlySet<string>): void {
    for (const fact of facts) {
      if (fact.origin !== "own") continue; // a fork's history belongs to its parent occupant
      const target = openRouterChargeTarget(fact);
      const key = `${piSessionId}\u0000${fact.entryId}`;
      if (!("generationId" in target) || charged.has(fact.entryId) || this.known.has(key)) continue;
      this.known.add(key);
      this.queue.push({ piSessionId, entryId: fact.entryId, generationId: target.generationId, attempts: 0 });
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.flush();
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        const outcome = await this.lookUp(next);
        if (outcome === "retry") {
          const delay = this.retryDelaysMs[Math.min(next.attempts - 1, this.retryDelaysMs.length - 1)] ?? 60_000;
          this.io.schedule(() => { this.queue.push(next); void this.pump(); }, delay);
          continue;
        }
        this.unposted.set(`${next.piSessionId}\u0000${next.entryId}`, { piSessionId: next.piSessionId, charge: outcome });
        await this.flush();
      }
    } finally {
      this.running = false;
    }
  }

  /** Post stored-pending outcomes, per Pi session. Kept for the next pump when the daemon didn't store them. */
  private async flush(): Promise<void> {
    const bySession = new Map<string, PiProviderCharge[]>();
    for (const { piSessionId, charge } of this.unposted.values()) {
      bySession.set(piSessionId, [...(bySession.get(piSessionId) ?? []), charge]);
    }
    for (const [piSessionId, charges] of bySession) {
      let stored = false;
      try { stored = await this.io.postCharges(piSessionId, charges); } catch { stored = false; }
      if (stored) for (const charge of charges) this.unposted.delete(`${piSessionId}\u0000${charge.entryId}`);
    }
  }

  private async lookUp(p: Pending): Promise<PiProviderCharge | "retry"> {
    const unavailable = (reason: string, credentialSource = "OPENROUTER_API_KEY (forwarded by OpenRig)"): PiProviderCharge => ({
      entryId: p.entryId, generationId: p.generationId, status: "unavailable", totalCostUsd: null, upstreamInferenceCostUsd: null,
      cacheDiscountUsd: null, isByok: null, providerName: null, model: null, apiType: null, workspaceId: null,
      generationCreatedAt: null, credentialSource, reason,
    });
    const source = this.io.credentialSource();
    if (source.kind !== "managed-env" || source.provider !== "openrouter") {
      return unavailable(`the generating credential isn't one OpenRig holds (Pi's OpenRouter credential source: ${source.kind})`, `pi:${source.kind}`);
    }
    const credentialSource = `${source.envVar} (forwarded by OpenRig)`;
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
    const parsed = parseOpenRouterGeneration(reply.body, p.generationId);
    if (!parsed.ok) return unavailable(parsed.reason, credentialSource);
    return { entryId: p.entryId, generationId: p.generationId, status: "charged", credentialSource, reason: null, ...parsed.fields };
  }
}
