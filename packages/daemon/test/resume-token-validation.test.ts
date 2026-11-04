// OPR.0.4.0.22 FR-2 — per-runtime resume-token validation. Format-validate
// (the floor), reject malformed, NEVER fabricate, and NEVER echo the raw token
// in an error message (credential-class redaction).

import { describe, it, expect } from "vitest";
import { validateResumeToken, resumeTypeForRuntime } from "../src/domain/resume-token-validation.js";

describe("resumeTypeForRuntime", () => {
  it("maps runtimes to their resume-id type", () => {
    expect(resumeTypeForRuntime("claude-code")).toBe("claude_id");
    expect(resumeTypeForRuntime("codex")).toBe("codex_id");
    expect(resumeTypeForRuntime("pi")).toBe("pi_session_file");
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

// OPR.0.4.6.PI1 FR-6 — per-resume-type validation. Pi's resume token is a
// PATH (the session file), so it gets its own floor: absolute, no ".."
// segment, shell-inert path charset, 1024 cap, ".jsonl" suffix. The
// claude/codex id-shape rules are byte-identical before/after (the id-rule
// tests above must keep passing unchanged).
describe("validateResumeToken — pi_session_file (path-shaped, per-type)", () => {
  const validPath = "/Users/someone/.openrig/state/pi/seat-a/sessions/2026-07-06T10-00-00_0197a2f0-1234-7abc-8def-0123456789ab.jsonl";

  it("accepts a valid absolute .jsonl session-file path and returns pi_session_file", () => {
    const r = validateResumeToken("pi", validPath);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resumeType).toBe("pi_session_file");
      expect(r.token).toBe(validPath);
    }
  });

  it("accepts '@' in the path — Pi seat state dirs key on the CANONICAL session name (pod-member@rig)", () => {
    // VM-caught regression: the original PRD charset rejected every real Pi
    // seat's session file because the layout embeds the canonical name.
    const seatPath = "/openrig-home/state/pi/devpi-driver1@openrig-delivery/sessions/2026-07-07T00-00-00_0197.jsonl";
    const r = validateResumeToken("pi", seatPath);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe(seatPath);
  });

  it("trims surrounding whitespace before validating/persisting", () => {
    const r = validateResumeToken("pi", `  ${validPath}  `);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe(validPath);
  });

  it("rejects a relative path", () => {
    const r = validateResumeToken("pi", "sessions/2026_abc.jsonl");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/absolute/i);
  });

  it("rejects a '..' path segment (raw-operand traversal posture) without echoing the token", () => {
    const sneaky = "/seat/../../../etc/creds_0197.jsonl";
    const r = validateResumeToken("pi", sneaky);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(sneaky);
      expect(r.error).toMatch(/'\.\.' path segment/);
    }
  });

  it("does NOT reject '..' appearing inside a filename (only whole segments)", () => {
    const dots = "/seat/sessions/2026..07.._abc.jsonl";
    const r = validateResumeToken("pi", dots);
    expect(r.ok).toBe(true);
  });

  it("rejects a path over 1024 characters without echoing it", () => {
    const huge = "/" + "a".repeat(1100) + ".jsonl";
    const r = validateResumeToken("pi", huge);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(huge);
      expect(r.error).toMatch(/too long/i);
    }
  });

  it("accepts a long-but-under-cap path (id-shape 200 cap does NOT apply to pi)", () => {
    const long = "/" + "a".repeat(400) + "/sessions/x_y.jsonl"; // > 200 chars, < 1024
    expect(long.length).toBeGreaterThan(200);
    const r = validateResumeToken("pi", long);
    expect(r.ok).toBe(true);
  });

  it("rejects disallowed characters (spaces, shell metacharacters) without echoing", () => {
    const secret = "/seat/sessions/x y; rm -rf.jsonl";
    const r = validateResumeToken("pi", secret);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(secret);
      expect(r.error).not.toContain("rm -rf");
      expect(r.error).toMatch(/disallowed characters/i);
    }
  });

  it("rejects a path without the .jsonl suffix", () => {
    const r = validateResumeToken("pi", "/seat/sessions/0197-abc.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/\.jsonl/);
  });

  it("keeps per-type separation: a path-shaped token is still rejected for claude/codex", () => {
    expect(validateResumeToken("claude-code", validPath).ok).toBe(false);
    expect(validateResumeToken("codex", validPath).ok).toBe(false);
  });
});
