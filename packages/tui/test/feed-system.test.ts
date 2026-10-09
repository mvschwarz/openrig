import { expect, it } from "vitest";
import { createViewState, computeExplorerRows, emptySnapshot } from "../src/state.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { attentionLines, composeHumanUpdates } from "../src/attention/attention-model.js";
import { retainAttentionSources } from "../src/attention/source-continuity.js";
import type { AttentionRead } from "@openrig/daemon/attention";
import { renderScreen } from "../src/render.js";
import { parseCommand } from "../src/grammar.js";
import { pageReadKey } from "../src/page-read.js";
import { createLiveRefresh } from "../src/live.js";

it("groups the existing views under six entries and preserves direct aliases and Back", () => {
  const view = createViewState({ instanceId: "s03" });
  expect(computeExplorerRows(view.get(), emptySnapshot()).filter(r => !r.label.startsWith(" ")).map(r => r.label)).toEqual(["TOPOLOGY", "SPECS", "PROJECTS", "TERMINALS", "FEED", "SYSTEM"]);
  view.dispatch(parseCommand("system"));
  expect(view.get().section).toBe("system");
  const healthKey = pageReadKey(view.get());
  expect(computeExplorerRows(view.get(), emptySnapshot()).map(r => r.label)).toEqual(expect.arrayContaining(["  Health", "  Configuration", "  Connections"]));
  for (const command of ["config", "connections"]) {
    view.dispatch(parseCommand(command)); expect(view.get().section).toBe(command);
    expect(pageReadKey(view.get())).not.toBe(healthKey);
    view.dispatch({ type: "back" }); expect(view.get().section).toBe("system");
  }
  view.dispatch(parseCommand("feed")); expect(view.get().section).toBe("needs");
  view.dispatch(parseCommand("attention")); expect(view.get().section).toBe("needs");
});

it.each([80, 140])("joins delivered FYIs without making a decision and retains partial sources at %i", async width => {
  const requests: string[] = []; let failUpdates = false; let failFeed = false; let now = 1000;
  const q = { qitemId: "fyi", humanIntent: "update", humanDetail: "Supplemental exact detail", summary: "Book proof ready", body: "Read the proof. No action needed.", destinationSession: "human-reader@external", sourceSession: "writer@books", tags: ["project:book"], evidenceRef: "/book/proof.md", deliveredAt: "2026-09-10T20:00:00Z", deliveryReceipt: "1000.0001", state: "done" };
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url, init) => {
    const u = new URL(String(url)); requests.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    if (u.pathname === "/api/attention") {
      if (failFeed) throw new Error("feed unavailable");
      return Response.json({ scope: "instance", readAt: q.deliveredAt, items: [{ id: "health:old", kind: "update", summary: "Existing health episode", scope: "instance", source: "/api/health/old", urgency: "warning", at: q.deliveredAt, project: null, unblocks: null }], sources: [{ source: "queue", state: "available", detail: "bounded" }], detail: null, detailError: null });
    }
    if (u.pathname === "/api/queue/human-updates") {
      if (failUpdates) throw new Error("updates unavailable");
      return Response.json({ items: [q], limit: 20, truncated: true });
    }
    if (u.pathname === "/api/files/roots") return Response.json({ roots: [] });
    throw new Error(`unexpected read ${u}`);
  }) as typeof fetch });
  const view = createViewState({ instanceId: "s03" }); view.dispatch(parseCommand("attention"));
  const live = createLiveRefresh({ hydrate: (page, signal) => hydrateSnapshot(client.forPage(page, signal), undefined, null, null, null, view.get()), scopeKey: () => pageReadKey(view.get()), now: () => now, onFrame: () => {} });
  await live.refresh();
  let snap = live.snapshot();
  expect(snap.attentionRead?.items.map(i => i.summary)).toContain("Book proof ready");
  expect(snap.attentionRead?.items.find(i => i.summary === "Book proof ready")?.kind).toBe("update");
  const text = attentionLines(view.get(), snap, width - 25).map(l => l.text).join("\n");
  expect(text).toContain("All humans"); expect(text).toContain("Human requests"); expect(text).toContain("human-reader@external"); expect(text).toContain("project book"); expect(text).toContain("Existing health episode");
  expect(snap.attentionRead?.sources.find(s => s.source === "delivered updates")?.state).toBe("partial");
  failUpdates = true; now = 2000; await live.refresh();
  expect(live.snapshot().attentionRead?.items.map(i => i.summary)).toContain("Book proof ready");
  expect(live.load()).toMatchObject({ stale: true, retainedAt: 1000, lastSuccessAt: 1000 });
  failUpdates = false; view.dispatch({ type: "attention-open", id: "human-update:fyi" }); await live.refresh();
  snap = live.snapshot();
  expect(snap.attentionRead?.detail?.lines.join("\n")).toContain("Supplemental exact detail");
  expect(snap.attentionRead?.detail?.lines.join("\n")).toContain("1000.0001");
  expect(attentionLines(view.get(), snap, width).map(l => l.text).join("\n")).toContain("Viewing is not approval");
  failFeed = true; view.dispatch({ type: "back" }); await live.refresh();
  expect(live.snapshot().attentionRead?.items.map(i => i.summary)).toContain("Book proof ready");
  expect(live.load().stale).toBe(true);
  expect(requests.every(r => r.startsWith("GET "))).toBe(true);
  live.close();
});

it.each([80, 140])("renders undelivered FYIs as searchable updates with no action needed at %i columns", width => {
  const view = createViewState({ instanceId: "fixture" }); view.dispatch(parseCommand("feed"));
  const item = { id: "queue:pending", kind: "update" as const, summary: "Weekly usage alert", urgency: "urgent", recipient: "human@kernel", unblocks: null, at: "2026-01-01T00:00:00Z", scope: "instance", project: null, source: "/api/queue/pending" };
  const read: AttentionRead = { scope: "instance", readAt: item.at, items: [item], sources: [{ source: "queue", state: "available", detail: "Open human requests and FYI updates" }], detail: null, detailError: null };
  const composed = composeHumanUpdates(read, { items: [], limit: 20, truncated: false });
  const text = attentionLines({ ...view.get(), filter: "weekly" }, { ...emptySnapshot(), attentionRead: composed }, width).map(l => l.text).join("\n");
  expect(text.slice(text.indexOf("Human requests"), text.indexOf("Updates"))).not.toContain("Weekly usage alert");
  expect(text.slice(text.indexOf("Updates"))).toContain("[urgent] Weekly usage alert");
  expect(text).toContain("No action needed");
  expect(text).toContain("human@kernel");
  view.dispatch({ type: "attention-open", id: item.id });
  const detail: AttentionRead = { ...read, detail: { item, lines: ["State: pending", "The alert has not reached Slack."], files: [] } };
  const detailText = attentionLines(view.get(), { ...emptySnapshot(), attentionRead: detail }, width).map(l => l.text).join("\n");
  expect(detailText).toContain("No action needed");
  expect(detailText).toContain("State: pending");
});

it("reports unknown updates when the queue source is unavailable", () => {
  const view = createViewState({ instanceId: "fixture" }); view.dispatch(parseCommand("feed"));
  const read: AttentionRead = { scope: "instance", readAt: "2026-01-01T00:00:00Z", items: [],
    sources: [{ source: "queue", state: "unavailable", detail: "Queue read failed" },
      { source: "project catalog", state: "available", detail: "No projects" },
      { source: "mission outcomes", state: "available", detail: "No outcomes" },
      { source: "health", state: "available", detail: "No health updates" }],
    detail: null, detailError: null };
  const composed = composeHumanUpdates(read, { items: [], limit: 20, truncated: false });
  const text = attentionLines(view.get(), { ...emptySnapshot(), attentionRead: composed }, 80).map(l => l.text).join("\n");
  const updates = text.slice(text.indexOf("\nUpdates\n"), text.indexOf("\nRead at "));
  expect(updates).toContain("Unknown: a required source is unavailable or partial.");
  expect(updates).not.toContain("No current items");
});

it("keeps priority when joining delivered FYIs and shows a queue item only once across both sources", () => {
  const item = (id: string, urgency: string, at: string) => ({ id: `queue:${id}`, kind: "update" as const, summary: id, urgency, unblocks: null, at, scope: "instance", project: null, source: `/api/queue/${id}` });
  const read: AttentionRead = { scope: "instance", readAt: "fixture", items: [item("critical", "critical", "2026-01-01"), item("pending", "urgent", "2026-01-02"), item("routine", "routine", "2026-01-05")], sources: [], detail: null, detailError: null };
  const delivered = (qitemId: string, priority: string) => ({ qitemId, priority, summary: qitemId, body: "Delivered FYI", humanDetail: null, destinationSession: "human@kernel", sourceSession: "author@fixture", tags: null, evidenceRef: null, deliveredAt: "2026-01-04", deliveryReceipt: "posted" });
  const result = composeHumanUpdates(read, { items: [delivered("pending", "urgent"), delivered("delivered", "urgent")], limit: 20, truncated: false })!;
  expect(result.items.filter(i => i.source === "/api/queue/pending")).toHaveLength(1);
  expect(result.items.map(i => i.id)).toEqual(["queue:critical", "human-update:delivered", "queue:pending", "queue:routine"]);
  expect(result.items.find(i => i.id === "human-update:delivered")?.urgency).toBe("urgent");
  expect(read.items).toHaveLength(3);
  const unavailable = { ...read, items: [], sources: [{ source: "queue", state: "unavailable" as const, detail: "Queue read failed" }] };
  const freshHistory = composeHumanUpdates(unavailable, { items: [delivered("pending", "urgent")], limit: 20, truncated: false })!;
  const retained = retainAttentionSources(freshHistory, read).read;
  expect(retained.items.filter(i => i.source === "/api/queue/pending")).toHaveLength(1);
  expect(retained.items.map(i => i.id)).toEqual(["queue:critical", "human-update:pending", "queue:routine"]);
});

it("reads instance Health directly and renders its explicit scope", async () => {
  const calls: string[] = [];
  const client = new DaemonClient({ fetchImpl: (async url => { calls.push(new URL(String(url)).pathname); return Response.json({ records: [], evaluatedAt: null, total: 0, truncated: false }); }) as typeof fetch });
  const view = createViewState({ instanceId: "s03" }); view.dispatch(parseCommand("system"));
  const snap = await hydrateSnapshot(client, undefined, null, null, null, view.get());
  expect(calls).toEqual(["/api/health"]);
  expect(snap.health.availability).toBe("loaded");
  expect(renderScreen(view.get(), snap, { cols: 80, rows: 24 }).lines.join("\n")).toContain("Instance health");
});
