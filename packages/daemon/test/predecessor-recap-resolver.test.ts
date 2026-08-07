import { describe, it, expect, vi } from "vitest";
import { makePredecessorRecapResolver } from "../src/domain/predecessor-recap-resolver.js";

// Production resolver for the seat-handover stopgap (plan 411c43de): given the departing seat's
// node/runtime/session, resolve its provider record path (claude transcript_path / codex rollout_path)
// and parse the last N exchanges. Pure + injected deps → unit-testable without a live daemon.

describe("makePredecessorRecapResolver", () => {
  it("claude: reads the claude transcript_path and parses the last-N exchanges (no codex probe)", () => {
    const readClaudeTranscriptPath = vi.fn(() => "/home/.claude/projects/x/abc.jsonl");
    const readCodexTranscriptPath = vi.fn(() => null);
    const lookupResumeToken = vi.fn(() => null);
    const parseExchanges = vi.fn(() => [
      { role: "user", content: "finish the atom" },
      { role: "assistant", content: "done" },
    ]);

    const resolve = makePredecessorRecapResolver({
      readClaudeTranscriptPath,
      readCodexTranscriptPath,
      lookupResumeToken,
      parseExchanges,
      maxExchanges: 6,
    });

    const out = resolve({ nodeId: "n1", runtime: "claude-code", sessionName: "dev-impl@rig" });

    expect(readClaudeTranscriptPath).toHaveBeenCalledWith("dev-impl@rig");
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

  it("codex: looks up the departing resume token, reads the codex rollout_path, parses", () => {
    const readClaudeTranscriptPath = vi.fn(() => null);
    const readCodexTranscriptPath = vi.fn(() => "/home/.codex/sessions/roll.jsonl");
    const lookupResumeToken = vi.fn(() => "codex-thread-xyz");
    const parseExchanges = vi.fn(() => [{ role: "assistant", content: "handing over" }]);

    const resolve = makePredecessorRecapResolver({
      readClaudeTranscriptPath,
      readCodexTranscriptPath,
      lookupResumeToken,
      parseExchanges,
    });

    const out = resolve({ nodeId: "n2", runtime: "codex", sessionName: "dev-impl@rig" });

    expect(lookupResumeToken).toHaveBeenCalledWith("n2", "dev-impl@rig");
    expect(readCodexTranscriptPath).toHaveBeenCalledWith({ threadId: "codex-thread-xyz", sessionName: "dev-impl@rig" });
    expect(readClaudeTranscriptPath).not.toHaveBeenCalled();
    expect(out).toEqual({ recap: [{ role: "assistant", content: "handing over" }], recordPath: "/home/.codex/sessions/roll.jsonl" });
  });

  it("returns null when no record path resolves (honest-degraded, parse not attempted)", () => {
    const parseExchanges = vi.fn(() => []);
    const resolve = makePredecessorRecapResolver({
      readClaudeTranscriptPath: () => null,
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => null,
      parseExchanges,
    });

    expect(resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" })).toBeNull();
    expect(parseExchanges).not.toHaveBeenCalled();
  });

  it("returns null when the record resolves but yields zero exchanges (no fabrication)", () => {
    const resolve = makePredecessorRecapResolver({
      readClaudeTranscriptPath: () => "/p/empty.jsonl",
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => null,
      parseExchanges: () => [],
    });

    expect(resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" })).toBeNull();
  });
});
