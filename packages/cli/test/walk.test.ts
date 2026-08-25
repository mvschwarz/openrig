// Slice-03 Atom 6 (rig walk) — the pacing primitive. Drives the CLI command with
// an injected client (records /api/transport/send posts) + an injected sleep
// (records inter-piece delays), so the paced push-sequence is asserted without a
// real pane or real time.

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { walkCommand, parsePaceMs, type WalkDeps } from "../src/commands/walk.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) =>
      p === STATE_FILE
        ? JSON.stringify({ pid: 123, port: 7777, db: "test.sqlite", startedAt: "2026-05-04T00:00:00Z" } as DaemonState)
        : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

interface RecordedSend { path: string; body: Record<string, unknown> }

function testDeps(sends: RecordedSend[], sleeps: number[], sendStatus = 200): WalkDeps {
  return {
    lifecycleDeps: mockLifecycleDeps(),
    clientFactory: () => ({
      post: async (path: string, body: unknown) => {
        sends.push({ path, body: body as Record<string, unknown> });
        return { status: sendStatus, data: sendStatus >= 400 ? { error: "Session not found" } : { verified: true } };
      },
    }) as never,
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
}

function makeCmd(deps: WalkDeps): Command {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(walkCommand(deps));
  return prog;
}

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "walk-piece-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = []; const errLogs: string[] = [];
    const origLog = console.log; const origErr = console.error; const origExit = process.exitCode;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };
    process.exitCode = undefined;
    try { await fn(); } catch { /* commander exitOverride */ }
    const exitCode = process.exitCode;
    console.log = origLog; console.error = origErr; process.exitCode = origExit;
    resolve({ logs, errLogs, exitCode });
  });
}

describe("parsePaceMs", () => {
  it("parses s / ms / bare-seconds and the default", () => {
    expect(parsePaceMs(undefined)).toBe(10_000);
    expect(parsePaceMs("10s")).toBe(10_000);
    expect(parsePaceMs("500ms")).toBe(500);
    expect(parsePaceMs("2")).toBe(2_000);
    expect(parsePaceMs("bogus")).toBeNull();
    expect(parsePaceMs("-1")).toBeNull();
  });
});

describe("rig walk — paced push-delivery (Atom 6)", () => {
  it("walks a seat through a local file list in order, one send per piece", async () => {
    const sends: RecordedSend[] = []; const sleeps: number[] = [];
    const a = tmpFile("a.md", "AAA"); const b = tmpFile("b.md", "BBB"); const c = tmpFile("c.md", "CCC");
    const { exitCode } = await captureLogs(async () => {
      await makeCmd(testDeps(sends, sleeps)).parseAsync(["node", "rig", "walk", "dev@rig", "--through", a, b, c, "--pace", "10s"]);
    });
    expect(exitCode).toBeUndefined();
    expect(sends).toHaveLength(3);
    expect(sends.every((s) => s.path === "/api/transport/send")).toBe(true);
    expect(sends.every((s) => s.body["session"] === "dev@rig")).toBe(true);
    expect(sends.map((s) => s.body["text"])).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("paces BETWEEN pieces only (N-1 delays for N pieces, at the parsed interval)", async () => {
    const sends: RecordedSend[] = []; const sleeps: number[] = [];
    const a = tmpFile("a.md", "AAA"); const b = tmpFile("b.md", "BBB"); const c = tmpFile("c.md", "CCC");
    await captureLogs(async () => {
      await makeCmd(testDeps(sends, sleeps)).parseAsync(["node", "rig", "walk", "dev@rig", "--through", a, b, c, "--pace", "500ms"]);
    });
    // 3 pieces → 2 inter-piece pauses; never a trailing pause after the last.
    expect(sleeps).toEqual([500, 500]);
  });

  it("aborts the walk when a piece fails to send (does not keep pacing into a broken pane)", async () => {
    const sends: RecordedSend[] = []; const sleeps: number[] = [];
    const a = tmpFile("a.md", "AAA"); const b = tmpFile("b.md", "BBB");
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd(testDeps(sends, sleeps, 502)).parseAsync(["node", "rig", "walk", "dev@rig", "--through", a, b, "--pace", "10s"]);
    });
    expect(exitCode).toBe(1);
    expect(sends).toHaveLength(1); // stopped after the first failure
    expect(sleeps).toEqual([]); // no pacing past the failure
    expect(errLogs.join("\n")).toMatch(/Session not found|failed/i);
  });

  it("rejects a malformed --pace before sending anything", async () => {
    const sends: RecordedSend[] = []; const sleeps: number[] = [];
    const a = tmpFile("a.md", "AAA");
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd(testDeps(sends, sleeps)).parseAsync(["node", "rig", "walk", "dev@rig", "--through", a, "--pace", "soon"]);
    });
    expect(exitCode).toBe(1);
    expect(sends).toEqual([]);
    expect(errLogs.join("\n")).toMatch(/pace/i);
  });

  it("walks a seat through a REF's ordered pieces (resolved via the daemon by-ref/pieces route)", async () => {
    const sends: RecordedSend[] = []; const sleeps: number[] = []; const gets: string[] = [];
    const deps: WalkDeps = {
      lifecycleDeps: mockLifecycleDeps(),
      // A non-file --through arg is a context ref → resolved via the daemon.
      fileExists: () => false,
      clientFactory: () => ({
        get: async (path: string) => {
          gets.push(path);
          return { status: 200, data: { ref: "packs/onboarding", pieces: [
            { path: "intro.md", content: "INTRO" },
            { path: "steps.md", content: "STEPS" },
          ] } };
        },
        post: async (path: string, body: unknown) => { sends.push({ path, body: body as Record<string, unknown> }); return { status: 200, data: {} }; },
      }) as never,
      sleep: async (ms: number) => { sleeps.push(ms); },
    };
    const { exitCode } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "walk", "dev@rig", "--through", "packs/onboarding", "--pace", "10s"]);
    });
    expect(exitCode).toBeUndefined();
    expect(gets.some((g) => g.includes("/api/context-packs/library/by-ref/pieces?ref=") && g.includes(encodeURIComponent("packs/onboarding")))).toBe(true);
    expect(sends.map((s) => s.body["text"])).toEqual(["INTRO", "STEPS"]);
    expect(sleeps).toEqual([10_000]);
  });

  it("aborts a ref walk BEFORE any send when the pack has a missing/unreadable member (twin of the local-file abort contract)", async () => {
    const sends: RecordedSend[] = []; const sleeps: number[] = [];
    const deps: WalkDeps = {
      lifecycleDeps: mockLifecycleDeps(),
      fileExists: () => false,
      clientFactory: () => ({
        get: async () => ({ status: 200, data: {
          ref: "packs/broken",
          pieces: [{ path: "present.md", content: "PRESENT" }],
          missingFiles: [{ path: "gone.md", role: "proof" }],
        } }),
        post: async (path: string, body: unknown) => { sends.push({ path, body: body as Record<string, unknown> }); return { status: 200, data: {} }; },
      }) as never,
      sleep: async (ms: number) => { sleeps.push(ms); },
    };
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "walk", "dev@rig", "--through", "packs/broken", "--pace", "10s"]);
    });
    expect(exitCode).toBe(1);
    expect(sends).toEqual([]); // ZERO pieces sent — no partial walk
    expect(sleeps).toEqual([]);
    expect(errLogs.join("\n")).toMatch(/gone\.md/); // names the missing member
    expect(errLogs.join("\n")).toMatch(/missing|incomplete|partial/i);
  });
});

// Mechanics-gate fix (desk BLOCKING ruling qitem-20260825153441-d9b3989a): walk gains PER-PIECE
// CONSUMPTION VERIFICATION BY EFFECT — send success means TYPED, not CONSUMED. The effect source is
// the seat's current-generation record (GET /api/sessions/:session/generation-record); on
// staged-text-detected exactly ONE submit retry (a bare Enter via submitOnly), then fail loud naming
// the piece; a client timeout with server-side completion reconciles BY EFFECT, never a re-send.
describe("rig walk — per-piece consumption verification (RED-first, mechanics-gate fix)", () => {
  const userRec = (text: string) =>
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

  interface ScriptedWorld {
    /** mutable: what the generation record currently holds (suffix after piece sends). */
    record: { generationId: string; content: string };
    /** mutable: what a pane capture currently renders. */
    pane: string;
    sends: RecordedSend[];
    gets: string[];
    /** post behavior override per call index for /api/transport/send. */
    sendBehavior?: (body: Record<string, unknown>, sendIndex: number) => { status: number; data: Record<string, unknown> } | "throw";
  }

  function consumptionDeps(w: ScriptedWorld): WalkDeps {
    let sendIndex = 0;
    return {
      lifecycleDeps: mockLifecycleDeps(),
      fileExists: () => false,
      clientFactory: () => ({
        get: async (path: string) => {
          w.gets.push(path);
          if (path.includes("/generation-record")) {
            const m = /sinceBytes=(\d+)/.exec(path);
            const since = m ? Number(m[1]) : undefined;
            // BYTE-consistent like the real route (stat + readSync are both bytes): a char-sliced
            // suffix desyncs from totalBytes the moment the record carries multibyte characters.
            const buf = Buffer.from(w.record.content, "utf8");
            return { status: 200, data: {
              generationId: w.record.generationId,
              totalBytes: buf.length,
              ...(since === undefined ? {} : { suffix: buf.subarray(since).toString("utf8") }),
            } };
          }
          if (path.includes("/by-ref/pieces")) {
            return { status: 200, data: { ref: "packs/p", pieces: [
              { path: "one.md", content: "PIECE ONE body text that is distinctive" },
              { path: "two.md", content: "PIECE TWO body text equally distinctive" },
            ] } };
          }
          return { status: 404, data: {} };
        },
        post: async (path: string, body: unknown) => {
          const b = body as Record<string, unknown>;
          w.sends.push({ path, body: b });
          if (path === "/api/transport/capture") return { status: 200, data: { ok: true, content: w.pane } };
          if (path === "/api/transport/send") {
            const behavior = w.sendBehavior?.(b, sendIndex++);
            if (behavior === "throw") throw new Error("Request to daemon timed out after 5000ms");
            if (behavior) return behavior;
            return { status: 200, data: { ok: true } };
          }
          return { status: 404, data: {} };
        },
      }) as never,
      sleep: async () => {},
    };
  }

  const walkArgs = ["node", "rig", "walk", "dev@rig", "--through", "packs/p", "--pace", "1ms",
    "--consume-timeout", "60ms", "--consume-poll", "1ms"];
  const pacingArgs = [...walkArgs, "--turn-timeout", "80ms"];
  const closureRec = '{"type":"system","subtype":"turn_duration","isMeta":false}';

  it("PIN W1 — a typed-but-never-consumed piece FAILS LOUD naming the piece; the next piece is never sent [GREEN — consumption verification]", async () => {
    const w: ScriptedWorld = { record: { generationId: "g1", content: "" }, pane: "", sends: [], gets: [] };
    // send reports ok but the generation record NEVER shows the piece (the coalesced-staged defect).
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd(consumptionDeps(w)).parseAsync(walkArgs);
    });
    expect(exitCode).toBe(1);
    const pieceSends = w.sends.filter((s) => s.path === "/api/transport/send" && s.body["text"] !== undefined);
    expect(pieceSends).toHaveLength(1);                       // piece 2 never sent
    expect(errLogs.join("\n")).toMatch(/piece 1\/2/);         // names the piece
    expect(errLogs.join("\n")).toMatch(/consum/i);            // names the failure class
  });

  it("PIN W2 — staged text detected -> exactly ONE submit retry (bare Enter, never a piece re-send), then consumed -> walk proceeds [GREEN — the retry path]", async () => {
    const w: ScriptedWorld = { record: { generationId: "g1", content: "" }, pane: "", sends: [], gets: [] };
    w.sendBehavior = (b) => {
      if (b["text"] !== undefined) {
        // The paste stages but the TUI does not accept the Enter: pane shows the piece, record silent.
        w.pane = `❯ ${String(b["text"]).slice(0, 40)}\n  paste again to expand`;
        return { status: 200, data: { ok: true } };
      }
      // The bare-Enter retry (submitOnly): the TUI accepts it — the piece lands in the record.
      const staged = /❯ (.+)\n/.exec(w.pane)?.[1] ?? "";
      w.record.content += userRec(staged + " …full piece body…") + "\n";
      w.pane = "❯ \n";
      return { status: 200, data: { ok: true, submitOnly: true } };
    };
    // Both pieces stage-then-consume via one retry each.
    const { exitCode } = await captureLogs(async () => {
      await makeCmd(consumptionDeps(w)).parseAsync(walkArgs);
    });
    expect(exitCode).toBeUndefined();
    const pieceSends = w.sends.filter((s) => s.path === "/api/transport/send" && s.body["text"] !== undefined);
    const enterRetries = w.sends.filter((s) => s.path === "/api/transport/send" && s.body["submitOnly"] === true);
    expect(pieceSends.map((s) => (s.body["text"] as string).slice(0, 9))).toEqual(["PIECE ONE", "PIECE TWO"]); // each piece sent ONCE
    expect(enterRetries).toHaveLength(2); // exactly one Enter per staged piece
  });

  it("PIN W3 — a client timeout with server-side completion reconciles BY EFFECT: no re-send, walk proceeds [GREEN — reconcile-by-effect]", async () => {
    const w: ScriptedWorld = { record: { generationId: "g1", content: "" }, pane: "", sends: [], gets: [] };
    w.sendBehavior = (b) => {
      if (b["text"] !== undefined) {
        // Server completed the send+submit; the client never saw the response.
        w.record.content += userRec(String(b["text"])) + "\n";
        return "throw";
      }
      return { status: 200, data: { ok: true } };
    };
    const { exitCode } = await captureLogs(async () => {
      await makeCmd(consumptionDeps(w)).parseAsync(walkArgs);
    });
    expect(exitCode).toBeUndefined(); // both pieces reconciled by effect
    const pieceSends = w.sends.filter((s) => s.path === "/api/transport/send" && s.body["text"] !== undefined);
    expect(pieceSends).toHaveLength(2); // one transport attempt per piece — never a blind re-send
  });

  it("PIN W4 — no generation record for the seat -> pieces still deliver, with a NAMED per-walk advisory that consumption is unverified [GREEN — the advisory]", async () => {
    const w: ScriptedWorld = { record: { generationId: "g1", content: "" }, pane: "", sends: [], gets: [] };
    const deps = consumptionDeps(w);
    const inner = (deps.clientFactory as unknown as () => { get: (p: string) => Promise<unknown>; post: (p: string, b: unknown) => Promise<unknown> })();
    (deps as { clientFactory: unknown }).clientFactory = () => ({
      get: async (path: string) => path.includes("/generation-record")
        ? { status: 409, data: { error: "unsupported_runtime", message: "no generation record for this seat" } }
        : inner.get(path),
      post: async (path: string, body: unknown) => inner.post(path, body),
    });
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(walkArgs);
    });
    expect(exitCode).toBeUndefined();
    const pieceSends = w.sends.filter((s) => s.path === "/api/transport/send" && s.body["text"] !== undefined);
    expect(pieceSends).toHaveLength(2); // legacy delivery preserved
    expect(errLogs.join("\n")).toMatch(/consumption unverified/i); // named, never silent
  });

  // ROUND-2 (r2 R1 HIGH-2, row 66e74676, CLI half): on a token-configured daemon the verified
  // path must WORK — every walk transport/record call carries the terminal auth headers (the
  // same chokepoint `rig capture` uses), instead of silently degrading or 401ing.
  // TURN-PACING (desk BLOCKING row 2ff16fa1): a piece sent while the seat is still PROCESSING the
  // prior piece's turn gets QUEUED by the runtime (enqueue/attachment) and never becomes a distinct
  // user turn — consumption verification cannot save it. Walk must WAIT for the prior turn's
  // CLOSURE (the system/turn_duration record, the capture atom's boundary) before the next send.
  it.fails("PACING-A — piece 2 is NEVER sent while piece 1's turn is open; closure-wait timeout fails loud naming the piece [RED until the turn gate]", async () => {
    const w: ScriptedWorld = { record: { generationId: "g1", content: "" }, pane: "", sends: [], gets: [] };
    // Piece 1 consumes as a distinct user turn but the turn NEVER closes (no turn_duration).
    w.sendBehavior = (b) => {
      if (b["text"] !== undefined) { w.record.content += userRec(String(b["text"])) + "\n"; return { status: 200, data: { ok: true } }; }
      return { status: 200, data: { ok: true } };
    };
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd(consumptionDeps(w)).parseAsync(pacingArgs);
    });
    expect(exitCode).toBe(1);
    const pieceSends = w.sends.filter((s) => s.path === "/api/transport/send" && s.body["text"] !== undefined);
    expect(pieceSends).toHaveLength(1);                    // piece 2 never sent into an open turn
    expect(errLogs.join("\n")).toMatch(/piece 1\/2/);      // names the piece
    expect(errLogs.join("\n")).toMatch(/turn/i);           // names the failure class (closure wait)
  });

  it.fails("PACING-B — piece 2 goes only AFTER piece 1's turn closure is visible in the record [RED until the turn gate]", async () => {
    const w: ScriptedWorld = { record: { generationId: "g1", content: "" }, pane: "", sends: [], gets: [] };
    let closureServedBeforePiece2 = false;
    let piece1Consumed = false;
    w.sendBehavior = (b) => {
      if (b["text"] !== undefined) {
        if (!piece1Consumed) {
          piece1Consumed = true;
          w.record.content += userRec(String(b["text"])) + "\n";
          // The turn closes THREE reads later (assistant work then turn_duration) — the reader
          // below appends it lazily; here we only record the send.
        } else {
          closureServedBeforePiece2 = w.record.content.includes("turn_duration");
          w.record.content += userRec(String(b["text"])) + "\n" + closureRec + "\n";
        }
        return { status: 200, data: { ok: true } };
      }
      return { status: 200, data: { ok: true } };
    };
    // Lazy closure: after piece 1's user record exists, the next generation-record read appends
    // the assistant turn + closure (the seat finished reading the piece).
    const baseDeps = consumptionDeps(w);
    const inner = (baseDeps.clientFactory as unknown as () => { get: (p: string) => Promise<unknown>; post: (p: string, b: unknown) => Promise<unknown> })();
    (baseDeps as { clientFactory: unknown }).clientFactory = () => ({
      get: async (path: string) => {
        const out = await inner.get(path);
        if (piece1Consumed && !w.record.content.includes("turn_duration")) {
          w.record.content += closureRec + "\n";
        }
        return out;
      },
      post: async (path: string, body: unknown) => inner.post(path, body),
    });
    const { exitCode } = await captureLogs(async () => {
      await makeCmd(baseDeps).parseAsync(pacingArgs);
    });
    expect(exitCode).toBeUndefined();
    const pieceSends = w.sends.filter((s) => s.path === "/api/transport/send" && s.body["text"] !== undefined);
    expect(pieceSends).toHaveLength(2);
    expect(closureServedBeforePiece2).toBe(true); // the gate held: closure BEFORE the second send
  });

  it("R2 HIGH-2 CLI — every generation-record read and transport send/capture carries the terminal auth headers option [GREEN — walk passes terminalAuthHeaders]", async () => {
    const w: ScriptedWorld = { record: { generationId: "g1", content: "" }, pane: "", sends: [], gets: [] };
    const authedCalls: Array<{ kind: string; hasHeaders: boolean }> = [];
    const base = consumptionDeps(w);
    const inner = (base.clientFactory as unknown as () => { get: (p: string) => Promise<unknown>; post: (p: string, b: unknown) => Promise<unknown> })();
    (base as { clientFactory: unknown }).clientFactory = () => ({
      get: async (path: string, opts?: { headers?: Record<string, string> }) => {
        if (path.includes("/generation-record")) authedCalls.push({ kind: "record-get", hasHeaders: opts?.headers !== undefined });
        return inner.get(path);
      },
      post: async (path: string, body: unknown, opts?: { headers?: Record<string, string> }) => {
        if (path.startsWith("/api/transport/")) authedCalls.push({ kind: path.slice(15), hasHeaders: opts?.headers !== undefined });
        return inner.post(path, body);
      },
    });
    w.sendBehavior = (b) => {
      if (b["text"] !== undefined) { w.record.content += userRec(String(b["text"])) + "\n"; return { status: 200, data: { ok: true } }; }
      return { status: 200, data: { ok: true } };
    };
    await captureLogs(async () => {
      await makeCmd(base).parseAsync(walkArgs);
    });
    expect(authedCalls.length).toBeGreaterThan(0);
    const bare = authedCalls.filter((c) => !c.hasHeaders);
    expect(bare).toEqual([]); // every transport/record call goes through the auth chokepoint
  });
});
