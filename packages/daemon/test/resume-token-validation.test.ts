// OPR.0.4.0.22 FR-2 — per-runtime resume-token validation. Format-validate
// (the floor), reject malformed, NEVER fabricate, and NEVER echo the raw token
// in an error message (credential-class redaction).

import { describe, it, expect } from "vitest";
import { validateResumeToken, resumeTypeForRuntime } from "../src/domain/resume-token-validation.js";

describe("resumeTypeForRuntime", () => {
  it("maps runtimes to their resume-id type", () => {
    expect(resumeTypeForRuntime("claude-code")).toBe("claude_id");
    expect(resumeTypeForRuntime("codex")).toBe("codex_id");
    expect(resumeTypeForRuntime("terminal")).toBeNull();
    expect(resumeTypeForRuntime(null)).toBeNull();
  });
});

describe("validateResumeToken", () => {
  it("accepts a well-formed claude token and returns claude_id", () => {
    const r = validateResumeToken("claude-code", "abc-123-def-456");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resumeType).toBe("claude_id");
      expect(r.token).toBe("abc-123-def-456");
    }
  });

  it("accepts a well-formed codex token and returns codex_id", () => {
    const r = validateResumeToken("codex", "0199abcd_thread.id");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resumeType).toBe("codex_id");
  });

  it("trims surrounding whitespace before validating/persisting", () => {
    const r = validateResumeToken("claude-code", "  tok-123  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe("tok-123");
  });

  it("rejects an unsupported runtime without fabricating", () => {
    const r = validateResumeToken("terminal", "anything");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not supported/i);
  });

  it("rejects an empty token", () => {
    const r = validateResumeToken("claude-code", "   ");
    expect(r.ok).toBe(false);
  });

  it("rejects a token with disallowed characters WITHOUT echoing the token (redaction)", () => {
    const secret = "tok with spaces; rm -rf /";
    const r = validateResumeToken("claude-code", secret);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(secret);
      expect(r.error).not.toContain("rm -rf");
      expect(r.error).toMatch(/disallowed characters/i);
    }
  });

  it("rejects a non-string token", () => {
    const r = validateResumeToken("claude-code", undefined);
    expect(r.ok).toBe(false);
  });

  it("rejects an over-long token without echoing it", () => {
    const huge = "a".repeat(5000);
    const r = validateResumeToken("codex", huge);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(huge);
      expect(r.error).toMatch(/too long/i);
    }
  });
});
