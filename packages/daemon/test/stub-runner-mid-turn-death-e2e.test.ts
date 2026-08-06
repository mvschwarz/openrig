import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STUB_MID_TURN_DEATH_EXIT_CODE } from "../src/adapters/stub-runner.js";
import type { StubScript } from "../src/adapters/stub-script.js";

// Slice 51-01 items 6-8 — mid_turn_death real-spawn observable: the WIRED runner really
// DIES mid-turn. Production-identical death signals (the reliable ones — activity POSTs
// are fire-and-forget and process.exit may truncate in-flight ones, which is FAITHFUL: a
// real death loses in-flight hooks): the process exits with the death code, the exited
// sidecar is recorded (synchronous, so the daemon never false-greens a stale ready), and
// Stop is NEVER sent (hooks ceased). The hermetic executor test proves the no-Stop /
// halt dispatch deterministically; this closes the in-memory-hides-real-spawn gap.

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const SEAT = "dev-worker@death-e2e";

describe("stub-runner mid_turn_death (real-spawn death)", () => {
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

  it("exits with the death code, records the exited sidecar, and NEVER sends Stop", async () => {
    dir = mkdtempSync(join(tmpdir(), "death-e2e-"));
    const home = join(dir, ".openrig");
    mkdirSync(join(dir, ".openrig", "stub"), { recursive: true });
    const script: StubScript = { steps: [{ kind: "emit", behavior: "mid_turn_death" }, { kind: "say", text: "unreachable" }] };
    writeFileSync(join(dir, ".openrig", "stub", "script.json"), JSON.stringify(script), "utf8");

    const events: string[] = [];
    server = createServer((req, res) => {
      let raw = ""; req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { events.push(String((JSON.parse(raw) as Record<string, unknown>).hookEvent)); } catch { /* ignore */ }
        res.writeHead(200); res.end("{}");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server!.address() as { port: number }).port;

    const exitCode = await new Promise<number | null>((resolvePromise) => {
      child = execFile("node", ["--import", "tsx", RUNNER,
        "--session-name", SEAT, "--cwd", dir, "--launch-id", "death-1", "--posture", "floor"],
        { env: { ...process.env, OPENRIG_HOME: home, OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "t" } as NodeJS.ProcessEnv });
      child.on("exit", (code) => resolvePromise(code));
    });

    // The process really died with the death code.
    expect(exitCode).toBe(STUB_MID_TURN_DEATH_EXIT_CODE);
    // The exited sidecar was recorded synchronously (daemon never false-greens a dead seat).
    const sidecar = JSON.parse(readFileSync(join(dir, ".openrig", "stub", "state.json"), "utf8"));
    expect(sidecar.ready).toBe(false);
    expect(sidecar.exited?.code).toBe(STUB_MID_TURN_DEATH_EXIT_CODE);
    // Hooks ceased: Stop was NEVER sent (grace already elapsed — the process has exited).
    await new Promise((r) => setTimeout(r, 200));
    expect(events).not.toContain("Stop");
  }, 30_000);
});
