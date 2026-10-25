import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { StartupController } from "../src/startup.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { attentionLines, opensOnDefaultFeed, answerRequest, replyAct } from "../src/attention/attention-model.js";
import { parseCommand } from "../src/grammar.js";
import type { AttentionRead } from "@openrig/daemon/attention";
import type { Action, FleetSnapshot } from "../src/types.js";

// Whose queue the Feed shows is a view, never who acts: the header names both, and acts stay the primary user's.

const perspective = (viewing: string | null, basis: NonNullable<AttentionRead["perspective"]>["basis"], defaultSource: NonNullable<AttentionRead["perspective"]>["defaultSource"] = "chosen") =>
  ({ viewing, basis, defaultSource, actingAs: { person: defaultSource === "none" ? null : "mike@external", authority: "primary-user" as const } });
const read = (p?: AttentionRead["perspective"]): AttentionRead =>
  ({ scope: "instance", readAt: "2026-10-25T10:00:00Z", items: [], sources: [{ source: "queue", state: "available", detail: "fixture" }], detail: null, detailError: null, ...(p ? { perspective: p } : {}) });

it("the whose command chooses whose queue the Feed reads, and the Feed says who acts", async () => {
  const views: Array<string | null> = [];
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/attention") {
      const view = u.searchParams.get("view"); views.push(view);
      return Response.json(read(view === "sarah" ? perspective("sarah@external", "chosen-here") : view === "all" ? perspective(null, "all") : perspective("mike@external", "default")));
    }
    if (u.pathname === "/api/queue/human-updates") return Response.json({ items: [], limit: 20, truncated: false });
    if (u.pathname === "/api/files/roots") return Response.json({ roots: [] });
    throw new Error(`Unexpected request: ${u}`);
  }) as typeof fetch });
  let snap: FleetSnapshot = emptySnapshot();
  const view = createViewState({ instanceId: "perspective", getSnapshot: () => snap });
  const refresh = async () => { snap = await hydrateSnapshot(client, undefined, null, null, null, view.get()); };
  const title = () => attentionLines(view.get(), snap, 120)[0]!.text;

  view.dispatch(parseCommand("attention")); await refresh();
  expect(views.at(-1)).toBe("default");
  expect(title()).toBe("FEED · Viewing mike@external · you act as mike@external · whose all shows everyone");

  view.dispatch(parseCommand("whose sarah")); await refresh();
  expect(view.get()).toMatchObject({ section: "needs", attentionView: "sarah" });
  expect(views.at(-1)).toBe("sarah");
  // Viewing Sarah is not acting as Sarah.
  expect(title()).toBe("FEED · Viewing sarah@external · you act as mike@external · whose all shows everyone");

  // Leaving the Feed and coming back keeps the chosen view.
  view.dispatch(parseCommand(":topology")); view.dispatch(parseCommand("attention")); await refresh();
  expect(views.at(-1)).toBe("sarah");

  view.dispatch(parseCommand("whose all")); await refresh();
  expect(views.at(-1)).toBe("all");
  expect(title()).toBe("FEED · Viewing everyone · you act as mike@external");

  view.dispatch(parseCommand("whose default")); await refresh();
  expect(view.get().attentionView).toBeNull();
  expect(views.at(-1)).toBe("default");
});

it("the header says when the view names no one, when no default is chosen, and is as before with no one registered", () => {
  const state = createViewState({ instanceId: "perspective" }).get();
  const lines = (r: AttentionRead) => attentionLines({ ...state, section: "needs" }, { ...emptySnapshot(), attentionRead: r }, 120).map(l => l.text);
  expect(lines(read({ ...perspective(null, "unknown"), requested: "ana" }))[0]).toBe('FEED · Viewing no registered person "ana" · you act as mike@external');
  expect(lines(read(perspective(null, "all", "none"))).slice(0, 2)).toEqual([
    "FEED · Viewing everyone · you act as the primary user",
    "No default person is chosen: rig gateway default <id> chooses one.",
  ]);
  expect(lines(read())[0]).toBe("FEED · Instance / All humans");
});

it("opens on the default person's Feed only when one was chosen, and only before the person has moved", () => {
  const opening = createViewState({ instanceId: "perspective" }).get();
  expect(opening.section).toBe("topology");
  expect(opensOnDefaultFeed(read(perspective("mike@external", "default", "chosen")), opening, true)).toBe(true);
  // One person with no chosen default, or several and none chosen, stays on the topology.
  expect(opensOnDefaultFeed(read(perspective("mike@external", "default", "only-person")), opening, true)).toBe(false);
  expect(opensOnDefaultFeed(read(perspective(null, "all", "none")), opening, true)).toBe(false);
  expect(opensOnDefaultFeed(read(), opening, true)).toBe(false);
  expect(opensOnDefaultFeed(null, opening, true)).toBe(false);
  // Once the person has typed or moved, the TUI doesn't move them.
  expect(opensOnDefaultFeed(read(perspective("mike@external", "default", "chosen")), opening, false)).toBe(false);
  expect(opensOnDefaultFeed(read(perspective("mike@external", "default", "chosen")), { ...opening, section: "specs" }, true)).toBe(false);
});

it("an act on someone else's ask says who acts and whose ask it is, and carries the primary user's authority", () => {
  const item = { id: "queue:sarahs", kind: "action" as const, summary: "Ship the draft?", unblocks: null, urgency: "routine", at: "2026-10-25T10:00:00Z",
    scope: "instance · project unknown", project: null, source: "/api/queue/sarahs", recipient: "sarah@external",
    answer: { verb: "approve" as const, actorSession: "sarah@external" } };
  const served = (p?: AttentionRead["perspective"]): FleetSnapshot => ({ ...emptySnapshot(), attentionRead: { ...read(p), items: [item], detail: { item, lines: [], files: [] } } });
  const state = { ...createViewState({ instanceId: "perspective" }).get(), section: "needs", attentionOpen: item.id };
  const approve = (snap: FleetSnapshot) => attentionLines(state, snap, 160).find(l => l.action?.type === "act")!;
  const viewingSarah = approve(served(perspective("sarah@external", "chosen-here")));
  expect(viewingSarah.text).toContain("Approve as mike@external on sarah@external's ask");
  expect(answerRequest(viewingSarah.action as Extract<Action, { type: "act"; act: "answer" }>)).toEqual(
    { verb: "approve", qitemId: "sarahs", actorSession: "sarah@external", authority: "primary-user" });
  // With no one registered, the label is as before.
  expect(approve(served()).text).toContain("Approve as sarah@external (closes");
});

it("a row parked on someone is resolved with reply, in words, as the primary user", () => {
  const item = { id: "queue:parked", kind: "action" as const, summary: "Layout", unblocks: "Layout", urgency: "routine", at: "2026-10-25T10:00:00Z",
    scope: "instance · project unknown", project: null, source: "/api/queue/parked", recipient: "sarah@external",
    answer: { verb: "resolve" as const, actorSession: "sarah@external" } };
  const snap: FleetSnapshot = { ...emptySnapshot(), attentionRead: { ...read(perspective("sarah@external", "chosen-here")), items: [item], detail: { item, lines: [], files: [] } } };
  const state = { ...createViewState({ instanceId: "perspective" }).get(), section: "needs", attentionOpen: item.id };
  const text = attentionLines(state, snap, 160).map(l => l.text).join("\n");
  expect(text).toContain("Resolve it in your own words: reply <your decision>, as mike@external on sarah@external's ask");
  const act = replyAct(snap.attentionRead, item.id, "Use the wide layout");
  expect(act).toEqual({ type: "act", act: "answer", qitemId: "parked", verb: "resolve", actorSession: "sarah@external", decision: "Use the wide layout" });
  expect(answerRequest(act as Extract<Action, { type: "act"; act: "answer" }>)).toMatchObject({ verb: "resolve", decision: "Use the wide layout", authority: "primary-user" });
});

// The startup paths, through the real StartupController and main.ts's own enable and opening functions and callbacks,
// taken verbatim from the source (main.ts is the terminal entry, so it isn't imported).
function startupHarness(rigsSummary: () => Promise<unknown[]>) {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("  function enableLive(): boolean");
  const funcs = source.slice(start, source.indexOf("  function commandContext()", start));
  const wiring = source.slice(source.indexOf("  if (client) startup = new StartupController"));
  const changeStart = wiring.indexOf("    onChange: () => {") + "    onChange: () => {".length;
  const change = wiring.slice(changeStart, wiring.indexOf("\n    },\n    onHelp:", changeStart));
  const workStart = wiring.indexOf("    onWork: async (rig, seat) => {") + "    onWork: async (rig, seat) => {".length;
  const work = wiring.slice(workStart, wiring.indexOf("\n    },\n  });", workStart));
  if (start < 0 || !funcs.includes("openChosenDefaultFeed();") || !work.includes("enableLive")) throw new Error("main.ts no longer matches this harness");
  let attentionReads = 0;
  const client = { baseUrl: "http://fixture", rigsSummary, humanAttention: async () => { attentionReads++; return read(perspective("mike@external", "default")); } };
  const view = createViewState({ instanceId: "startup" });
  const body = `let startup; let liveEnabled = false, inputRevision = 0, buildMismatch = false, eventsDropped = false;
    let activityEvents = null, crashCartOpts = {}; const snapshot = emptySnapshot();
    const live = { refresh: async () => {}, snapshot: () => snapshot, pushed() {}, connectionStatus() {} };
    const reviewCache = { clear() {} }; const draw = () => {}; const checkDaemonBuild = () => {};
    const subscribeActivityEvents = () => ({ close() {} });
    ${funcs}
    startup = new StartupController({ client, home: "fixture", probe: async () => { throw new Error("no native probe"); },
      startDaemon: async () => { throw new Error("no daemon start"); }, onChange: () => {${change}}, onWork: async (rig, seat) => {${work}} });
    return { startup, view, touch() { inputRevision++; startup.interacted(); } };`;
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const harness = new Function("StartupController", "client", "view", "emptySnapshot", "opensOnDefaultFeed", js)(StartupController, client, view, emptySnapshot, opensOnDefaultFeed);
  return { ...harness, attentionReads: () => attentionReads };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

it("a normal start opens on the chosen default's Feed", async () => {
  const h = startupHarness(async () => []);
  await h.startup.refresh(); await settle();
  expect(h.attentionReads()).toBe(1);
  expect(h.view.get().section).toBe("needs");
});

it("a person who pressed a key while the TUI was still connecting stays where they are", async () => {
  let resolve!: (rigs: unknown[]) => void;
  const h = startupHarness(() => new Promise<unknown[]>((r) => { resolve = r; }));
  const refresh = h.startup.refresh();
  h.touch(); await h.startup.key("escape"); resolve([]); await refresh; await settle();
  expect(h.attentionReads()).toBe(0);
  expect(h.view.get().section).toBe("topology");
});

it("whose sarah reads delivered updates in Sarah's view too", async () => {
  const updateViews: Array<string | null> = [];
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/attention") return Response.json(read(perspective("sarah@external", "chosen-here")));
    if (u.pathname === "/api/queue/human-updates") {
      const view = u.searchParams.get("view"); updateViews.push(view);
      // The daemon filters by the view (its route test pins that); this fixture does the same.
      return Response.json({ limit: 20, truncated: false, items: ["mike", "sarah"].filter((p) => view !== "sarah" || p === "sarah").map((p) => ({
        qitemId: `${p}-update`, summary: `${p} delivery`, body: `${p} delivery`, humanDetail: null, destinationSession: `${p}@external`,
        sourceSession: "worker@rig", tags: null, evidenceRef: null, deliveredAt: "2026-10-25T10:00:00Z", deliveryReceipt: "fixture" })) });
    }
    if (u.pathname === "/api/files/roots") return Response.json({ roots: [] });
    throw new Error(`Unexpected request: ${u}`);
  }) as typeof fetch });
  let snap = emptySnapshot();
  const view = createViewState({ instanceId: "updates", getSnapshot: () => snap });
  view.dispatch(parseCommand("whose sarah")); snap = await hydrateSnapshot(client, undefined, null, null, null, view.get());
  expect(updateViews).toEqual(["sarah"]);
  expect(snap.attentionRead?.items.map((i) => i.recipient)).toEqual(["sarah@external"]);
});
