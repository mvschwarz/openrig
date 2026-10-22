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
import Database from "better-sqlite3";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, appendFileSync, renameSync } from "node:fs";
import { Command } from "commander";
import { walkCommand } from "../../cli/src/commands/walk.js";
import { STATE_FILE } from "../../cli/src/daemon-lifecycle.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ProcessCensus } from "../src/domain/process-census.js";
import { CodexThreadIdResolver } from "../src/domain/codex-thread-id.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
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
    probeSession: async (name: string) =>
      (await (overrides?.hasSession ?? (async () => true))(name))
        ? { state: "present" as const }
        : { state: "absent" as const },
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

  it("presses Enter exactly once, types NOTHING, when the pane shows the expected staged text", async () => {
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
    expect(sendKeys).toHaveBeenCalledWith("dev-impl@my-rig", ["Enter"]);
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

  // Review round (mvschwarz on #635): the shared selection pattern requires a space after the
  // dot, but the staged-input checks always excluded the broad prefix. A compact option like
  // `1.Yes` must still refuse in both modes — zero Enter calls either way.
  it("REFUSES a compact numbered option in both modes — the space after the dot is not required", async () => {
    for (const requireFullStagedText of [false, true]) {
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const transport = makeTransport(mockTmux({
        sendKeys,
        capturePaneContent: async () => "Choose an option\n❯ 1.Yes\n────────────\nshift+tab to cycle\n",
      }));
      const res = await transport.send("dev-impl@my-rig", "", {
        submitOnly: true,
        expectedStagedText: "1.Yes",
        requireFullStagedText,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("staged_mismatch");
      expect(sendKeys).not.toHaveBeenCalled();
    }
  });

  // Review round 2 (mvschwarz on #635): with no runtime there is no way to say
  // which mixed-glyph line is the live composer. The union read must fail
  // closed exactly as the pre-shared-matcher check did, in both modes.
  it("unknown-runtime full-match refuses a mixed-glyph block with zero Enter calls", async () => {
    const rig = rigRepo.createRig("unknown-runtime-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@unknown-runtime-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@unknown-runtime-rig" });
    const separators: string[][] = [[], [""], ["────────────"]];
    for (const separator of separators) {
      for (const glyph of ["›", "»"]) {
        for (const requireFullStagedText of [false, true]) {
          const sendKeys = vi.fn(async () => ({ ok: true as const }));
          const transport = makeTransport(mockTmux({
            sendKeys,
            capturePaneContent: async () => [
              "❯ unrelated first line",
              ...separator,
              `${glyph} expected text`,
              "────────────",
              "shift+tab to cycle",
              "",
            ].join("\n"),
          }));
          const res = await transport.send("dev-impl@unknown-runtime-rig", "", {
            submitOnly: true,
            expectedStagedText: "expected text",
            requireFullStagedText,
          });
          expect(res.ok).toBe(false);
          expect(res.reason).toBe("staged_mismatch");
          expect(sendKeys).not.toHaveBeenCalled();
        }
      }
    }
  });

  it("a bare placeholder with a matching size but NO literal residual REFUSES — size similarity is not identity (round-4 contract; supersedes the R1/R2 acceptance)", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "❯ [Pasted text #4 +112 lines]\n  paste again to expand",
    }));
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE, expectedStagedLineCount: 112 });
    expect(res.ok).toBe(false); // round-4: no residual -> no identity -> fail closed
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
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

  // ROUND-4 (r2 R3 HIGH-1, row 7435d61b): size similarity and short shared phrases are NOT
  // identity. The rendering's own structure (proven on the preserved bytes: the literal residual
  // is the piece's normalized SUFFIX, 524 chars in the specimen) is the only acceptance anchor;
  // anything less fails closed.
  it("R4 PROBE-A — a bare unrelated placeholder with a plausible size (+100 of 142) REFUSES with zero Enter calls: no residual means no identity [GREEN — identity-free acceptance removed]", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "❯ [Pasted text #9 +100 lines]\n\n────────────────────────────────────────\n  ⏵⏵ accept edits on",
    }));
    const res = await transport.send("dev-impl@my-rig", "", {
      submitOnly: true,
      expectedStagedText: PIECE_2(),
      expectedStagedLineCount: PIECE_2().split("\n").length,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("R4 PROBE-B — an unrelated placeholder plus a short phrase that happens to occur in the piece REFUSES with zero Enter calls: a common substring cannot bless another input [GREEN — strong residual anchoring]", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "❯ [Pasted text #3 +12 lines]What are your options?\n\n────────────────────────────────────────\n  ⏵⏵ accept edits on",
    }));
    const res = await transport.send("dev-impl@my-rig", "", {
      submitOnly: true,
      expectedStagedText: PIECE_2(),
      expectedStagedLineCount: PIECE_2().split("\n").length,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // ROUND-5 (r2 R4 HIGH-1, row e039e8d1): the suffix anchor must be JOINED to the opaque
  // placeholder prefix. The preserved bytes prove the relation: the placeholder sum (130)
  // IDENTIFIES the hidden source boundary immediately before the visible suffix (the 524-char
  // residual begins after exactly 130 source newlines of the 142-entry piece). A sum that does
  // not match the boundary before the matched suffix is a truncated or wrong prefix — refuse.
  const pieceTail = () => PIECE_2().split("\n").slice(-3).join("\n"); // a TRUE suffix, 85 normalized chars; boundary = 139

  it("R5 — a +1 placeholder with the piece's EXACT literal suffix REFUSES with zero Enter calls: the sum does not match the hidden boundary [GREEN — sum-boundary join]", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => `❯ [Pasted text #5 +1 lines]${pieceTail()}\n\n────────────────────────────────────────\n  ⏵⏵ accept edits on`,
    }));
    const res = await transport.send("dev-impl@my-rig", "", {
      submitOnly: true, expectedStagedText: PIECE_2(), expectedStagedLineCount: PIECE_2().split("\n").length,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("R5 — a plausible +100 placeholder with the piece's EXACT literal suffix REFUSES with zero Enter calls: 100 is not the boundary either [GREEN — sum-boundary join]", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => `❯ [Pasted text #5 +100 lines]${pieceTail()}\n\n────────────────────────────────────────\n  ⏵⏵ accept edits on`,
    }));
    const res = await transport.send("dev-impl@my-rig", "", {
      submitOnly: true, expectedStagedText: PIECE_2(), expectedStagedLineCount: PIECE_2().split("\n").length,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // ROUND-6 (r2 R5, row 98a9a82c / artifact a7ff103e): the ±1 tolerance was unproven — BOTH
  // separately staged preserved pieces exhibit EXACT equality (piece 2: sum 130 = boundary 130;
  // piece 3: sum 82 = boundary 82). Exact equality is the contract.
  const submitTail = (count: number) => transportFor(count);
  function transportFor(count: number) {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => `❯ [Pasted text #5 +${count} lines]${PIECE_2().split("\n").slice(-3).join("\n")}\n\n────────────────────────────────────────\n  ⏵⏵ accept edits on`,
    }));
    return { transport, sendKeys };
  }
  const submitOpts = () => ({ submitOnly: true as const, expectedStagedText: PIECE_2(), expectedStagedLineCount: PIECE_2().split("\n").length });

  it("R6 — the exact boundary (+139) accepts once", async () => {
    const { transport, sendKeys } = submitTail(139);
    const res = await transport.send("dev-impl@my-rig", "", submitOpts());
    expect(res.ok).toBe(true);
    expect(sendKeys).toHaveBeenCalledTimes(1);
  });

  it("R6 — one under the boundary (+138) REFUSES with zero Enter calls [GREEN — exact equality]", async () => {
    const { transport, sendKeys } = submitTail(138);
    const res = await transport.send("dev-impl@my-rig", "", submitOpts());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("R6 — one over the boundary (+140) REFUSES with zero Enter calls [GREEN — exact equality]", async () => {
    const { transport, sendKeys } = submitTail(140);
    const res = await transport.send("dev-impl@my-rig", "", submitOpts());
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
  let db: Database.Database;
  let registry: SessionRegistry;
  const threadId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "walk-genrec-"));
    db = createFullTestDb();
    registry = new SessionRegistry(db);
    const store = new ContextUsageStore(db, { stateDir, codexHomeDir: stateDir });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("contextUsageStore" as never, store as never);
      c.set("sessionRegistry" as never, registry as never);
      c.set("tmuxAdapter" as never, { getPanePid: async () => 10 } as never);
      await next();
    });
    app.route("/api/sessions", sessionAdminRoutes);
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(stateDir, { recursive: true, force: true }); });

  function seedCodex(metaId = threadId) {
    const repo = new RigRepository(db);
    const rig = repo.createRig("codex-rig");
    const node = repo.addNode(rig.id, "dev.codex", { runtime: "codex" });
    const seat = "dev-codex@codex-rig";
    const session = registry.registerSession(node.id, seat);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: seat, tmuxPane: "%42" });
    new SeatIdentityStore(db).upsert({ nodeId: node.id, verdict: "verified", evidenceSource: "env", reason: null,
      evidence: { registeredPane: "%42", observedPid: 10, observedCommand: "codex", matchedLayer: 1 },
      sessionName: seat, observedAt: new Date().toISOString() } as never);
    vi.spyOn(ProcessCensus.prototype, "list").mockResolvedValue([
      { pid: 10, ppid: 1, command: "zsh" }, { pid: 20, ppid: 10, command: "codex", startedAt: "start" },
    ]);
    vi.spyOn(CodexThreadIdResolver.prototype, "resolve").mockResolvedValue(threadId);
    mkdirSync(join(stateDir, ".codex"));
    const nativeDb = new Database(join(stateDir, ".codex", "state_5.sqlite"));
    const record = join(stateDir, "rollout.jsonl");
    nativeDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    nativeDb.prepare("INSERT INTO threads VALUES (?, ?)").run(threadId, record);
    nativeDb.close();
    writeFileSync(record, JSON.stringify({ type: "session_meta", payload: { id: metaId } }) + "\n");
    return { node, record, url: `/api/sessions/${seat}/generation-record` };
  }

  it("Codex current bound thread resolves before its first token_count event", async () => {
    const { url } = seedCodex();
    const response = await app.request(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runtime: "codex", sessionId: threadId });
  });

  it("Codex refuses a wrong rollout identity instead of accepting the thread table pointer", async () => {
    const { url } = seedCodex("old-thread");
    const response = await app.request(url);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "record_identity_mismatch" });
  });

  it("Codex replacement at the same path changes generation identity", async () => {
    const { url, record } = seedCodex();
    const first = await (await app.request(url)).json();
    const replacement = record + ".next";
    writeFileSync(replacement, readFileSync(record));
    const { renameSync } = await import("node:fs");
    renameSync(replacement, record);
    const second = await (await app.request(url)).json();
    expect(first.generationId).toBeDefined();
    expect(second.generationId).not.toBe(first.generationId);
  });

  it("Codex refuses an identity observation from a retired occupant", async () => {
    const { node, url } = seedCodex();
    db.prepare("UPDATE seat_identity_verdicts SET observed_at = '2000-01-01T00:00:00Z' WHERE node_id = ?").run(node.id);
    const response = await app.request(url);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "record_identity_unverified" });
  });

  it("Codex refuses ambiguous native threads under one pane", async () => {
    const { url } = seedCodex();
    vi.mocked(ProcessCensus.prototype.list).mockResolvedValue([
      { pid: 10, ppid: 1, command: "zsh" },
      { pid: 20, ppid: 10, command: "codex", startedAt: "a" },
      { pid: 21, ppid: 10, command: "codex", startedAt: "b" },
    ]);
    vi.mocked(CodexThreadIdResolver.prototype.resolve).mockImplementation(async pid => pid === 20 ? threadId : "other-thread");
    const response = await app.request(url);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "record_identity_unverified", message: expect.stringContaining("multiple") });
  });

  it.each(["0.5", "-1", "NaN", "", "9007199254740992"])("refuses invalid byte offset %s", async offset => {
    seedSidecar("dev-offset@r", "gen-offset", "{}\n");
    expect((await app.request(`/api/sessions/dev-offset@r/generation-record?sinceBytes=${offset}`)).status).toBe(400);
  });

  it.each(["complete", "prefix", "old-file", "replaced-file", "changed-occupant", "wrong-turn", "missing-turn", "missing-file", "claude"])(
    "integrated CLI → route → native record: %s", async (scenario) => {
      const { record, node } = seedCodex();
      const piece = "Shared heading. ".repeat(8) + "The complete middle matters.\n".repeat(9) + "unique tail Ω";
      const seat = scenario === "claude" ? "dev-claude@r" : "dev-codex@codex-rig";
      const claudePath = scenario === "claude" ? seedSidecar(seat, "claude-gen", "") : null;
      const records = (text: string) => scenario === "claude" ? [
        { type: "user", uuid: "input", message: { role: "user", content: text } },
        { type: "assistant", uuid: "answer", parentUuid: "input", message: { role: "assistant", content: "done" } },
        { type: "system", subtype: "turn_duration", uuid: "closed", parentUuid: "answer" },
      ] : [
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
        { type: "turn_context", payload: { turn_id: "turn" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
        ...(scenario === "missing-turn" ? [] : [{ type: "event_msg", payload: { type: "task_complete", turn_id: scenario === "wrong-turn" ? "other" : "turn" } }]),
      ];
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const oldExit = process.exitCode;
      process.exitCode = undefined;
      let sends = 0;
      try {
        const command = new Command().addCommand(walkCommand({
          lifecycleDeps: {
            readFile: p => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 7777, db: "isolated", startedAt: new Date().toISOString() }) : null,
            exists: p => p === STATE_FILE, isProcessAlive: () => true,
            fetch: async () => ({ ok: true }),
          } as never,
          fileExists: () => true, readFile: () => piece,
          clientFactory: () => ({
            get: async (path: string) => {
              const response = await app.request(path);
              return { status: response.status, data: await response.json() };
            },
            post: async (path: string) => {
              if (path.endsWith("/capture")) return { status: 200, data: { content: "idle" } };
              sends++;
              const text = scenario === "prefix" ? piece.slice(0, 115) : piece;
              const suffix = records(text).map(r => JSON.stringify(r)).join("\n") + "\n";
              if (scenario === "missing-file") rmSync(record);
              else if (scenario === "replaced-file") {
                writeFileSync(record + ".next", readFileSync(record, "utf8") + suffix);
                renameSync(record + ".next", record);
              } else if (scenario === "changed-occupant") {
                registry.mintOccupantTenure(node.id, "handover", "new-native-id");
                appendFileSync(record, suffix);
              } else appendFileSync(scenario === "old-file" ? join(stateDir, "retired.jsonl") : claudePath ?? record, suffix);
              return { status: 200, data: { ok: true } };
            },
          }) as never,
          sleep: async () => {},
        }));
        await command.parseAsync(["node", "rig", "walk", seat, "--through", "piece.md", "--json", "--pace", "0ms",
          "--consume-timeout", "20ms", "--consume-poll", "1ms", "--turn-timeout", "20ms"]);
        const positive = scenario === "complete" || scenario === "claude";
        expect(process.exitCode).toBe(positive ? undefined : 1);
        expect(log.mock.calls.some(([line]) => String(line).includes('"consumptionVerified":true'))).toBe(positive);
        expect(sends).toBe(1);
      } finally { process.exitCode = oldExit; }
    },
  );

  const seedSidecar = (seat: string, generationId: string, jsonlContent: string): string => {
    const jsonl = join(stateDir, `${generationId}.jsonl`);
    writeFileSync(jsonl, jsonlContent);
    mkdirSync(join(stateDir, "state", "context-usage"), { recursive: true });
    writeFileSync(join(stateDir, "state", "context-usage", `${seat}.json`), JSON.stringify({
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
    const id = await idRes.json() as { generationId: string; sessionId: string; totalBytes: number; suffix?: string };
    expect(id.sessionId).toBe("gen-abc");
    expect(id.generationId).toEqual(expect.any(String));
    expect(id.totalBytes).toBe(Buffer.byteLength(early + late, "utf8"));
    expect(id.suffix).toBeUndefined();

    const since = Buffer.byteLength(early, "utf8");
    const sufRes = await app.request(`/api/sessions/${encodeURIComponent("dev-x@r")}/generation-record?sinceBytes=${since}`);
    expect(sufRes.status).toBe(200);
    const suf = await sufRes.json() as { generationId: string; suffix: string; truncated: boolean };
    expect(suf.generationId).toBe(id.generationId);
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
      mkdirSync(join(stateDir2, "state", "context-usage"), { recursive: true });
      writeFileSync(join(stateDir2, "state", "context-usage", "dev-z@r.json"), JSON.stringify({ session_id: "gen-z", transcript_path: jsonl, context_window: { used_percentage: 5 } }));

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
