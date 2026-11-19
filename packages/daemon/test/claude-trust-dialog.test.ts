// Claude Code 2.1.310's workspace trust dialog as a restore met it in a moved project folder, with a synthetic user and
// path. Claude draws the heading before its options, and its focus opens on "No, exit": an Enter there exits Claude.
import Database from "better-sqlite3";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { classifyPaneActivity, SessionTransport } from "../src/domain/session-transport.js";
import { transportRoutes } from "../src/routes/transport.js";

const dialog = readFileSync(new URL("./fixtures/claude-trust-2.1.310.txt", import.meta.url), "utf8");
// The launch line, the rule, the heading and the folder: the frame before the options are drawn.
const heading = dialog.split("\n").slice(0, 6).join("\n");
const yesFocused = dialog.replace(" ❯ No, exit\n   Yes, I trust this folder", "   No, exit\n ❯ Yes, I trust this folder");
const rule = "─".repeat(60);
const composer = `Claude Code v2.1.310\n${rule}\n❯ \n${rule}\n  ⏵⏵ accept edits on (shift+tab to cycle)`;
const frames = [
  { id: "heading-before-options", pane: heading, current: true },
  { id: "dialog-on-no-exit", pane: dialog, current: true },
  { id: "dialog-on-yes", pane: yesFocused, current: true },
  { id: "dialog-answered-composer-below", pane: `${dialog}\n${composer}`, current: false },
  { id: "reply-quoting-the-heading", pane: `● The restore stopped at:\n  Accessing workspace:\n  /home/user\n\n${composer}`, current: false },
];

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

describe("Claude's workspace trust dialog, from its heading on", () => {
  it.each(frames)("$id: the resume probe and the send classifier", ({ pane, current }) => {
    for (const runtime of [undefined, "claude-code"] as const) {
      expect(classifyPaneActivity(pane, { runtime }).reason === "selection_prompt").toBe(current);
      expect(classifyPaneActivity(pane, { runtime, currentClaudeDialogueOnly: true }).reason === "selection_prompt").toBe(current);
    }
    expect(classifyPaneActivity(pane, { runtime: "codex" }).reason).not.toBe("selection_prompt");
    const probe = assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude", paneContent: pane });
    expect(probe).toMatchObject(current ? { status: "inconclusive", code: "trust_gate" } : { status: "resumed" });
  });

  it.each(frames)("$id: an ordinary send", async ({ pane, current }) => {
    const db = new Database(":memory:"); cleanup.push(() => db.close()); migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('node','rig','worker','claude-code');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('binding','node','worker@test','%1');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('session','node','worker@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('generation','node',1,'g1','fresh');`);
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name)); guard.recoverActivation();
    let staged = "";
    const effects: Array<{ kind: string; text?: string }> = [];
    const tmux = new TmuxAdapter(async () => "", {
      writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/input", bufferName: () => "input",
    }, async argv => {
      if (argv[1] === "paste-buffer") effects.push({ kind: "paste", text: staged });
      if (argv[1] === "send-keys") effects.push({ kind: "keys" });
      return "";
    });
    tmux.deliveryGuard = guard;
    vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
    vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1" } as never]);
    vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("claude");
    vi.spyOn(tmux, "getPanePid").mockResolvedValue(null);
    vi.spyOn(tmux, "capturePaneContent").mockResolvedValue(pane);
    const now = new Date("2026-11-19T01:45:59Z");
    const eventBus = new EventBus(db), activity = new AgentActivityStore({ db, eventBus });
    const transport = new SessionTransport({ db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: tmux,
      eventBus, agentActivityStore: activity, now: () => now, sleep: async () => {} });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport); await next(); });
    app.route("/api/transport", transportRoutes());
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
    await new Promise<void>(resolve => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    // No hook (a restored seat whose activity hooks weren't reapplied), then a fresh running and a fresh idle hook.
    for (const hook of ["none", "UserPromptSubmit", "Stop"] as const) {
      if (hook !== "none") activity.recordHookEvent({ runtime: "claude-code", sessionName: "worker@test", hookEvent: hook, occurredAt: now.toISOString() });
      effects.length = 0;
      const response = await fetch(`http://127.0.0.1:${port}/api/transport/send`, { method: "POST",
        headers: { "content-type": "application/json", "x-openrig-session": "sender@test" },
        body: JSON.stringify({ session: "worker@test", text: "codeword check" }) });
      const body = await response.json() as { ok: boolean; reason?: string };
      expect({ hook, status: response.status, ok: body.ok, effects: effects.map(x => x.kind) })
        .toEqual({ hook, status: current ? 409 : 200, ok: !current, effects: current ? [] : ["paste", "keys"] });
      if (current) expect(body.reason).toBe("target_needs_input");
    }
  });
});
