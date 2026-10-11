import { expect, it } from "vitest";
import type { AttentionItem, AttentionRead } from "@openrig/daemon/attention";
import { composeHumanUpdates, attentionLines, type DeliveredHumanUpdates } from "../src/attention/attention-model.js";
import { retainAttentionSources } from "../src/attention/source-continuity.js";
import { createViewState, emptySnapshot } from "../src/state.js";

const current = (id = "fyi"): AttentionItem => ({ id: "queue-update:" + id, kind: "update", summary: "Current urgent FYI",
  recipient: "human@kernel", urgency: "urgent", unblocks: null, at: "2026-10-01T12:00:00Z", scope: "instance", project: null, source: "/api/queue/" + id });
const read = (items: AttentionItem[]): AttentionRead => ({ scope: "instance", readAt: "2026-10-09T12:00:00Z", items,
  sources: [{ source: "queue", state: "available", detail: "actions" }, { source: "queue updates", state: "available", detail: "open FYIs" }],
  detail: null, detailError: null });
const delivered = (id = "fyi"): DeliveredHumanUpdates => ({ limit: 20, truncated: false, items: [{
  qitemId: id, summary: "Historical delivery", body: "Delivered body", humanDetail: null, destinationSession: "human@kernel",
  sourceSession: "author@fixture", tags: null, evidenceRef: null, deliveredAt: "2026-10-08T12:00:00Z", deliveryReceipt: "1000.0001",
}] });

it("joins receipt history without duplicating an open update or replacing its current detail and priority", () => {
  const item = current(), attention = read([item]);
  attention.detail = { item, lines: ["Current queue body", "State: pending"], files: [] };
  const merged = composeHumanUpdates(attention, delivered(), item.id)!;
  expect(merged.items).toEqual([item]);
  expect(merged.detail).toEqual(attention.detail);
  expect(merged.sources.find(s => s.source === "delivered updates")?.state).toBe("available");
});

it("keeps older urgent current updates ahead of newer routine delivered history", () => {
  const merged = composeHumanUpdates(read([current()]), delivered("other"))!;
  expect(merged.items.map(i => i.id)).toEqual(["queue-update:fyi", "human-update:other"]);
  expect(merged.items[1]?.at).toBe("2026-10-08T12:00:00Z");
});

it("retains unavailable current-update coverage and drops it after a successful empty or partial answer", () => {
  const prior = read([current()]), failed = read([]);
  failed.sources[1] = { source: "queue updates", state: "unavailable", detail: "owned reader failed" };
  const retained = retainAttentionSources(failed, prior);
  expect(retained.retained).toBe(true); expect(retained.read.items).toEqual(prior.items);
  expect(retainAttentionSources(read([]), retained.read).read.items).toEqual([]);
  const partial = read([]); partial.sources[1] = { source: "queue updates", state: "partial", detail: "bounded answer" };
  expect(retainAttentionSources(partial, prior).read.items).toEqual([]);
});

it("renders an unsent local FYI without inventing an approval or a delivery receipt", () => {
  const item = current(), attention = read([item]);
  attention.detail = { item, lines: ["Current queue body", "State: pending"], files: [] };
  const merged = composeHumanUpdates(attention, { limit: 20, truncated: false, items: [] }, item.id)!;
  expect(merged.detail).toEqual(attention.detail);
  const state = createViewState({ instanceId: "owned-fixture" }).get();
  const text = attentionLines(state, { ...emptySnapshot(), attentionRead: merged }, 120).map(l => l.text).join("\n");
  expect(text).toContain("Updates"); expect(text).toContain("No action needed"); expect(text).toContain("Viewing is not approval");
  expect(text).not.toContain("Delivery receipt:");
});

it("does not retain delivered history beyond a successful empty receipt window when only current updates fail", () => {
  const prior = composeHumanUpdates(read([]), delivered())!;
  const failed = read([]);
  failed.sources[1] = { source: "queue updates", state: "unavailable", detail: "owned reader failed" };
  const emptyHistory = composeHumanUpdates(failed, { limit: 20, truncated: false, items: [] })!;
  expect(retainAttentionSources(emptyHistory, prior).read.items).toEqual([]);
});


import { PageRead } from "../src/page-read.js";
import { createServer } from "node:http";
import { once } from "node:events";

it("keeps critical current updates ahead of urgent, routine and newer delivered history", () => {
  const rows = [
    { ...current("routine"), urgency: "routine", at: "2026-10-07T12:00:00Z" },
    { ...current("urgent"), at: "2026-10-06T12:00:00Z" },
    { ...current("critical"), urgency: "critical" },
  ];
  expect(composeHumanUpdates(read(rows), delivered("other"))!.items.map(i => i.id))
    .toEqual(["queue-update:critical", "queue-update:urgent", "human-update:other", "queue-update:routine"]);
});

async function refreshHistoryControl(updates: DeliveredHumanUpdates, expected: string[]) {
  let attention = read([current()]);
  let receipts: DeliveredHumanUpdates = { limit: 20, truncated: false, items: [] };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/api/attention" ? attention : receipts));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned HTTP fixture did not bind");
  const origin = "http://127.0.0.1:" + address.port;
  const cache = new PageRead(() => 1000), signal = new AbortController().signal;
  async function refresh() {
    cache.begin(); const request = cache.fetch(fetch, signal);
    const [a, h] = await Promise.all([
      request(origin + "/api/attention").then(r => r.json()) as Promise<AttentionRead>,
      request(origin + "/api/queue/human-updates").then(r => r.json()) as Promise<DeliveredHumanUpdates>,
    ]);
    cache.end(); return composeHumanUpdates(a, h)!;
  }
  try {
    expect((await refresh()).items.map(i => i.id)).toEqual(["queue-update:fyi"]);
    attention = read([]); attention.sources[1] = { source: "queue updates", state: "unavailable", detail: "Owned reader unavailable" };
    receipts = updates;
    expect((await refresh()).items.map(i => i.id)).toEqual(expected);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

it("applies actual page continuity before composition without duplicating same-qitem history", async () => {
  await refreshHistoryControl(delivered(), ["queue-update:fyi"]);
});

it("retains failed current coverage alongside successful unrelated history", async () => {
  await refreshHistoryControl(delivered("other"), ["queue-update:fyi", "human-update:other"]);
});

it("retains failed current coverage with a successful empty receipt window", async () => {
  await refreshHistoryControl({ limit: 20, truncated: false, items: [] }, ["queue-update:fyi"]);
});

it("preserves action date ordering regardless of critical and routine priorities", () => {
  const rows: AttentionItem[] = [
    { ...current("old"), id: "queue:old", kind: "action", urgency: "critical" },
    { ...current("new"), id: "queue:new", kind: "action", urgency: "routine", at: "2026-10-08T12:00:00Z" },
  ];
  expect(composeHumanUpdates(read(rows), { limit: 20, truncated: false, items: [] })!.items.map(i => i.id)).toEqual(["queue:new", "queue:old"]);
});
