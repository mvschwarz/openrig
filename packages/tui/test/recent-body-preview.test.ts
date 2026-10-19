import { expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

// The recent-transitions route's entries, as the daemon serves them. `bodyPreview` is the daemon's display text
// derived from the body when the row has no authored summary; an older daemon sends neither it nor a body line.
const entry = (id: number, fields: Record<string, unknown>) => ({
  transitionId: id, qitemId: `q-${id}`, ts: `2026-10-16T20:0${id}:00.000Z`, actorSession: "dev-b@rig-a", change: "claimed",
  summary: null, rig: "rig-a", targetKind: "qitem", target: `q-${id}`, ...fields,
});

async function recentText(entries: unknown[]): Promise<string> {
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/queue/recent-transitions") return Response.json(entries);
    if (u.pathname === "/api/rigs/summary") return Response.json([{ id: "01RIG", name: "rig-a", nodeCount: 2, hasServices: false, latestSnapshotAt: null, latestSnapshotId: null, archivedAt: null, lifecycleState: "running" }]);
    if (u.pathname === "/api/rigs/01RIG/nodes") return Response.json([]);
    throw new Error(`Unexpected request: ${u}`);
  }) as typeof fetch });
  let snap: FleetSnapshot = emptySnapshot();
  const view = createViewState({ instanceId: "recent", getSnapshot: () => snap });
  const refresh = async () => { snap = await hydrateSnapshot(client, undefined, null, null, "rig-a", view.get()); };
  await refresh();
  view.dispatch({ type: "drill", resource: "rig", name: "rig-a" });
  view.dispatch(parseCommand("tab recent"));
  await refresh();
  const screen = renderScreen(view.get(), snap, { cols: 140, rows: 40 });
  return screen.lines.map((l) => l.slice(screen.explorerWidth + 2)).join("\n");
}

it("shows the authored summary first, then the derived body preview, and never invents a line", async () => {
  const text = await recentText([
    entry(1, { summary: "Authored subject", bodyPreview: null }),
    entry(2, { bodyPreview: "Review the retry change" }),
    entry(3, { bodyPreview: "Café 😀 naïve ünïcode line" }),
    entry(4, { bodyPreview: null }),
  ]);
  const lines = text.split("\n").map((l) => l.trim());
  expect(lines).toContain("Authored subject");
  expect(lines).toContain("Review the retry change");
  expect(lines).toContain("Café 😀 naïve ünïcode line");
  expect(lines.filter((l) => l === "no work served")).toHaveLength(1);
  expect(text.indexOf("#2")).toBeLessThan(text.indexOf("Review the retry change"));
  // The event's meaning comes from the typed change, whatever the preview says.
  expect(lines.filter((l) => l.endsWith("· claimed"))).toHaveLength(4);
});

it("prefers the authored summary over a preview an odd server sends alongside it", async () => {
  const text = await recentText([entry(1, { summary: "Authored subject", bodyPreview: "Body line" })]);
  expect(text).toContain("Authored subject");
  expect(text).not.toContain("Body line");
});

it("still works against an older server that sends no bodyPreview field", async () => {
  const older = entry(1, {}) as Record<string, unknown>;
  const text = await recentText([older, entry(2, { summary: "Authored subject" })]);
  expect(text).toContain("no work served");
  expect(text).toContain("Authored subject");
});
