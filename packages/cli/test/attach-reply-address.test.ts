// Real Commander commands, DaemonClient, loopback HTTP, daemon routes and SQLite.
// Only the person's tmux metadata and pane effects are inert.
import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { attachCommand } from "../src/commands/attach.js";
import { sendCommand } from "../src/commands/send.js";
import { whoamiCommand } from "../src/commands/whoami.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { RigRepository } from "../../daemon/src/domain/rig-repository.js";
import { PodRepository } from "../../daemon/src/domain/pod-repository.js";
import { SessionRegistry } from "../../daemon/src/domain/session-registry.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { SelfAttachService } from "../../daemon/src/domain/self-attach-service.js";
import { SessionTransport } from "../../daemon/src/domain/session-transport.js";
import { WhoamiService } from "../../daemon/src/domain/whoami-service.js";
import { TranscriptStore } from "../../daemon/src/domain/transcript-store.js";
import { rigsRoutes } from "../../daemon/src/routes/rigs.js";
import { transportRoutes } from "../../daemon/src/routes/transport.js";
import { whoamiRoutes } from "../../daemon/src/routes/whoami.js";
import type { TmuxAdapter } from "../../daemon/src/adapters/tmux.js";

vi.mock("node:child_process", async (actual) => ({ ...await actual<typeof import("node:child_process")>(), execSync: (cmd: string) => {
  if (!cmd.startsWith("tmux display-message ")) throw new Error(`Unexpected shell command in inert fixture: ${cmd}`);
  return `${process.env.TEST_PHYSICAL_SESSION}\n@12\n%42\n`;
} }));

it.each(["0", "person-terminal"])("real attach -> returned env -> actual From -> reply to original %s pane", async (physical) => {
  const home = mkdtempSync(join(tmpdir(), "attach-address-cli-"));
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  const rigs = new RigRepository(db), pods = new PodRepository(db), sessions = new SessionRegistry(db), bus = new EventBus(db);
  const rig = rigs.createRig("sample-team"), person = rigs.addNode(rig.id, "person.agent", { runtime: "terminal" });
  const operator = rigs.addNode(rig.id, "operator.agent", { runtime: "terminal" });
  sessions.updateBinding(operator.id, { tmuxSession: "operator-physical", tmuxPane: "%43" }); sessions.registerClaimedSession(operator.id, "operator-physical");
  const writes: Array<{ target: string; pane: string; text: string }> = [];
  const tmux = { hasSession: async () => true, probeSession: async () => ({ state: "present" }),
    capturePaneContent: async () => "plain terminal", getPaneCommand: async () => "sh",
    sendText: async (target: string, text: string) => { writes.push({ target, pane: target === physical ? "%42" : "%43", text }); return { ok: true }; },
    sendKeys: async () => ({ ok: true }),
  } as unknown as TmuxAdapter;
  const attach = new SelfAttachService({ db, rigRepo: rigs, podRepo: pods, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux });
  const transport = new SessionTransport({ db, rigRepo: rigs, sessionRegistry: sessions, tmuxAdapter: tmux });
  const whoami = new WhoamiService({ db, rigRepo: rigs, sessionRegistry: sessions, transcriptStore: new TranscriptStore({ transcriptsRoot: join(home, "transcripts"), enabled: false }) });
  const app = new Hono(); app.use("*", async (c, next) => {
    c.set("selfAttachService" as never, attach); c.set("sessionTransport" as never, transport); c.set("whoamiService" as never, whoami); await next();
  });
  app.get("/healthz", c => c.json({ ok: true }));
  app.route("/api/rigs", rigsRoutes); app.route("/api/transport", transportRoutes()); app.route("/api/whoami", whoamiRoutes());
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture port");
  const url = `http://127.0.0.1:${address.port}`;
  const lifecycleDeps = { spawn: vi.fn(), fetch: async () => ({ ok: true }), kill: vi.fn(),
    readFile: (p: string) => p === STATE_FILE ? JSON.stringify({ pid: process.pid, port: address.port, db: "fixture", startedAt: "2026-10-20T00:00:00Z" }) : null,
    exists: (p: string) => p === STATE_FILE, writeFile: vi.fn(), removeFile: vi.fn(), mkdirp: vi.fn(), openForAppend: () => 3, isProcessAlive: () => true,
  } as LifecycleDeps;
  const deps = { lifecycleDeps, clientFactory: () => new DaemonClient(url) };
  const previousExit = process.exitCode;
  const run = async (command: Command, args: string[]) => {
    const logs: string[] = [], diagnostics: string[] = [], capture = vi.spyOn(console, "log").mockImplementation((...parts) => { logs.push(parts.join(" ")); });
    const errors = vi.spyOn(console, "error").mockImplementation((...parts) => { diagnostics.push(parts.join(" ")); });
    process.exitCode = undefined;
    try { await new Command().addCommand(command).parseAsync(["node", "rig", ...args]); expect(process.exitCode).toBeUndefined(); return logs.join("\n"); }
    finally { capture.mockRestore(); errors.mockRestore(); if (diagnostics.length) console.error(diagnostics.join("\n")); }
  };
  try {
    vi.stubEnv("OPENRIG_HOME", home); vi.stubEnv("OPENRIG_URL", url); vi.stubEnv("TMUX_PANE", "%42"); vi.stubEnv("TEST_PHYSICAL_SESSION", physical);
    const attached = JSON.parse(await run(attachCommand(deps), ["attach", "--self", "--rig", rig.id, "--node", person.logicalId, "--display-name", "Taylor", "--json"]));
    expect(attached).toMatchObject({ sessionName: physical, senderAddress: "person-agent@sample-team", env: { OPENRIG_SESSION_NAME: "person-agent@sample-team" } });
    vi.stubEnv("OPENRIG_SESSION_NAME", attached.env.OPENRIG_SESSION_NAME); vi.stubEnv("OPENRIG_NODE_ID", attached.nodeId);
    const identity = JSON.parse(await run(whoamiCommand(deps), ["whoami", "--json"]));
    expect(identity.identity).toMatchObject({ sessionName: physical, senderAddress: attached.senderAddress });
    expect(Buffer.byteLength(JSON.stringify(identity))).toBeLessThan(6000);
    await run(sendCommand(deps), ["send", "operator-agent@sample-team", "Hello from the attached person.", "--json"]);
    const outbound = writes[0]!;
    expect(outbound.target).toBe("operator-physical");
    const from = outbound.text.split("\n")[0]!.slice("From: ".length);
    expect(from).toBe(attached.senderAddress);
    expect(outbound.text).toContain(`rig send ${from}`);
    vi.stubEnv("OPENRIG_SESSION_NAME", "operator-agent@sample-team"); vi.stubEnv("OPENRIG_NODE_ID", operator.id);
    await run(sendCommand(deps), ["send", from, "A reply to the actual From address.", "--json"]);
    expect(writes[1]).toMatchObject({ target: physical, pane: "%42" });
    expect(writes[1]?.text).toContain("A reply to the actual From address.");
    expect(sessions.getBindingForNode(person.id)?.tmuxSession).toBe(physical);
    expect(sessions.getSessionsForRig(rig.id).filter(s => s.nodeId === person.id).map(s => s.sessionName)).toEqual([physical]);
    expect(rigs.getRig(rig.id)?.nodes.find(n => n.id === person.id)?.label).toBe("Taylor");
  } finally {
    vi.unstubAllEnvs(); process.exitCode = previousExit; server.closeAllConnections?.(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(home, { recursive: true, force: true });
  }
});
