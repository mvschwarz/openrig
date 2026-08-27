import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createProgram } from "../src/index.js";

// OPR.0.5.5.19 A7 — `rig parked [seat]` verb wiring. RED at base: no command answers
// "are we parked?" at all. The diagnosis itself is pinned daemon-side; these pins cover
// the verb, its JSON passthrough, and the unreachable-daemon honesty.

function stubParkedDaemon(payload: unknown): Promise<{ server: Server; url: string; urls: string[] }> {
  const urls: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url!, "http://x");
      urls.push(req.url!);
      if (!u.pathname.endsWith("/api/activity/parked")) { res.writeHead(404); res.end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, urls });
    });
  });
}

const SEAT_DIAG = {
  seatNodeId: "node-1",
  sessionName: "dev50-qa@v-openrig-build",
  parked: true,
  reason: "idle-at-prompt with 1 open obligation(s) — a turn ended without a handoff",
  activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null }, decidedBy: "window-sampling", confidence: "oracle" },
  obligations: {
    scope: "destination=dev50-qa@v-openrig-build state=pending,in-progress,blocked limit=500",
    openCount: 1,
    heldCount: 1,
    unhealthyHeldCount: 1,
    complete: true,
    limit: 500,
    items: [{ qitemId: "qitem-1", state: "pending", summary: "review" }],
    held: [{ qitemId: "qitem-held", state: "blocked", summary: "waiting", wake: null }],
  },
  confidence: { activity: "high", obligations: "complete" },
};

describe("rig parked (S19 A7)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let prevUrl: string | undefined;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log");
    errSpy = vi.spyOn(console, "error");
    prevUrl = process.env.OPENRIG_URL;
    process.exitCode = undefined;
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (prevUrl === undefined) delete process.env.OPENRIG_URL; else process.env.OPENRIG_URL = prevUrl;
    process.exitCode = undefined;
  });

  it("is wired via createProgram (at base NO command answers 'are we parked?')", () => {
    expect(createProgram().commands.find((c) => c.name() === "parked")).toBeDefined();
  });

  it("rig-level: renders the verdict and only the interesting seats", async () => {
    const { server, url } = await stubParkedDaemon({
      ok: true,
      rig: { parked: true, reason: "1 seat(s) parked: dev50-qa@v-openrig-build", seats: [SEAT_DIAG, { ...SEAT_DIAG, sessionName: "busy@rig", parked: false }] },
    });
    process.env.OPENRIG_URL = url;
    try {
      const p = createProgram();
      p.exitOverride();
      await p.parseAsync(["node", "rig", "parked"]);
      expect(process.exitCode).toBeUndefined();
      const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("rig: PARKED");
      expect(out).toContain("dev50-qa@v-openrig-build: PARKED");
      expect(out).toContain("qitem-1");
      expect(out).toContain("qitem-held");
      expect(out).toMatch(/watchdog id|timer|live blocker/i);
      expect(out).not.toContain("busy@rig:"); // not-parked seats stay quiet
    } finally {
      server.close();
    }
  });

  it("seat-level --json passes the full diagnosis through (both confidences visible)", async () => {
    const { server, url } = await stubParkedDaemon({ ok: true, seat: SEAT_DIAG });
    process.env.OPENRIG_URL = url;
    try {
      const p = createProgram();
      p.exitOverride();
      await p.parseAsync(["node", "rig", "parked", "node-1", "--json"]);
      const out = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as { seat: typeof SEAT_DIAG };
      expect(out.seat.confidence).toEqual({ activity: "high", obligations: "complete" });
      expect(out.seat.obligations.scope).toContain("destination=");
    } finally {
      server.close();
    }
  });

  it("Wave-O B2: the CLI carries the rig coordinate — --rig wins, else the shell's own seat identity", async () => {
    const { server, url, urls } = await stubParkedDaemon({ ok: true, rig: { parked: false, reason: "no seat is parked", seats: [], scope: { rig: "other-rig", resolvedFrom: "query-param" } } });
    process.env.OPENRIG_URL = url;
    const prevSession = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "dev50-driver@v-openrig-build";
    try {
      const p1 = createProgram();
      p1.exitOverride();
      await p1.parseAsync(["node", "rig", "parked"]);
      expect(urls.at(-1)).toContain("rig=v-openrig-build"); // derived from the seat identity
      const p2 = createProgram();
      p2.exitOverride();
      await p2.parseAsync(["node", "rig", "parked", "--rig", "other-rig"]);
      expect(urls.at(-1)).toContain("rig=other-rig"); // explicit flag wins
      const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("scope: rig other-rig (from query-param)"); // AM-3 scope rendered
    } finally {
      if (prevSession === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = prevSession;
      server.close();
    }
  });

  it("unreachable daemon refuses honestly — the diagnosis is live-derived, never cached", async () => {
    process.env.OPENRIG_URL = "http://127.0.0.1:9";
    const p = createProgram();
    p.exitOverride();
    try { await p.parseAsync(["node", "rig", "parked"]); } catch { /* exitCode path */ }
    expect(process.exitCode).toBe(1);
    const err = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toMatch(/reachable daemon/i);
  });
});
