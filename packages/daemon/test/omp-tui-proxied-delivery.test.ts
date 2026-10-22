import { afterEach, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const name = "worker@test-rig";
const openDbs: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of openDbs.splice(0)) db.close();
});

function fixture(deliverMessage?: (sessionName: string, text: string) => Promise<{ ok: boolean; error?: string }>) {
  const db = createFullTestDb();
  openDbs.push(db);
  db.prepare("INSERT INTO rigs (id,name) VALUES (?,?)").run("rig-id", "test-rig");
  db.prepare("INSERT INTO nodes (id,rig_id,logical_id,role,runtime) VALUES (?,?,?,?,?)")
    .run("node-id", "rig-id", "worker", "worker", "omp-tui");
  db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES (?,?,?,?)")
    .run("binding-id", "node-id", name, "%1");
  db.prepare("INSERT INTO sessions (id,node_id,session_name,status,origin,startup_status) VALUES (?,?,?,'running','launched','ready')")
    .run("session-id", "node-id", name);
  const registry = new SessionRegistry(db), rigRepo = new RigRepository(db);
  const sendText = vi.fn(async () => ({ ok: true as const }));
  const sendKeys = vi.fn(async () => ({ ok: true as const }));
  const tmux = {
    probeSession: vi.fn(async () => ({ state: "present" as const })),
    hasSession: vi.fn(async () => true),
    listPanes: vi.fn(async () => [{ id: "%1" }]),
    getPaneCommand: vi.fn(async () => "pi"),
    sendText,
    sendKeys,
    setSessionOption: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
  const transport = new SessionTransport({ db, rigRepo, sessionRegistry: registry, tmuxAdapter: tmux,
    runtimeAdapters: deliverMessage ? { "omp-tui": { deliverMessage } } : {},
    sleep: async () => {}, waitForIdlePollMs: 1 });
  return { transport, sendText, sendKeys };
}

it("delivers through runtime proxy without tmux input", async () => {
  const deliverMessage = vi.fn(async () => ({ ok: true }));
  const { transport, sendText, sendKeys } = fixture(deliverMessage);
  await expect(transport.send(name, "hello from rig")).resolves.toMatchObject({
    ok: true, sessionName: name, sent: true, verified: false, outcome: "proxied",
  });
  expect(deliverMessage).toHaveBeenCalledWith(name, "hello from rig");
  expect(sendText).not.toHaveBeenCalled();
  expect(sendKeys).not.toHaveBeenCalled();
});

it("keeps tmux paste and submit path when runtime has no proxy", async () => {
  const { transport, sendText, sendKeys } = fixture();
  const result = await transport.send(name, "ordinary fallback");
  expect(result).toMatchObject({ ok: true, sessionName: name });
  expect(result.outcome).not.toBe("proxied");
  expect(sendText).toHaveBeenCalledWith(name, "ordinary fallback");
  expect(sendKeys).toHaveBeenCalled();
});

it("reports runtime proxy failure without falling back to tmux input", async () => {
  const deliverMessage = vi.fn(async () => ({ ok: false, error: "bridge disconnected" }));
  const { transport, sendText, sendKeys } = fixture(deliverMessage);
  await expect(transport.send(name, "hello")).resolves.toMatchObject({
    ok: false, sessionName: name, sent: false, reason: "proxied_delivery_failed", error: "bridge disconnected",
  });
  expect(sendText).not.toHaveBeenCalled();
  expect(sendKeys).not.toHaveBeenCalled();
});
