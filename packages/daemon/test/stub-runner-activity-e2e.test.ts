import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Slice 51-01 items 6-8 — R2 real-spawn proof: the WIRED runner actually POSTs the
// canonical activity event set over the WIRE to /api/activity/hooks. The hermetic
// executor test proves the emission sequence; this closes the in-memory-hides-real-
// spawn gap — a mocked seam can't prove the real process resolves the endpoint from
// env, authenticates, and hits the real path. Uses a throwaway http sink (no full
// daemon needed to prove the transport contract).

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const SEAT = "dev-worker@activity-e2e";
const TOKEN = "test-activity-token-r2";
const INJECTED_ISO = "2021-06-06T06:06:06.000Z";

interface Captured { body: Record<string, unknown>; auth: string | undefined; url: string | undefined }

async function waitFor(pred: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("stub-runner activity POST (real-spawn wire proof, R2)", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  let server: Server | undefined;
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("POSTs SessionStart → UserPromptSubmit → Stop with runtime=stub + Bearer auth to /api/activity/hooks", async () => {
    dir = mkdtempSync(join(tmpdir(), "stub-activity-e2e-"));
    const captured: Captured[] = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { captured.push({ body: JSON.parse(raw), auth: req.headers.authorization, url: req.url }); }
        catch { /* ignore non-JSON */ }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server!.address() as { port: number }).port;

    // No script.json → the DEFAULT say-only script (one turn, no compaction) — the
    // turn still frames UserPromptSubmit … Stop, so all three lifecycle events fire.
    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", SEAT, "--cwd", dir, "--launch-id", "act-1", "--posture", "floor"],
      { env: {
        ...process.env,
        OPENRIG_HOME: join(dir, ".openrig"),
        OPENRIG_URL: `http://127.0.0.1:${port}`,
        OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN,
        OPENRIG_NODE_ID: "node-xyz",
        OPENRIG_TEST_CLOCK_NOW: INJECTED_ISO,
      } as NodeJS.ProcessEnv });

    const events = () => captured.map((c) => String(c.body.hookEvent));
    await waitFor(() => events().includes("SessionStart") && events().includes("UserPromptSubmit") && events().includes("Stop"));

    // Every POST hit the canonical path, authenticated, runtime-tagged, seat-keyed.
    for (const c of captured) {
      expect(c.url).toBe("/api/activity/hooks");
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      expect(c.body.runtime).toBe("stub");
      expect(c.body.sessionName).toBe(SEAT);
      expect(c.body.nodeId).toBe("node-xyz");
      expect(c.body.occurredAt).toBe(INJECTED_ISO);
    }
    // Turn ordering: SessionStart precedes the turn's UserPromptSubmit, which precedes Stop.
    expect(events().indexOf("SessionStart")).toBeLessThan(events().indexOf("UserPromptSubmit"));
    expect(events().indexOf("UserPromptSubmit")).toBeLessThan(events().indexOf("Stop"));
  }, 30_000);
});
