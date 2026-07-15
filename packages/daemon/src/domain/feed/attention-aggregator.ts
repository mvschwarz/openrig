// OPR.0.4.4.15 FR-1 — daemon-side attention aggregation (the SEE architecture,
// call A): the LOCAL daemon fans out server-side to each subscribed host's
// shipped GET /api/queue/list?attention=1 over the registered HTTP+bearer
// transport, merges, and returns ONE AggregatedPayload. Bearer tokens never
// reach the browser — this module is the only place remote hosts are
// contacted for the feed.
//
// Reuse, not reimplementation: the LOCAL leg invokes the SAME
// QueueRepository.listAttention query the existing route uses (injected at
// the route wiring); the registry is read through S11's shared
// hosts-registry-reader (interface cell — never re-parsed); the remote hop
// rides the shared remote-daemon-http core with the READ deadline class
// named EXPLICITLY at this call-site (arch sharpening: 5s — a poll, not a
// bootstrap; the up-leaf's 120s budget lives at ITS call-site).
//
// FR-1/R15-2 honesty: EVERY subscribed host appears in hosts[] on EVERY
// call — ok, unreachable, auth-failed, or unsupported-transport — never
// all-or-nothing, never a silently thinner feed. The registry is read ONLY
// when ≥1 remote subscription is enabled (zero-config never touches it).

import type { AggregatedPayload, PerHostStatus } from "../hosts/fanout-contract.js";
import { LOCAL_HOST_ID } from "../hosts/fanout-contract.js";
import type { HostRegistryLoadResult } from "../hosts/hosts-registry-reader.js";
import { resolveHost } from "../hosts/hosts-registry-reader.js";
import { remoteJsonRequest } from "../hosts/remote-daemon-http.js";

/** The aggregation READ deadline class (per-host bound). Distinct from the
 *  up-leaf's long-running budget by design — named here, passed explicitly. */
export const ATTENTION_READ_TIMEOUT_MS = 5_000;

/** Fixed fan-out cap — a poll across a handful of hosts; adaptive
 *  throttling is out of scope (same v1 posture as the topology walker). */
export const ATTENTION_FANOUT_CONCURRENCY = 4;

export type AttentionItem = Record<string, unknown>;

export interface AttentionAggregatorDeps {
  /** The SAME query the shipped /api/queue/list?attention=1 route runs. */
  listLocalAttention: () => AttentionItem[];
  /** settings-store.listFeedHostSubscriptions (the G15-P1 dynamic class). */
  listSubscriptions: () => Array<{ hostId: string; enabled: boolean }>;
  /** S11's shared reader — called lazily, only when a remote sub exists. */
  loadRegistry: () => HostRegistryLoadResult;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  /** Test override; production uses ATTENTION_READ_TIMEOUT_MS. */
  timeoutMs?: number;
  concurrency?: number;
}

interface PerHostOutcome {
  status: PerHostStatus;
  items: AttentionItem[];
}

async function readHostAttention(hostId: string, reg: HostRegistryLoadResult, deps: AttentionAggregatorDeps): Promise<PerHostOutcome> {
  if (!reg.ok) {
    // Registry unreadable: every subscribed host reports it honestly —
    // the operator sees ONE actionable error per host row, local items
    // are untouched.
    return { status: { hostId, status: "unreachable", error: reg.error }, items: [] };
  }
  const resolved = resolveHost(reg.registry, hostId);
  if (!resolved.ok) {
    return { status: { hostId, status: "unreachable", error: resolved.error }, items: [] };
  }
  if (resolved.host.transport !== "http") {
    // R15-2 (the whoami --all-hosts precedent): SSH-declared hosts are a
    // structured per-host status, never a silently thinner feed.
    return {
      status: { hostId, status: "unsupported-transport", error: `host '${hostId}' is SSH-declared; the aggregated feed read requires an http-transport registry entry (url; bearer optional)` },
      items: [],
    };
  }
  const res = await remoteJsonRequest(resolved.host, "/api/queue/list?attention=1", {
    method: "GET",
    timeoutMs: deps.timeoutMs ?? ATTENTION_READ_TIMEOUT_MS,
    fetchImpl: deps.fetchImpl,
    env: deps.env,
    readFile: deps.readFile,
  });
  if (res.ok) {
    const arr = Array.isArray(res.payload) ? (res.payload as AttentionItem[]) : [];
    return { status: { hostId, status: "ok" }, items: arr.map((i) => ({ ...i, hostId })) };
  }
  switch (res.kind) {
    case "bearer":
      return { status: { hostId, status: "auth-failed", error: res.detail, failedStep: "permission-gate" }, items: [] };
    case "http":
      if (res.status === 401 || res.status === 403) {
        return { status: { hostId, status: "auth-failed", error: `HTTP ${res.status}${res.detail ? `: ${res.detail}` : ""}`, failedStep: "permission-gate" }, items: [] };
      }
      // A remote 4xx/5xx on the read: the feed cannot show that host's
      // items — the closest closed-enum truth is unreachable, with the
      // remote's own status/text as the honest detail and the shipped
      // FailedStep vocabulary riding as the additive detail field.
      return { status: { hostId, status: "unreachable", error: `HTTP ${res.status}${res.detail ? `: ${res.detail}` : ""}`, failedStep: "remote-command-failed" }, items: [] };
    case "timeout":
      return {
        status: {
          hostId,
          status: "unreachable",
          error: res.phase === "body" ? `read timed out: response headers arrived (HTTP ${res.status}) but the body never completed` : `read timed out after ${deps.timeoutMs ?? ATTENTION_READ_TIMEOUT_MS}ms`,
          failedStep: "remote-daemon-unreachable",
        },
        items: [],
      };
    case "network":
      return { status: { hostId, status: "unreachable", error: res.detail, failedStep: "remote-daemon-unreachable" }, items: [] };
  }
}

/** One merged attention payload: local ALWAYS included (stamped with the
 *  contract's LOCAL_HOST_ID), each enabled remote host fanned out under the
 *  read deadline + fixed cap, per-host status complete by construction. */
export async function aggregateAttention(deps: AttentionAggregatorDeps): Promise<AggregatedPayload<AttentionItem>> {
  const localItems = deps.listLocalAttention().map((i) => ({ ...i, hostId: LOCAL_HOST_ID }));
  const hosts: PerHostStatus[] = [{ hostId: LOCAL_HOST_ID, status: "ok" }];
  const items: AttentionItem[] = [...localItems];

  const subs = deps.listSubscriptions().filter((s) => s.enabled);
  if (subs.length === 0) {
    // Zero remote subscriptions: the registry is NEVER read; the payload
    // is today's local feed plus the local status row.
    return { items, hosts };
  }

  const reg = deps.loadRegistry();
  const outcomes = new Array<PerHostOutcome>(subs.length);
  let next = 0;
  const cap = Math.max(1, Math.min(deps.concurrency ?? ATTENTION_FANOUT_CONCURRENCY, subs.length));
  const workers = Array.from({ length: cap }, async () => {
    while (true) {
      const i = next;
      if (i >= subs.length) return;
      next += 1;
      outcomes[i] = await readHostAttention(subs[i]!.hostId, reg, deps);
    }
  });
  await Promise.all(workers);

  // Subscription order preserved in both arrays (deterministic payload).
  for (const outcome of outcomes) {
    hosts.push(outcome.status);
    items.push(...outcome.items);
  }
  return { items, hosts };
}
