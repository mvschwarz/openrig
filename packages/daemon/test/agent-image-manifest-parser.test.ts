// PL-016 — manifest parser tests.

import { describe, it, expect } from "vitest";
import { parseAgentImageManifest } from "../src/domain/agent-images/manifest-parser.js";
import { AgentImageError } from "../src/domain/agent-images/agent-image-types.js";

const validManifest = `
name: driver-rsi-primed
version: 1
runtime: claude-code
source_seat: velocity-driver@openrig-velocity
source_session_id: abc-123
source_resume_token: tok-xyz
created_at: "2026-05-04T19:00:00Z"
notes: |
  Snapshot after 2-hour PL-005 review session.
estimated_tokens: 80000
files:
  - path: cwd-delta.md
    role: cwd-delta
    summary: cwd-deltas at snapshot time
lineage:
  - velocity-driver-base
`;

describe("parseAgentImageManifest", () => {
  it("parses a valid manifest into the typed shape", () => {
    const m = parseAgentImageManifest(validManifest, "/test/manifest.yaml");
    expect(m.name).toBe("driver-rsi-primed");
    expect(m.version).toBe("1");
    expect(m.runtime).toBe("claude-code");
    expect(m.sourceSeat).toBe("velocity-driver@openrig-velocity");
    expect(m.sourceSessionId).toBe("abc-123");
    expect(m.sourceResumeToken).toBe("tok-xyz");
    expect(m.notes).toContain("PL-005 review");
    expect(m.estimatedTokens).toBe(80000);
    expect(m.lineage).toEqual(["velocity-driver-base"]);
    expect(m.files).toHaveLength(1);
  });

  it("normalizes numeric versions to strings", () => {
    const m = parseAgentImageManifest(`
name: x
version: 2
runtime: codex
source_seat: x@y
source_session_id: s
source_resume_token: t
files: []
`, "/x.yaml");
    expect(m.version).toBe("2");
  });

  it("rejects non-YAML content", () => {
    expect(() => parseAgentImageManifest("{not valid", "/x.yaml")).toThrow(AgentImageError);
    try { parseAgentImageManifest("{not valid", "/x.yaml"); } catch (err) {
      expect((err as AgentImageError).code).toBe("manifest_parse_error");
    }
  });

  it("rejects missing name", () => {
    expect(() => parseAgentImageManifest("version: 1\nruntime: claude-code\nsource_seat: x\nsource_session_id: s\nsource_resume_token: t\nfiles: []", "/x.yaml")).toThrow(/name/);
  });

  it("rejects missing version", () => {
    expect(() => parseAgentImageManifest("name: x\nruntime: claude-code\nsource_seat: x\nsource_session_id: s\nsource_resume_token: t\nfiles: []", "/x.yaml")).toThrow(/version/);
  });

  it("rejects invalid runtime", () => {
    expect(() => parseAgentImageManifest("name: x\nversion: 1\nruntime: bash\nsource_seat: x\nsource_session_id: s\nsource_resume_token: t\nfiles: []", "/x.yaml")).toThrow(/runtime/);
  });

  it("rejects missing source_seat", () => {
    expect(() => parseAgentImageManifest("name: x\nversion: 1\nruntime: claude-code\nsource_session_id: s\nsource_resume_token: t\nfiles: []", "/x.yaml")).toThrow(/source_seat/);
  });

  it("rejects missing source_resume_token", () => {
    expect(() => parseAgentImageManifest("name: x\nversion: 1\nruntime: claude-code\nsource_seat: x\nsource_session_id: s\nfiles: []", "/x.yaml")).toThrow(/source_resume_token/);
  });

  it("rejects file with .. in path", () => {
    expect(() => parseAgentImageManifest(`
name: x
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files:
  - path: ../escape.md
    role: r
`, "/x.yaml")).toThrow(/relative path inside the image/);
  });

  it("rejects file with unsupported suffix", () => {
    expect(() => parseAgentImageManifest(`
name: x
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files:
  - path: code.ts
    role: r
`, "/x.yaml")).toThrow(/unsupported suffix/);
  });

  it("accepts both camelCase and snake_case manifest keys", () => {
    const camelManifest = `
name: x
version: 1
runtime: claude-code
sourceSeat: x@y
sourceSessionId: s
sourceResumeToken: t
files: []
`;
    const m = parseAgentImageManifest(camelManifest, "/x.yaml");
    expect(m.sourceSeat).toBe("x@y");
    expect(m.sourceSessionId).toBe("s");
    expect(m.sourceResumeToken).toBe("t");
  });
});
