// Codex 0.160.0 normal-frame ownership: bottom_pane/mod.rs at upstream a956835d.
// The HTTP route, guard and tmux input methods are real; pane/process reads and command execution are recorded.
// This is synthetic plumbing coverage, not a native Codex picker or message-consumption claim.
import Database from "better-sqlite3";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { classifyPaneActivity, SessionTransport } from "../src/domain/session-transport.js";
import { findComposerInputLineIndex } from "../src/domain/composer-prompts.js";
import { transportRoutes } from "../src/routes/transport.js";

const quote = "• Ran a command\n  › 1. Yes, proceed (y)\n  2. No (esc)\n  Press enter to confirm or esc to cancel";
const status = "• Working (23s • esc to interrupt)";
const box = "› Ask Codex to do anything\n\n  GPT-6-Astra default · ~/project\n  ? for shortcuts";
const supported = `${quote}\n${status}\n\n${box}`;
const picker = "Would you like to run the following command?\n› 1. Yes, proceed (y)\n  2. No (esc)\nPress enter to confirm or esc to cancel";

type Frame = {
  id: string;
  pane: string | null;
  needsInput: boolean;
  runtime?: "codex" | "claude-code";
  captureFails?: boolean;
  corrected?: boolean;
};
const frames: Frame[] = [
  { id: "supported history", pane: supported, needsInput: false, corrected: true },
  { id: "simplified reported footer is unsupported", pane: `${quote}\n${status}\n› Ask Codex to do anything\nGPT-6-Astra default\n? for shortcuts`, needsInput: true },
  { id: "idle history lacks a live status slot", pane: `${quote}\n\n${box}`, needsInput: true },
  { id: "inline picker after status", pane: `${status}\n${picker}\n\n${box}`, needsInput: true },
  { id: "inline content breaks adjacency", pane: `${quote}\n${status}\nPending question\n\n${box}`, needsInput: true },
  { id: "draft retains selection evidence", pane: supported.replace("Ask Codex to do anything", "typed draft"), needsInput: true },
  { id: "queued input retains selection evidence", pane: `${quote}\n${status}\n› queued message\n\n${box}`, needsInput: true },
  { id: "pending input header retains selection evidence", pane: `• Queued follow-up inputs\n${supported}`, needsInput: true },
  { id: "clipped footer", pane: `${quote}\n${status}\n\n› Ask Codex to do anything`, needsInput: true },
  { id: "missing blank footer separator", pane: supported.replace("anything\n\n", "anything\n"), needsInput: true },
  { id: "unrecognized footer", pane: supported.replace("  GPT-6-Astra default · ~/project", "  another footer"), needsInput: true },
  { id: "visible different client version keeps main result", pane: `>_ OpenAI Codex (v0.161.0)\n${supported}`, needsInput: true },
  { id: "current picker", pane: picker, needsInput: true },
  { id: "Working before current picker", pane: `${status}\n${picker}`, needsInput: true },
  { id: "Working after current picker", pane: `${picker}\n${status}`, needsInput: true },
  { id: "clipped permission question", pane: "Would you like to run the following command?\n  GPT-6-Astra default", needsInput: true },
  { id: "literal permission above otherwise supported boundary", pane: `Would you like to run the following command?\n${supported}`, needsInput: true },
  { id: "request-user-input notes are not a normal frame", pane: `Question 1/1\n› 1. Option one\n  2. Option two\n\n› Add notes\n\n  tab to clear notes | enter to submit answer`, needsInput: true },
  { id: "tall Claude picker", runtime: "claude-code", pane: ["Choose", "❯ 1. Yes", ...Array.from({ length: 18 }, () => "     option description"), "  2. No", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n"), needsInput: true },
  { id: "clipped Claude permission", runtime: "claude-code", pane: "Do you want to proceed?\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)", needsInput: true },
  { id: "wrong runtime does not gain Codex history scope", runtime: "claude-code", pane: supported, needsInput: true },
  { id: "draft fallback stays sendable", pane: box.replace("Ask Codex to do anything", "typed draft"), needsInput: false },
  { id: "unknown fallback stays sendable", pane: "Unrecognized terminal content", needsInput: false },
  { id: "null capture stays sendable", pane: null, needsInput: false },
  { id: "failed capture stays sendable", pane: null, captureFails: true, needsInput: false },
];
for (const name of ["after-enter-0.4s.J.txt", "after-enter-15s.J.txt"]) {
  const lines = readFileSync(new URL(`./fixtures/input-box/codex-0.160.0/${name}`, import.meta.url), "utf8").split("\n");
  const at = findComposerInputLineIndex(lines, "›»");
  if (at < 0) throw new Error("retained fixture lacks its composer");
  lines.splice(at, 0, quote, status, "");
  frames.push({ id: `retained frame plus synthetic history: ${name}`, pane: lines.join("\n"), needsInput: false, corrected: true });
}

const observations: unknown[] = [];
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
afterAll(() => {
  const dir = process.env.CHECKPOINT_OUTPUT;
  if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "route-observations.json"), JSON.stringify(observations, null, 2) + "\n"); }
});

async function fixture(frame: Frame, hook: "none" | "running" | "permission") {
  const db = new Database(":memory:");
  cleanup.push(() => db.close());
  migrate(db, ALL_MIGRATIONS);
  const runtime = frame.runtime ?? "codex";
  db.prepare("INSERT INTO rigs(id,name) VALUES ('rig','test')").run();
  db.prepare("INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('node','rig','worker',?)").run(runtime);
  db.exec(`INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('binding','node','worker@test','%1');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('session','node','worker@test','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('generation','node',1,'g1','fresh');`);
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  let staged = "";
  const effects: Array<{ kind: "paste" | "keys"; argv: string[]; text?: string }> = [];
  const tmux = new TmuxAdapter(async () => "", {
    writeFile: async (_path, text) => { staged = text; }, unlink: async () => {},
    tmpName: () => "/fixture/input", bufferName: () => "input",
  }, async argv => {
    if (argv[1] === "paste-buffer") effects.push({ kind: "paste", argv: [...argv], text: staged });
    if (argv[1] === "send-keys") effects.push({ kind: "keys", argv: [...argv] });
    return "";
  });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1" } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue(runtime === "codex" ? "codex" : "claude");
  vi.spyOn(tmux, "getPanePid").mockResolvedValue(null);
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async () => {
    if (frame.captureFails) throw new Error("controlled capture failure");
    return frame.pane;
  });
  const now = new Date("2026-10-19T19:20:00Z");
  const eventBus = new EventBus(db);
  const activity = new AgentActivityStore({ db, eventBus });
  if (hook !== "none") activity.recordHookEvent({ runtime, sessionName: "worker@test",
    hookEvent: hook === "running" ? "UserPromptSubmit" : runtime === "codex" ? "PermissionRequest" : "Notification",
    ...(hook === "permission" && runtime === "claude-code" ? { subtype: "permission_prompt" } : {}), occurredAt: now.toISOString() });
  const transport = new SessionTransport({ db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    tmuxAdapter: tmux, eventBus, agentActivityStore: activity, now: () => now, sleep: async () => {} });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport); await next(); });
  app.route("/api/transport", transportRoutes());
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  await new Promise<void>(resolve => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/api/transport/send`, {
    method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "sender@test" },
    body: JSON.stringify({ session: "worker@test", text: "ordinary status update" }),
  });
  return { response, body: await response.json(), effects };
}

describe("Codex adjacent normal-frame selection history through rig-send HTTP", () => {
  for (const hook of ["none", "running", "permission"] as const) {
    it.each(frames)(`${hook}: $id`, async frame => {
      const result = await fixture(frame, hook);
      const classifier = classifyPaneActivity(frame.pane ?? "", { runtime: frame.runtime ?? "codex" });
      observations.push({ id: frame.id, hook, corrected: frame.corrected ?? false, classifier,
        status: result.response.status, body: result.body, effects: result.effects });
      const refuse = hook === "permission" || (hook === "none" && frame.needsInput);
      expect(result.response.status).toBe(refuse ? 409 : 200);
      expect(result.body).toMatchObject(refuse ? { ok: false, reason: "target_needs_input" } : { ok: true });
      if (refuse) expect(result.effects).toEqual([]);
      else {
        expect(result.effects.map(effect => effect.kind)).toEqual(["paste", "keys"]);
        expect(result.effects[0]).toMatchObject({ text: "ordinary status update" });
        expect(result.effects[1]!.argv).toContain("Enter");
      }
      if (frame.corrected) expect(classifier).toMatchObject({ state: "agent_active", reason: "mid_work_pattern" });
    });
  }
});
