import { expect, it } from "vitest";
import { createViewState, computeExplorerRows, emptySnapshot } from "../src/state.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { attentionLines } from "../src/attention/attention-model.js";
import { renderScreen } from "../src/render.js";
import { parseCommand } from "../src/grammar.js";
import { pageReadKey } from "../src/page-read.js";
import { createLiveRefresh } from "../src/live.js";

it("groups the existing views under seven entries and preserves direct aliases and Back", () => {
  const view = createViewState({ instanceId: "s03" });
  // FLEET · PROJECTS is #3093's explicit fleet view; the local PROJECTS pane is unchanged.
  expect(computeExplorerRows(view.get(), emptySnapshot()).filter(r => !r.label.startsWith(" ")).map(r => r.label)).toEqual(["TOPOLOGY", "SPECS", "PROJECTS", "FLEET · PROJECTS", "TERMINALS", "FEED", "SYSTEM"]);
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

it("reads instance Health directly and renders its explicit scope", async () => {
  const calls: string[] = [];
  const client = new DaemonClient({ fetchImpl: (async url => { calls.push(new URL(String(url)).pathname); return Response.json({ records: [], evaluatedAt: null, total: 0, truncated: false }); }) as typeof fetch });
  const view = createViewState({ instanceId: "s03" }); view.dispatch(parseCommand("system"));
  const snap = await hydrateSnapshot(client, undefined, null, null, null, view.get());
  expect(calls).toEqual(["/api/health"]);
  expect(snap.health.availability).toBe("loaded");
  expect(renderScreen(view.get(), snap, { cols: 80, rows: 24 }).lines.join("\n")).toContain("Instance health");
});
