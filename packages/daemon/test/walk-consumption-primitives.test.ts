// Mechanics-gate fix (desk BLOCKING ruling qitem-20260825153441-d9b3989a) — the two daemon
// primitives behind `rig walk`'s per-piece consumption verification:
//   1. SessionTransport submitOnly — the single bare-Enter retry for staged text, safe by
//      construction: the pane must show the EXPECTED staged content or the Enter is refused
//      (a bare Enter at a permission prompt would APPROVE it — the mismatch gate exists for
//      exactly that hazard).
//   2. GET /api/sessions/:sessionName/generation-record — the consumption-by-effect source:
//      current-generation identity + byte-addressed suffix via the ContextUsageStore sidecar,
//      refusing LOUD when no record resolves.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";
import { createFullTestDb } from "./helpers/test-app.js";

function mockTmux(overrides?: Partial<{
  hasSession: (name: string) => Promise<boolean>;
  sendText: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent: (paneId: string, lines?: number) => Promise<string | null>;
}>): TmuxAdapter {
  return {
    hasSession: overrides?.hasSession ?? (async () => true),
    sendText: overrides?.sendText ?? (async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? (async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? (async () => "idle\n❯ "),
    getPaneCommand: async () => null,
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    startPipePane: async () => ({ ok: true as const }),
    stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null,
  } as unknown as TmuxAdapter;
}

describe("SessionTransport submitOnly — the guarded bare-Enter retry", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let agentActivityStore: AgentActivityStore;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    agentActivityStore = new AgentActivityStore({ db, eventBus });
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-rig" });
  });
  afterEach(() => db.close());

  const makeTransport = (tmux: TmuxAdapter) =>
    new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, agentActivityStore, eventBus });

  const STAGED_PIECE = "# World from primitives\n\nThe seat learns the world by composing…";

  it("presses C-m exactly once, types NOTHING, when the pane shows the expected staged text", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendText, sendKeys,
      capturePaneContent: async () => `❯ ${STAGED_PIECE.slice(0, 50)}\n  paste again to expand`,
    }));
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE.slice(0, 200) });
    expect(res.ok).toBe(true);
    expect(res.submitOnly).toBe(true);
    expect(sendText).not.toHaveBeenCalled();                       // nothing typed — ever
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith("dev-impl@my-rig", ["C-m"]);
  });

  it("REFUSES (staged_mismatch) when the pane shows something else — a bare Enter at a permission prompt would approve it", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "Authorize the 0.4.0 release?\n\n❯ 1. Authorize publish → @latest (Recommended)\n  2. Roll back\n",
    }));
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();                       // the Enter never lands
  });

  it("accepts the TUI's pasted-text PLACEHOLDER as staged evidence — a large paste renders as [Pasted text #N +X lines], never its content", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "❯ [Pasted text #4 +112 lines]\n  paste again to expand",
    }));
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE, expectedStagedLineCount: 112 });
    expect(res.ok).toBe(true); // round-2: the placeholder counts ONLY with a matching line count
    expect(sendKeys).toHaveBeenCalledTimes(1);
  });

  // ROUND-2 (r2 R1 HIGH-1, row 66e74676): stale scrollback must never authorize the Enter. The
  // evidence must be the CURRENT ACTIVE INPUT and must identify THIS piece — a generic placeholder
  // anywhere in 50 lines is neither.
  it("R2 HIGH-1 discriminator — a stale pasted-text placeholder ABOVE a later interactive prompt refuses with ZERO Enter calls [GREEN — current-input binding]", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      // The reviewer's shape: an older placeholder in scrollback, then a LATER interactive
      // prompt occupying the current input. An Enter here approves the prompt.
      capturePaneContent: async () => "❯ [Pasted text #2 +112 lines]\nold output scrolled past\n\nAuthorize the next action?\n❯ 1. Continue\n  2. Cancel\n",
    }));
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE, expectedStagedLineCount: 112 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled(); // zero Enter calls — the forbidden effect never happens
  });

  it("R2 HIGH-1 — a placeholder whose line count does NOT match the expected piece is not piece identity: refused [GREEN — line-count qualification]", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "❯ [Pasted text #4 +112 lines]\n  paste again to expand",
    }));
    // The walked piece is 6 lines; the staged blob is 112 — someone else's paste.
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE, expectedStagedLineCount: 6 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("R2 HIGH-1 — MULTIPLE placeholders staged at the current input is coalesced staging: refused, never one Enter for several pieces [GREEN — multi-staging refusal]", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "❯ [Pasted text #3 +112 lines] [Pasted text #4 +112 lines]\n  paste again to expand",
    }));
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE, expectedStagedLineCount: 112 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // ROUND-3 (r2 R2 HIGH-1, row d95b2ea7): the identity relation must be true of Claude's ACTUAL
  // staged rendering, pinned from the PRESERVED Test-A specimen (t1-mechanics run, receipts
  // 54-direct-tmux-capture.txt + served-profile/02-permission-self-sleep.md), not invented:
  // one walked piece (8834 bytes, 142 split("\n") entries) renders as EIGHT placeholders
  // (+16,+15,+19,+15,+17,+15,+17,+16 — segment sizes, NOT source newlines; sum 130) followed by
  // the piece's own literal tail, wrapped across pane lines; placeholder tokens themselves wrap
  // across lines ("+19\n  lines]").
  const FIXTURES = join(import.meta.dirname ?? __dirname, "fixtures", "walk-staged-specimen");
  const PIECE_2 = () => readFileSync(join(FIXTURES, "piece-02-permission-self-sleep.md"), "utf8");
  const PANE_SINGLE = () => readFileSync(join(FIXTURES, "pane-single-piece-2.txt"), "utf8");
  const PANE_COALESCED = () => readFileSync(join(FIXTURES, "pane-coalesced-pieces-2-and-3.txt"), "utf8");

  it("R3 SPECIMEN — the preserved single-piece staged rendering (8 placeholders + literal tail) ACCEPTS and submits exactly once [GREEN — rendering-true identity]", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({ sendKeys, capturePaneContent: async () => PANE_SINGLE() }));
    const res = await transport.send("dev-impl@my-rig", "", {
      submitOnly: true,
      expectedStagedText: PIECE_2(),
      expectedStagedLineCount: PIECE_2().split("\n").length, // 142 — none of the displayed counts equals this
    });
    expect(res.ok).toBe(true);
    expect(sendKeys).toHaveBeenCalledTimes(1); // the guarded recovery submits THAT exact staged input once
  });

  it("R3 SPECIMEN GUARD — the preserved COALESCED region (pieces 2 AND 3 staged) refuses for piece 2 with zero Enter calls: submitting would coalesce two pieces into one message", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({ sendKeys, capturePaneContent: async () => PANE_COALESCED() }));
    const res = await transport.send("dev-impl@my-rig", "", {
      submitOnly: true,
      expectedStagedText: PIECE_2(),
      expectedStagedLineCount: PIECE_2().split("\n").length,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("REFUSES (invalid_submit_only) without expectedStagedText, and when text is supplied", async () => {
    const transport = makeTransport(mockTmux());
    const noExpected = await transport.send("dev-impl@my-rig", "", { submitOnly: true });
    expect(noExpected.ok).toBe(false);
    expect(noExpected.reason).toBe("invalid_submit_only");
    const withText = await transport.send("dev-impl@my-rig", "some text", { submitOnly: true, expectedStagedText: "some text" });
    expect(withText.ok).toBe(false);
    expect(withText.reason).toBe("invalid_submit_only");
  });
});

describe("GET /api/sessions/:sessionName/generation-record — the consumption-by-effect source", () => {
  let stateDir: string;
  let app: Hono;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "walk-genrec-"));
    const db = createFullTestDb();
    const store = new ContextUsageStore(db, { stateDir });
    app = new Hono();
    app.use("*", async (c, next) => { c.set("contextUsageStore" as never, store as never); await next(); });
    app.route("/api/sessions", sessionAdminRoutes);
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  const seedSidecar = (seat: string, generationId: string, jsonlContent: string): string => {
    const jsonl = join(stateDir, `${generationId}.jsonl`);
    writeFileSync(jsonl, jsonlContent);
    mkdirSync(join(stateDir, "context"), { recursive: true });
    writeFileSync(join(stateDir, "context", `${seat}.json`), JSON.stringify({
      session_id: generationId,
      session_name: seat,
      transcript_path: jsonl,
      context_window: { used_percentage: 10 },
    }));
    return jsonl;
  };

  it("serves identity + totalBytes without sinceBytes, and the BYTE-addressed suffix with it (multibyte-safe)", async () => {
    // The record deliberately carries multibyte characters BEFORE the suffix boundary: byte
    // addressing must stay consistent between totalBytes and the served slice.
    const early = '{"note":"…multibyte … ellipses…"}\n';
    const late = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"the walked piece"}]}}\n';
    seedSidecar("dev-x@r", "gen-abc", early + late);
    const idRes = await app.request(`/api/sessions/${encodeURIComponent("dev-x@r")}/generation-record`);
    expect(idRes.status).toBe(200);
    const id = await idRes.json() as { generationId: string; totalBytes: number; suffix?: string };
    expect(id.generationId).toBe("gen-abc");
    expect(id.totalBytes).toBe(Buffer.byteLength(early + late, "utf8"));
    expect(id.suffix).toBeUndefined();

    const since = Buffer.byteLength(early, "utf8");
    const sufRes = await app.request(`/api/sessions/${encodeURIComponent("dev-x@r")}/generation-record?sinceBytes=${since}`);
    expect(sufRes.status).toBe(200);
    const suf = await sufRes.json() as { suffix: string; truncated: boolean };
    expect(suf.suffix).toBe(late);
    expect(suf.truncated).toBe(false);
  });

  it("refuses LOUD (409 unsupported_runtime) when no sidecar record resolves — never an empty success", async () => {
    const res = await app.request(`/api/sessions/${encodeURIComponent("ghost@r")}/generation-record`);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("unsupported_runtime");
    expect(body.message).toContain("ghost@r");
  });

  // ROUND-2 (r2 R1 HIGH-2, row 66e74676): the raw generation-record read is a TERMINAL-CLASS
  // surface (raw conversation bytes, no transcript redaction) and must sit behind the same
  // bearer gate as its neighbors. 401 / 401 / 200 for missing / wrong / correct bearer; a
  // null-token (loopback) daemon passes through.
  it("R2 HIGH-2 — with a terminal bearer token configured: missing and wrong bearers are 401, the correct bearer is 200 [GREEN — terminalAuthGuard]", async () => {
    const stateDir2 = mkdtempSync(join(tmpdir(), "walk-genrec-auth-"));
    try {
      const db2 = createFullTestDb();
      const store2 = new ContextUsageStore(db2, { stateDir: stateDir2 });
      const authed = new Hono();
      authed.use("*", async (c, next) => {
        c.set("contextUsageStore" as never, store2 as never);
        c.set("terminalBearerToken" as never, "sekrit-token" as never);
        await next();
      });
      authed.route("/api/sessions", sessionAdminRoutes);
      const jsonl = join(stateDir2, "gen-z.jsonl");
      writeFileSync(jsonl, '{"x":1}\n');
      mkdirSync(join(stateDir2, "context"), { recursive: true });
      writeFileSync(join(stateDir2, "context", "dev-z@r.json"), JSON.stringify({ session_id: "gen-z", transcript_path: jsonl, context_window: { used_percentage: 5 } }));

      const url = `/api/sessions/${encodeURIComponent("dev-z@r")}/generation-record`;
      const missing = await authed.request(url);
      expect(missing.status).toBe(401);
      const wrong = await authed.request(url, { headers: { Authorization: "Bearer wrong" } });
      expect(wrong.status).toBe(401);
      const right = await authed.request(url, { headers: { Authorization: "Bearer sekrit-token" } });
      expect(right.status).toBe(200);
    } finally {
      rmSync(stateDir2, { recursive: true, force: true });
    }
  });

  it("null-token (loopback) daemon passes the generation-record read through — the existing no-auth tests are this mode", async () => {
    // The suite's other route tests run with no terminalBearerToken set and expect 200/409 —
    // that IS the null-token pass-through pin; this case just names the contract.
    const res = await app.request(`/api/sessions/${encodeURIComponent("nobody@r")}/generation-record`);
    expect([200, 409]).toContain(res.status);
  });

  it("refuses LOUD (409 record_unreadable) when the sidecar names a transcript that does not exist", async () => {
    seedSidecar("dev-y@r", "gen-y", "x\n");
    rmSync(join(stateDir, "gen-y.jsonl"));
    const res = await app.request(`/api/sessions/${encodeURIComponent("dev-y@r")}/generation-record`);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("record_unreadable");
  });
});
