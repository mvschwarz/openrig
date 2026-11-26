import { expect, it } from "vitest";
import { DaemonClient, dismissFailureNotice } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot, computeExplorerRows } from "../src/state.js";
import { attentionLines, replyAct, answerRequest } from "../src/attention/attention-model.js";
import { parseCommand } from "../src/grammar.js";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import type { AttentionItem, AttentionRead } from "@openrig/daemon/attention";
import type { Action, FleetSnapshot } from "../src/types.js";

const feedRequest: AttentionItem = {
  id: "queue:request", kind: "action", summary: "Choose a cover", unblocks: null, urgency: "routine",
  at: "2026-09-10T01:00:00Z", scope: "instance", project: null, source: "/api/queue/request",
};
const localAsker = "orch-lead@openrig-build";
const askerTerminal: Action = { type: "act", act: "open-terminal", view: "seat:openrig-build/orch.lead" };

function renderRequest(item: AttentionItem, details = false) {
  const snap: FleetSnapshot = { ...demoSnapshot(), attentionRead: {
    scope: "instance", readAt: item.at ?? "", items: [item], sources: [], detailError: null,
    detail: details ? { item, lines: [], files: [] } : null,
  } };
  const view = createViewState({ instanceId: "feed-seat", getSnapshot: () => snap });
  view.dispatch(parseCommand("attention"));
  if (details) view.dispatch({ type: "attention-open", id: item.id });
  return renderScreen(view.get(), snap, { cols: 120, rows: 32 });
}

it("offers the asking seat's terminal directly on the Feed row", () => {
  const screen = renderRequest({ ...feedRequest, asker: localAsker });
  const row = screen.contentTargets.find(target => target.action.type === "attention-open" && target.action.id === feedRequest.id);
  const chat = screen.contentTargets.find(target => target.action.type === "act" && target.action.act === "open-terminal");

  expect(row).toBeDefined();
  expect(chat?.action).toEqual(askerTerminal);
  expect(chat?.y).toBe((row?.y ?? 0) + 1);
  expect(screen.lines[(chat?.y ?? 0) - 1]).toContain(`Chat with ${localAsker}`);
});

it("shows the verbatim source session on the Feed row for an unloaded asker", () => {
  const asker = "Dev-QA@remote-rig.v2";
  const screen = renderRequest({ ...feedRequest, asker });
  const row = screen.contentTargets.find(target => target.action.type === "attention-open" && target.action.id === feedRequest.id);

  expect(row).toBeDefined();
  expect(screen.lines[row?.y ?? 0]?.slice(screen.explorerWidth + 1).trim()).toBe(`From: ${asker}`);
  expect(screen.contentTargets.some(target => target.action.type === "act" && target.action.act === "open-terminal")).toBe(false);
});

it("keeps the existing Chat link in request details", () => {
  const screen = renderRequest({ ...feedRequest, asker: localAsker }, true);
  const chat = screen.contentTargets.find(target => target.action.type === "act" && target.action.act === "open-terminal");

  expect(chat?.action).toEqual(askerTerminal);
  expect(screen.lines[(chat?.y ?? 0) - 1]).toContain(`Chat with ${localAsker} (opens its terminal)  (open ▸)`);
});

it("leaves Feed rows without an asker unchanged", () => {
  const screen = renderRequest(feedRequest);
  const row = screen.contentTargets.find(target => target.action.type === "attention-open" && target.action.id === feedRequest.id);

  expect(row).toBeDefined();
  expect(screen.lines[(row?.y ?? 0) - 1]).toContain("Choose a cover");
  expect(screen.lines[row?.y ?? 0]).toContain("instance ·");
  expect(screen.contentTargets.some(target => target.action.type === "act" && target.action.act === "open-terminal")).toBe(false);
});

it.each([140, 80])("keeps readable summaries, passive exact source navigation and Back at width %i", async width => {
  const requests: string[] = [];
  const item = { id: "queue:request", kind: "action" as const, summary: "Choose the readable cover for the book", unblocks: "Print the approved edition", urgency: "urgent", at: "2026-09-10T01:00:00Z", scope: "project alpha", project: { id: "alpha", root: "/books/alpha" }, source: "/api/queue/request" };
  const data: AttentionRead = { scope: "instance", readAt: item.at, items: [item], sources: [{ source: "queue", state: "available", detail: "Actual source" }], detail: null, detailError: null };
  let unavailable = false;
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url, init) => {
    const u = new URL(String(url)); requests.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    if (u.pathname === "/api/attention") {
      if (unavailable) throw new Error("source offline");
      return Response.json({ ...data, detail: u.searchParams.get("item") ? { item, lines: ["Full original request", "History: still pending"], files: [{ label: "Evidence", path: "/books/alpha/proof.md#decision" }] } : null });
    }
    if (u.pathname === "/api/queue/human-updates") { if (unavailable) throw new Error("source offline"); return Response.json({ items: [], limit: 20, truncated: false }); }
    if (u.pathname === "/api/files/roots") return Response.json({ roots: [{ name: "alpha", path: "/books/alpha" }] });
    if (u.pathname === "/api/files/read") return Response.json({ root: "alpha", path: "proof.md", absolutePath: "/books/alpha/proof.md", content: "# Decision\nReadable cover", mtime: item.at, contentHash: "fixture", size: 25, truncated: false, totalBytes: 25 });
    throw new Error(`Unexpected request: ${u}`);
  }) as typeof fetch });
  let snap: FleetSnapshot = emptySnapshot();
  const view = createViewState({ instanceId: "attention", getSnapshot: () => snap });
  const refresh = async () => { snap = await hydrateSnapshot(client, undefined, null, null, null, view.get()); };
  view.dispatch(parseCommand("attention")); await refresh();
  const lines = attentionLines(view.get(), snap, width - 33), text = lines.map(l => l.text).join("\n");
  expect(text).toContain("Human requests"); expect(text).toContain("Updates");
  expect(text.replace(/\s+/g, " ")).toContain(item.summary);
  expect(lines.every(l => l.text.length <= width - 33)).toBe(true);
  view.dispatch(lines.find(l => l.action?.type === "attention-open")!.action!); await refresh();
  expect(view.get().attentionOpen).toBe(item.id);
  expect(attentionLines(view.get(), snap, width).map(l => l.text).join("\n")).toContain("Full original request");
  const retained = { ...snap, attentionRead: { ...snap.attentionRead!, items: [] } };
  const resolved = attentionLines(view.get(), retained, width).map(l => l.text).join("\n");
  expect(resolved).toContain("Source record"); expect(resolved).not.toContain("Human requests");
  const caller = view.get();
  view.dispatch({ type: "attention-source", path: "/books/alpha/proof.md#decision" });
  expect(view.get().file).toEqual({ root: "alpha", path: "proof.md", anchor: "decision" });
  expect(view.get().project).toEqual(item.project); await refresh();
  view.dispatch({ type: "back" }); await refresh();
  expect(view.get().project).toEqual(caller.project);
  expect(view.get().attentionOpen).toBe(item.id);
  view.dispatch({ type: "back" }); await refresh(); expect(view.get().attentionOpen).toBeNull();
  view.dispatch({ type: "attention-open", id: item.id }); await refresh();
  view.dispatch({ type: "attention-source", path: "/books/alpha/proof.md#decision" }); await refresh();
  view.dispatch({ type: "select", index: computeExplorerRows(view.get(), snap).findIndex(r => r.key === "section:needs") });
  view.dispatch({ type: "activate" }); await refresh();
  expect(view.get().attentionOpen).toBeNull(); expect(view.get().file).toBeNull();
  unavailable = true; await refresh();
  const failed = attentionLines(view.get(), snap, width).map(l => l.text).join("\n");
  expect(failed).toContain("Unavailable"); expect(failed).not.toContain("No current items");
  expect(requests.every(r => r.startsWith("GET "))).toBe(true);
  expect(requests.filter(r => r.includes("/api/files/read")).every(r => r === "GET /api/files/read?root=alpha&path=proof.md")).toBe(true);
});

it("answers an ask from its request view as Steering does: the served Approve, as the person, through the mission-control write", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const asked = { id: "queue:quiet-ask", kind: "action" as const, summary: "Which name for the release?", unblocks: null, urgency: "routine", at: "2026-10-23T18:00:00Z",
    scope: "instance · project unknown", project: null, source: "/api/queue/quiet-ask", recipient: "human-founder@kernel",
    answer: { verb: "approve" as const, actorSession: "human-founder@kernel" } };
  const parked = { ...asked, id: "queue:parked", summary: "A row parked on the person", source: "/api/queue/parked", answer: undefined };
  let wanted = asked;
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url, init) => {
    const u = new URL(String(url));
    requests.push({ method: init?.method ?? "GET", path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.pathname === "/api/attention") return Response.json({ scope: "instance", readAt: asked.at, items: [asked, parked], sources: [{ source: "queue", state: "available", detail: "fixture" }],
      detail: u.searchParams.get("item") ? { item: wanted, lines: ["Slack: not sent: created without --alert, so it's on Steering only"], files: [] } : null, detailError: null });
    if (u.pathname === "/api/queue/human-updates") return Response.json({ items: [], limit: 20, truncated: false });
    if (u.pathname === "/api/mission-control/action") return Response.json({ verb: "approve", qitemId: "quiet-ask", closedQitem: {} });
    throw new Error(`Unexpected request: ${u}`);
  }) as typeof fetch });
  let snap: FleetSnapshot = emptySnapshot();
  const view = createViewState({ instanceId: "attention-answer", getSnapshot: () => snap });
  const refresh = async () => { snap = await hydrateSnapshot(client, undefined, null, null, null, view.get()); };
  view.dispatch(parseCommand("attention")); await refresh();
  view.dispatch({ type: "attention-open", id: asked.id }); await refresh();
  const lines = attentionLines(view.get(), snap, 140);
  const approve = lines.find(l => l.action?.type === "act");
  expect(approve?.action).toEqual({ type: "act", act: "answer", qitemId: "quiet-ask", verb: "approve", actorSession: "human-founder@kernel" });
  expect(lines.map(l => l.text).join("\n")).toContain("Slack: not sent");
  wanted = parked;
  view.dispatch({ type: "back" }); view.dispatch({ type: "attention-open", id: parked.id }); await refresh();
  expect(attentionLines(view.get(), snap, 140).some(l => l.action?.type === "act")).toBe(false);
  // What the driver loop sends for that act: Steering's own write, with the primary user's authority, nothing else.
  await client.missionControlAction(answerRequest(approve!.action as Extract<Action, { type: "act"; act: "answer" }>));
  expect(requests.filter(r => r.method === "POST")).toEqual([
    { method: "POST", path: "/api/mission-control/action", body: { verb: "approve", qitemId: "quiet-ask", actorSession: "human-founder@kernel", authority: "primary-user" } },
  ]);
});

it("answers a question ask from its request view: an act per open option, reply for the person's words, Chat to the asker, and no bare Approve", () => {
  const questions = [{ id: "q1", question: "Which name?", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] },
    { id: "q2", question: "Ship today?", options: [{ id: "y", label: "Yes", recommended: true }, { id: "n", label: "No" }] }];
  const asked = { id: "queue:two-questions", kind: "action" as const, summary: "Name and date", unblocks: null, urgency: "routine", at: "2026-10-23T19:00:00Z",
    scope: "instance · project unknown", project: null, source: "/api/queue/two-questions", recipient: "human-founder@kernel", asker: "orch-lead@r",
    humanQuestions: questions, humanAnswers: { q1: "a" }, answer: { verb: "answer" as const, actorSession: "human-founder@kernel" } };
  const read: AttentionRead = { scope: "instance", readAt: asked.at, items: [asked], sources: [{ source: "queue", state: "available", detail: "fixture" }],
    detail: { item: asked, lines: [], files: [] }, detailError: null };
  const snap = { ...emptySnapshot(), attentionRead: read,
    hosts: [{ id: "local", name: "local", reachable: true, rigs: [{ name: "r", pods: [{ name: "orch", agents: [{ name: "orch.lead", session: "orch-lead@r" }] }] }] }] } as unknown as FleetSnapshot;
  const view = createViewState({ instanceId: "attention-questions", getSnapshot: () => snap });
  const list = attentionLines(view.get(), snap, 200).map(l => l.text).join("\n");
  expect(list).toContain("Questions: 2, 1 unanswered");
  view.dispatch({ type: "attention-open", id: asked.id });
  const lines = attentionLines(view.get(), snap, 200), text = lines.map(l => l.text).join("\n");
  expect(text).toContain("1. Which name? (answered: Alpha)");
  expect(text).toContain("2. Ship today? (unanswered)");
  expect(text).not.toContain("Approve as");
  // Only the open question's options are offered, each the mission-control answer as the person.
  expect(lines.filter(l => l.action?.type === "act" && l.action.act === "answer").map(l => l.action)).toEqual([
    { type: "act", act: "answer", qitemId: "two-questions", verb: "answer", actorSession: "human-founder@kernel", questionId: "q2", optionId: "y" },
    { type: "act", act: "answer", qitemId: "two-questions", verb: "answer", actorSession: "human-founder@kernel", questionId: "q2", optionId: "n" },
  ]);
  expect(lines.find(l => l.text.includes("Chat with orch-lead@r"))?.action).toEqual({ type: "act", act: "open-terminal", view: "seat:r/orch.lead" });
  // reply: the person's words on the open request; without one open it says how.
  expect(parseCommand("reply Neither, call it Gamma")).toEqual({ type: "attention-reply", text: "Neither, call it Gamma" });
  expect(replyAct(read, asked.id, "Neither, call it Gamma")).toEqual({ type: "act", act: "answer", qitemId: "two-questions", verb: "answer",
    actorSession: "human-founder@kernel", decision: "Neither, call it Gamma" });
  expect(replyAct(read, null, "words")).toMatchObject({ type: "notice" });
});

it("dismisses an open informational update from its detail, as the terminal's act; a closed one offers nothing", () => {
  const update = { id: "queue-update:fyi", kind: "update" as const, summary: "Build finished", unblocks: null, urgency: "routine", at: "2026-11-20T12:00:00Z",
    scope: "instance · project unknown", project: null, source: "/api/queue/fyi", recipient: "parkingmeter@external", dismiss: { actorSession: "parkingmeter@external" } };
  const detailOf = (item: AttentionItem) => {
    const snap: FleetSnapshot = { ...emptySnapshot(), attentionRead: { scope: "instance", readAt: update.at, items: [item], sources: [], detail: { item, lines: ["State: pending"], files: [] }, detailError: null } };
    const view = createViewState({ instanceId: "attention-dismiss", getSnapshot: () => snap });
    view.dispatch({ type: "attention-open", id: item.id });
    return attentionLines(view.get(), snap, 200);
  };
  const lines = detailOf(update);
  const dismiss = lines.find(l => l.action?.type === "act");
  expect(dismiss?.text).toContain("Dismiss update as human@host (unattributed) on parkingmeter@external's behalf (closes it; not approval, proof of delivery or a reply)");
  expect(dismiss?.action).toEqual({ type: "act", act: "answer", qitemId: "fyi", verb: "dismiss", actorSession: "parkingmeter@external" });
  expect(answerRequest(dismiss!.action as Extract<Action, { type: "act"; act: "answer" }>))
    .toEqual({ qitemId: "fyi", verb: "dismiss", actorSession: "parkingmeter@external", authority: "primary-user" });
  expect(detailOf({ ...update, dismiss: undefined }).some(l => l.action?.type === "act")).toBe(false);
});

it("says a dismiss changed nothing only when the daemon refused it, not when it got no answer", async () => {
  const failure = async (fetchImpl: typeof fetch) => {
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl });
    return dismissFailureNotice(await client.missionControlAction({ verb: "dismiss", qitemId: "fyi", actorSession: "parkingmeter@external", authority: "primary-user" })
      .then(() => { throw new Error("expected the dismiss to fail"); }, (err: unknown) => err));
  };
  const refused = await failure((async () => Response.json({ error: "qitem_already_terminal", state: "done" }, { status: 409 })) as typeof fetch);
  expect(refused).toMatch(/^Not dismissed, nothing changed: .*409 — qitem_already_terminal/);
  const unanswered = await failure((async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
  expect(unanswered).not.toContain("nothing changed");
  expect(unanswered).toContain("Dismiss not confirmed, the daemon didn't answer: fetch failed. It may have been dismissed");
});

it("sends an answer act's choice or words in the one mission-control write", async () => {
  const bodies: unknown[] = [];
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ verb: "answer", qitemId: "two-questions", closedQitem: {}, answer: { outcome: "recorded", unanswered: [] } });
  }) as typeof fetch });
  await client.missionControlAction({ verb: "answer", qitemId: "two-questions", actorSession: "human-founder@kernel", questionId: "q2", optionId: "y" });
  await client.missionControlAction({ verb: "answer", qitemId: "two-questions", actorSession: "human-founder@kernel", decision: "Neither" });
  expect(bodies).toEqual([
    { verb: "answer", qitemId: "two-questions", actorSession: "human-founder@kernel", questionId: "q2", optionId: "y" },
    { verb: "answer", qitemId: "two-questions", actorSession: "human-founder@kernel", decision: "Neither" },
  ]);
});
