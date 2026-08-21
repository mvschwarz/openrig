import { describe, it, expect, vi } from "vitest";
import { makePredecessorRecapResolver } from "../src/domain/predecessor-recap-resolver.js";

// Production resolver for the seat-handover boot recap (the permanent claude-runtime leg of
// scrollback preservation): given the departing seat's
// node/runtime/session, resolve its provider record path (claude transcript_path / codex rollout_path)
// and parse the last N exchanges. Pure + injected deps → unit-testable without a live daemon.

describe("makePredecessorRecapResolver", () => {
  it("claude: reads the sidecar record and parses the last-N exchanges (no codex probe)", () => {
    const readClaudeRecord = vi.fn(() => ({ transcriptPath: "/home/.claude/projects/x/abc.jsonl", sessionId: "sid-1" }));
    const readCodexTranscriptPath = vi.fn(() => null);
    const lookupResumeToken = vi.fn(() => "sid-1"); // predecessor token matches the sidecar owner
    const parseExchanges = vi.fn(() => [
      { role: "user", content: "finish the atom" },
      { role: "assistant", content: "done" },
    ]);

    const resolve = makePredecessorRecapResolver({
      readClaudeRecord,
      readCodexTranscriptPath,
      lookupResumeToken,
      parseExchanges,
      maxExchanges: 6,
    });

    const out = resolve({ nodeId: "n1", runtime: "claude-code", sessionName: "dev-impl@rig" });

    expect(readClaudeRecord).toHaveBeenCalledWith("dev-impl@rig");
    expect(readCodexTranscriptPath).not.toHaveBeenCalled();
    expect(parseExchanges).toHaveBeenCalledWith("/home/.claude/projects/x/abc.jsonl", 6);
    expect(out).toEqual({
      recap: [
        { role: "user", content: "finish the atom" },
        { role: "assistant", content: "done" },
      ],
      recordPath: "/home/.claude/projects/x/abc.jsonl",
    });
  });

  it("B16 ownership guard: a sidecar whose session_id is NOT the predecessor's returns a NAMED unavailable (never another tenure's recap)", () => {
    const parseExchanges = vi.fn(() => [{ role: "user", content: "successor boot noise" }]);
    const resolve = makePredecessorRecapResolver({
      readClaudeRecord: () => ({ transcriptPath: "/p/successor.jsonl", sessionId: "successor-id" }),
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => "predecessor-id",
      parseExchanges,
    });

    const out = resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" });

    expect("unavailableReason" in out).toBe(true);
    if ("unavailableReason" in out) {
      expect(out.unavailableReason).toContain("successo"); // names the colliding session id prefix
      expect(out.unavailableReason).toContain("predeces");
    }
    expect(parseExchanges).not.toHaveBeenCalled(); // never parses the wrong tenure's record
  });

  it("B16 fail-open: missing session_id or missing predecessor token skips the guard and resolves by path", () => {
    const resolve = makePredecessorRecapResolver({
      readClaudeRecord: () => ({ transcriptPath: "/p/abc.jsonl", sessionId: null }),
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => null,
      parseExchanges: () => [{ role: "user", content: "hello" }],
    });
    const out = resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" });
    expect("recap" in out).toBe(true);
  });

  it("codex: looks up the departing resume token, reads the codex rollout_path, parses", () => {
    const readClaudeRecord = vi.fn(() => ({ transcriptPath: null, sessionId: null }));
    const readCodexTranscriptPath = vi.fn(() => "/home/.codex/sessions/roll.jsonl");
    const lookupResumeToken = vi.fn(() => "codex-thread-xyz");
    const parseExchanges = vi.fn(() => [{ role: "assistant", content: "handing over" }]);

    const resolve = makePredecessorRecapResolver({
      readClaudeRecord,
      readCodexTranscriptPath,
      lookupResumeToken,
      parseExchanges,
    });

    const out = resolve({ nodeId: "n2", runtime: "codex", sessionName: "dev-impl@rig" });

    expect(lookupResumeToken).toHaveBeenCalledWith("n2", "dev-impl@rig");
    expect(readCodexTranscriptPath).toHaveBeenCalledWith({ threadId: "codex-thread-xyz", sessionName: "dev-impl@rig" });
    expect(readClaudeRecord).not.toHaveBeenCalled();
    expect(out).toEqual({ recap: [{ role: "assistant", content: "handing over" }], recordPath: "/home/.codex/sessions/roll.jsonl" });
  });

  it("no record path resolves to a NAMED unavailable (parse not attempted)", () => {
    const parseExchanges = vi.fn(() => []);
    const resolve = makePredecessorRecapResolver({
      readClaudeRecord: () => ({ transcriptPath: null, sessionId: null }),
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => null,
      parseExchanges,
    });

    const out = resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" });
    expect("unavailableReason" in out && out.unavailableReason).toContain("sidecar");
    expect(parseExchanges).not.toHaveBeenCalled();
  });

  it("bounds each exchange's content at maxCharsPerExchange with a visible truncation marker", () => {
    const long = "x".repeat(800);
    const resolve = makePredecessorRecapResolver({
      readClaudeRecord: () => ({ transcriptPath: "/p/abc.jsonl", sessionId: null }),
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => null,
      parseExchanges: () => [
        { role: "user", content: "short" },
        { role: "assistant", content: long },
      ],
      maxCharsPerExchange: 100,
    });

    const out = resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" });
    if (!("recap" in out)) throw new Error("expected recap");
    expect(out.recap[0]).toEqual({ role: "user", content: "short" });
    expect(out.recap[1]!.content).toHaveLength(100 + "… [truncated; full text in the predecessor record]".length);
    expect(out.recap[1]!.content.startsWith("x".repeat(100))).toBe(true);
    expect(out.recap[1]!.content).toContain("[truncated; full text in the predecessor record]");
  });

  it("caps per-exchange content at 500 chars by default (a pasted-file exchange must not flood the successor pane)", () => {
    const resolve = makePredecessorRecapResolver({
      readClaudeRecord: () => ({ transcriptPath: "/p/abc.jsonl", sessionId: null }),
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => null,
      parseExchanges: () => [{ role: "user", content: "y".repeat(10_000) }],
    });

    const out = resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" });
    if (!("recap" in out)) throw new Error("expected recap");
    expect(out.recap[0]!.content.startsWith("y".repeat(500))).toBe(true);
    expect(out.recap[0]!.content).toContain("[truncated; full text in the predecessor record]");
    expect(out.recap[0]!.content.length).toBeLessThan(600);
  });

  it("a record with zero exchanges resolves to a NAMED unavailable citing the path (no fabrication)", () => {
    const resolve = makePredecessorRecapResolver({
      readClaudeRecord: () => ({ transcriptPath: "/p/empty.jsonl", sessionId: null }),
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => null,
      parseExchanges: () => [],
    });

    const out = resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" });
    expect("unavailableReason" in out && out.unavailableReason).toContain("/p/empty.jsonl");
  });
});
