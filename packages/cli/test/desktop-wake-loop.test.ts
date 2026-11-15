// The opt-in wake loop in the openrig-user skill, run exactly as shipped: extracted from the skill, executed by sh,
// calling the built `rig` CLI against the daemon's real queue routes over HTTP. It must wake on new owned work,
// survive failed polls, and end at its deadline.
import { describe, it, type TestContext } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type Database from "better-sqlite3";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";

const SKILL = new URL("../../daemon/assets/plugins/openrig-core/skills/openrig-user/SKILL.md", import.meta.url);
const CLI = new URL("../dist/bin-wrapper.js", import.meta.url);
const DESK = "desk@team";

/** The first `sh` block after the "Wake on new work" heading: the text agents are told to run. */
function shippedLoop(): string {
  const skill = fs.readFileSync(SKILL, "utf8");
  const section = skill.slice(skill.indexOf("#### Wake on new work"));
  const match = /```sh\n([\s\S]*?)```/.exec(section);
  if (!match) throw new Error("no sh block under 'Wake on new work' in the openrig-user skill");
  return match[1]!;
}

async function fixture(onTestFinished: TestContext["onTestFinished"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-loop-"));
  let db: Database.Database | undefined;
  let server: ServerType | undefined;
  onTestFinished(async () => {
    try {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    } finally {
      try { db?.close(); }
      finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  });
  fs.mkdirSync(path.join(root, "bin"));
  // The agent's `rig`: this checkout's built CLI.
  fs.writeFileSync(path.join(root, "bin", "rig"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(CLI))} "$@"\n`, { mode: 0o755 });
  db = createDb(":memory:");
  migrate(db, ALL_MIGRATIONS);
  const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  const inert = async () => ({ ok: false, error: "inert fixture" });
  const { app } = createTestApp(db, {
    appDeps: {
      sessionTransport: { resolveSessions: async () => ({ ok: false, code: "not_found", error: "inert fixture" }), send: inert, capture: inert, broadcast: inert } as never,
      queueRepo: queue,
    },
  });
  const state = { failLists: 0, failListsAfter: Infinity, listCalls: 0 };
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({
      fetch: (request: Request) => {
        if (new URL(request.url).pathname === "/api/queue/list") {
          state.listCalls++;
          if (state.failLists > 0 || state.listCalls > state.failListsAfter) {
            if (state.failLists > 0) state.failLists--;
            return new Response(JSON.stringify({ error: "fixture: daemon busy" }), { status: 503 });
          }
        }
        return app.fetch(request);
      },
      port: 0, hostname: "127.0.0.1",
    }, () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** Run the shipped loop as a background command would: its own process, this seat's identity, short timings. */
  function runLoop(max: number, seat: string | null = DESK) {
    const env: Record<string, string> = {
      PATH: `${path.join(root, "bin")}:/usr/bin:/bin`, HOME: root, OPENRIG_HOME: path.join(root, "openrig"),
      OPENRIG_URL: url, MAX: String(max), EVERY: "1",
    };
    if (seat) env.OPENRIG_SESSION_NAME = seat;
    const started = Date.now();
    return new Promise<{ code: number | null; stdout: string; seconds: number }>((resolve) => {
      const child = spawn("sh", ["-c", shippedLoop()], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.on("close", (code) => resolve({ code, stdout, seconds: (Date.now() - started) / 1000 }));
    });
  }

  const assign = (destination: string) => queue.create({
    sourceSession: "lead@team", destinationSession: destination, body: "Summarise the failing test.", nudge: false,
  } as never);
  return { runLoop, assign, queue, state };
}

describe.skipIf(process.platform === "win32").concurrent("the skill's opt-in wake loop", () => {
  it("has a built CLI to run the loop with", ({ expect }) => {
    // Not a silent skip: the loop runs against this checkout's built `rig`.
    expect(fs.existsSync(CLI), `build the CLI first (npm run build): ${fileURLToPath(CLI)} is missing`).toBe(true);
  });

  it("wakes with the new owned item once it is assigned", async ({ expect, onTestFinished }) => {
    const { runLoop, assign } = await fixture(onTestFinished);
    const waiting = runLoop(30);
    const timer = setTimeout(() => { assign(DESK); }, 2_000);
    onTestFinished(() => clearTimeout(timer));
    const result = await waiting;
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^NEW WORK: .*"qitemId"/m);
    expect(result.seconds).toBeLessThan(15);
  }, 40_000);

  it("keeps waiting through failed polls and wakes when the daemon answers again", async ({ expect, onTestFinished }) => {
    const { runLoop, assign, state } = await fixture(onTestFinished);
    assign(DESK);
    state.failLists = 3;
    const result = await runLoop(30);
    expect(result.code).toBe(0);
    expect(state.listCalls).toBeGreaterThanOrEqual(4);
    expect(result.stdout).toMatch(/^NEW WORK: /m);
  }, 40_000);

  it("doesn't wake for owned work that is already claimed", async ({ expect, onTestFinished }) => {
    const { runLoop, assign, queue } = await fixture(onTestFinished);
    const item = await assign(DESK);
    queue.claim({ qitemId: item.qitemId, destinationSession: DESK } as never);
    const result = await runLoop(4);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("NEW WORK");
    expect(result.stdout).toContain("No new work before the deadline");
  }, 40_000);

  it("says it couldn't check, and exits non-zero, when every poll failed", async ({ expect, onTestFinished }) => {
    const { runLoop, assign } = await fixture(onTestFinished);
    assign(DESK);
    const result = await runLoop(3, null); // no seat identity: every `rig queue list --owned` fails
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("NEW WORK");
    expect(result.stdout).not.toContain("No new work");
    expect(result.stdout).toContain("Couldn't check for work: every poll failed.");
  }, 40_000);

  it("reports when checking stopped working, and exits non-zero, after an early success and failures to the deadline", async ({ expect, onTestFinished }) => {
    const { runLoop, state } = await fixture(onTestFinished);
    state.failListsAfter = 1; // one empty successful poll, then the daemon stops answering
    const result = await runLoop(4);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("No new work");
    expect(result.stdout).toMatch(/Checking stopped working at \d{2}:\d{2}:\d{2}Z: every poll since then failed\./);
  }, 40_000);

  it("stays quiet when a failed poll is followed by a successful one", async ({ expect, onTestFinished }) => {
    const { runLoop, state } = await fixture(onTestFinished);
    state.failLists = 2; // two failures, then the daemon answers again (with no work)
    const result = await runLoop(4);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No new work before the deadline");
    expect(result.stdout).not.toContain("Checking stopped working");
  }, 40_000);

  it("ignores work assigned to another seat and ends at its deadline", async ({ expect, onTestFinished }) => {
    const { runLoop, assign } = await fixture(onTestFinished);
    assign("impl@team");
    const result = await runLoop(4);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("NEW WORK");
    expect(result.stdout).toContain("No new work before the deadline");
    // `date +%s` counts whole seconds, so the deadline lands up to a second early.
    expect(result.seconds).toBeGreaterThanOrEqual(3);
    expect(result.seconds).toBeLessThan(15);
  }, 40_000);
});
