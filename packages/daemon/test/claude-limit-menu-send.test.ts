// Claude's usage-limit menu offers to spend money ("Switch to usage credits"), so a send must never type into it.
// The frame is a real one, from two Claude seats on 2026-08-10. Claude's StopFailure hook for a rate limit reads
// unknown with reason usage_limit, and a fresh hook (within the send window) sends the read to the dialogue-only
// check, which skips the generic numbered-row scan. These cells pin that the menu is refused there too, before any
// write, whatever the fresh hook says.
//
// Pieces: the real hook route, SQLite activity store and SessionTransport; tmux is a fixture that shows the frame.
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { activityRoutes } from "../src/routes/activity.js";

const LIMIT_MENU = [
  "✻ Brewed for 1s",
  "",
  "▔".repeat(80),
  "   What do you want to do?",
  "",
  "   ❯ 1. Stop and wait for limit to reset",
  "     2. Switch to usage credits",
  "     3. Switch to Team plan",
  "",
  "   Enter to confirm · Esc to cancel",
  "",
].join("\n");

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(pane: string | (() => Promise<string>) = LIMIT_MENU) {
  const db = createFullTestDb(); databases.push(db);
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), bus = new EventBus(db);
  const rig = rigRepo.createRig("r1001"), node = rigRepo.addNode(rig.id, "worker.a", { role: "worker", runtime: "claude-code" });
  const name = "worker-a@r1001", session = sessionRegistry.registerSession(node.id, name);
  sessionRegistry.updateStatus(session.id, "running"); sessionRegistry.updateBinding(node.id, { tmuxSession: name });
  const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
  const now = () => new Date();
  const store = new AgentActivityStore({ db, eventBus: bus, now, resolveOccupantGeneration: () => generation,
    isRegisteredOccupantGeneration: (id, g) => Boolean(db.prepare("SELECT 1 FROM occupant_tenures WHERE node_id=? AND generation_uuid=?").get(id, g)) });
  const paste = vi.fn(async () => ({ ok: true as const })), enter = vi.fn(async () => ({ ok: true as const }));
  const tmux = { hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
    getPaneCommand: async () => "claude", getPanePid: async () => null, listPanes: async () => [], hasSessionEnv: async () => false,
    capturePaneContent: typeof pane === "function" ? pane : async () => pane, sendText: paste, sendKeys: enter, readPaneLastActivity: async () => now().getTime() / 1000 - 120 };
  const oracle = new SeatActivityService({ tmux: tmux as never, defaultWindowSeconds: 3, now });
  const app = new Hono();
  app.use("*", async (c, next) => {
    for (const [key, value] of Object.entries({ agentActivityStore: store, seatActivityService: oracle,
      activityHookToken: "local-fixture-token", sessionRegistry, eventBus: bus })) c.set(key as never, value as never);
    await next();
  });
  app.route("/activity", activityRoutes);
  const hook = async (event: string, subtype: string | null, ageMs: number) => {
    const r = await app.request("/activity/hooks", { method: "POST", headers: { "content-type": "application/json",
      "x-openrig-activity-token": "local-fixture-token" }, body: JSON.stringify({ runtime: "claude-code", sessionName: name,
        generation, hookEvent: event, subtype, occurredAt: new Date(now().getTime() - ageMs).toISOString() }) });
    expect(r.status).toBe(200);
  };
  const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux as never, agentActivityStore: store,
    now, sleep: async () => undefined, activityEndpointFile: () => null });
  return { name, hook, transport, paste, enter };
}

// A message envelope carries digits ("Sent: 11-19 21:43Z"); in a selection menu a digit can pick an option.
const MESSAGE = "From: planner@r1001\nSent: 11-19 21:43Z\n---\nsynthetic work for this seat";

it.each([
  ["a fresh rate-limit StopFailure (reads unknown)", "StopFailure", "rate_limit", 1_000],
  ["a fresh Stop (reads idle)", "Stop", null, 1_000],
  ["a fresh idle_prompt Notification (reads idle)", "Notification", "idle_prompt", 1_000],
  ["a stale hook (the pane probe reads it)", "StopFailure", "rate_limit", 120_000],
] as const)("the usage-limit menu is refused before any write after %s", async (_name, event, subtype, ageMs) => {
  const f = fixture();
  await f.hook(event, subtype, ageMs);
  const sent = await f.transport.send(f.name, MESSAGE);
  expect(sent).toMatchObject({ ok: false, reason: "target_needs_input" });
  expect(f.paste).not.toHaveBeenCalled();
  expect(f.enter).not.toHaveBeenCalled();
});

// Shapes the footer recognizer doesn't cover: a row drawn after the footer, and an option wrapped onto two rows with
// the footer changed. The menu's layout at the installed Claude Code isn't verified, so after a usage-limit hook the
// refusal mustn't depend on it.
const AFTER_FOOTER = `${LIMIT_MENU.trimEnd()}\n   Usage credit balance: $0.00\n`;
const WRAPPED = LIMIT_MENU.replace("     2. Switch to usage credits", "     2. Add funds to continue with usage\n        credits").replace("Enter to confirm · Esc to cancel", "Enter to select · Esc to go back");

// Every fresh hook a menu can follow: the usage-limit one takes the full read, the others the dialogue-only read, where
// a numbered cursor row with no input box drawn is a current menu whatever its footer.
const FRESH_HOOKS = [["rate-limit StopFailure", "StopFailure", "rate_limit"], ["Stop", "Stop", null],
  ["idle_prompt Notification", "Notification", "idle_prompt"], ["UserPromptSubmit (running)", "UserPromptSubmit", null],
  ["SessionStart (unknown)", "SessionStart", null]] as const;

it.each(FRESH_HOOKS.flatMap(([hookName, event, subtype]) =>
  [["a row after the footer", AFTER_FOOTER], ["a wrapped option and another footer", WRAPPED]].map(([shape, frame]) => [hookName, shape, frame, event, subtype] as const)))(
  "after a fresh %s, a menu with %s is refused before any write", async (_hook, _shape, frame, event, subtype) => {
    const f = fixture(frame);
    await f.hook(event, subtype, 1_000);
    const sent = await f.transport.send(f.name, MESSAGE);
    expect(sent).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(f.paste).not.toHaveBeenCalled();
    expect(f.enter).not.toHaveBeenCalled();
  });

// A wrapped option and an unnumbered row inside the menu, after a hook that carries no limit reason: the footer
// recognizer walks past them to the cursor's option.
const WRAPPED_WITH_ROWS = LIMIT_MENU.replace("     2. Switch to usage credits",
  "     2. Wait here, then continue automatically when the limit\n        resets\n     3. Add funds to continue with usage credits\n        Usage credit balance: $0.00")
  .replace("     3. Switch to Team plan", "     4. Upgrade your plan");

it.each([["a fresh Stop", "Stop", null], ["a fresh idle_prompt Notification", "Notification", "idle_prompt"]] as const)(
  "after %s the footer recognizer refuses a menu with wrapped and unnumbered rows, before any write", async (_name, event, subtype) => {
    const f = fixture(WRAPPED_WITH_ROWS);
    await f.hook(event, subtype, 1_000);
    expect(await f.transport.send(f.name, MESSAGE)).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(f.paste).not.toHaveBeenCalled();
    expect(f.enter).not.toHaveBeenCalled();
  });

// After a usage-limit hook, a send needs a pane that positively reads an input box.
const TALL_MENU = ["   What do you want to do?", "", "   ❯ 1. Stop and wait for limit to reset",
  ...Array.from({ length: 7 }, (_, i) => [`     ${i + 2}. Option ${i + 2}`, "        A description of this option"]).flat(),
  "", "   Enter to confirm · Esc to cancel", ""].join("\n");

it.each([
  ["an unreadable capture", async () => { throw new Error("capture failed"); }],
  ["an empty capture", async () => ""],
  ["a menu whose cursor row is above the scan window", async () => TALL_MENU.replace("Enter to confirm · Esc to cancel", "Enter to choose · Esc to go back")],
] as const)("after a fresh usage-limit hook, %s refuses before any write", async (_name, capture) => {
  const f = fixture(capture as () => Promise<string>);
  await f.hook("StopFailure", "rate_limit", 1_000);
  expect(await f.transport.send(f.name, MESSAGE)).toMatchObject({ ok: false, reason: "target_needs_input" });
  expect(f.paste).not.toHaveBeenCalled();
  expect(f.enter).not.toHaveBeenCalled();
});

it("control: after a fresh usage-limit hook, an ordinary input box at a limit wall still delivers", async () => {
  const f = fixture(["You've hit your limit · resets 11pm (UTC)", "", "─".repeat(80), "❯\u00a0", "─".repeat(80), "  ? for shortcuts", ""].join("\n"));
  await f.hook("StopFailure", "rate_limit", 1_000);
  expect(await f.transport.send(f.name, MESSAGE)).toMatchObject({ ok: true });
  expect(f.paste).toHaveBeenCalled();
});

// A menu taller than the scan window, with another footer, after each fresh hook that isn't a usage limit: its cursor row
// is found in the bottom block.
const TALL_OTHER_FOOTER = TALL_MENU.replace("Enter to confirm · Esc to cancel", "Enter to choose · Esc to go back");
it.each(FRESH_HOOKS.filter(([, event]) => event !== "StopFailure"))(
  "after a fresh %s, a menu taller than the scan window is refused before any write", async (_name, event, subtype) => {
    const f = fixture(TALL_OTHER_FOOTER);
    await f.hook(event, subtype, 1_000);
    expect(await f.transport.send(f.name, MESSAGE)).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(f.paste).not.toHaveBeenCalled();
    expect(f.enter).not.toHaveBeenCalled();
  });

// The sibling spend-limit dialog (same title, unnumbered rows, read from the 2.1.282 bundle), after every fresh hook.
const SPEND_LIMIT_MENU = ["✻ Brewed for 1s", "", "▔".repeat(80), "   What do you want to do?                     Usage credit balance: $0.00", "",
  "   ❯ Adjust monthly spend limit: $50       ← or → to adjust · Del to remove limit",
  "     Wait for limit to reset               Resets 11pm (UTC)",
  "     Upgrade to Max for higher session limits every month", "", "   Enter to confirm · Esc to cancel", ""].join("\n");
it.each(FRESH_HOOKS)("after a fresh %s, the spend-limit menu is refused before any write", async (_name, event, subtype) => {
  const f = fixture(SPEND_LIMIT_MENU);
  await f.hook(event, subtype, 1_000);
  expect(await f.transport.send(f.name, MESSAGE)).toMatchObject({ ok: false, reason: "target_needs_input" });
  expect(f.paste).not.toHaveBeenCalled();
  expect(f.enter).not.toHaveBeenCalled();
});

// Controls: option text that isn't a current menu still delivers after a fresh Stop.
const COMPOSER = ["─".repeat(80), "❯\u00a0", "─".repeat(80), "  ? for shortcuts", ""];
it.each([
  ["the menu quoted in history above the input box", [...LIMIT_MENU.split("\n"), "✻ Worked for 2s", "", ...COMPOSER].join("\n")],
  ["a draft of numbered lines in the input box", ["✻ Brewed for 1s", "", "─".repeat(80), "❯ please choose:", "  1. Stop and wait", "  2. Switch to usage credits",
    "─".repeat(80), "  ? for shortcuts", ""].join("\n")],
  ["the menu quoted in history above a multiline draft", [...LIMIT_MENU.split("\n"), "✻ Worked for 2s", "", "─".repeat(80), "❯ please choose:",
    "  1. Stop and wait", "  2. Switch to usage credits", "─".repeat(80), "  ? for shortcuts", ""].join("\n")],
  ["the menu quoted above the unframed input box (#808's layout)", [...LIMIT_MENU.split("\n"), "", "❯ ", "  ⏵⏵ auto mode on (shift+tab to cycle)", ""].join("\n")],
  ["a dismissed menu followed by Claude's reply", [...LIMIT_MENU.split("\n"), "● Waiting for the limit to reset before continuing.", ""].join("\n")],
] as const)("control: after a fresh Stop, %s isn't read as a menu and delivers", async (_name, frame) => {
  const f = fixture(frame);
  await f.hook("Stop", null, 1_000);
  expect(await f.transport.send(f.name, MESSAGE)).toMatchObject({ ok: true });
  expect(f.paste).toHaveBeenCalled();
});

it("control: a fresh Stop over an ordinary idle composer still delivers", async () => {
  const f = fixture(["✻ Brewed for 1s", "", "─".repeat(80), "❯ ", "─".repeat(80), "  ? for shortcuts", ""].join("\n"));
  await f.hook("Stop", null, 1_000);
  expect(await f.transport.send(f.name, MESSAGE)).toMatchObject({ ok: true });
  expect(f.paste).toHaveBeenCalled();
});
