// Tier 1 proof for the Agent Starter v1 vertical M1 resolver:
// AgentStarterResolver class + AgentStarterCredentialScanFailedError.
// Per slice IMPL § File: agent-starter-resolver.ts: the resolver MUST
// throw on a failed no-credentials scan; it does NOT return a "result"
// the orchestrator can ignore.

import { describe, it, expect } from "vitest";
import {
  AgentStarterResolver,
  AgentStarterCredentialScanFailedError,
} from "../src/domain/agent-starter-resolver.js";

function makeFs(files: Record<string, string>) {
  const exists = (p: string) => Object.prototype.hasOwnProperty.call(files, p);
  const readFile = (p: string) => {
    if (!exists(p)) throw new Error(`ENOENT: ${p}`);
    return files[p]!;
  };
  return { exists, readFile };
}

const CLEAN_ENTRY = `draft: false
starter_id: fixture-clean
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "fixture-native-id"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
`;

describe("AgentStarterResolver (M1)", () => {
  // === Lookup chain ===

  it("registry root: opts.registryRoot wins over env, home, and fallback", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({
      registryRoot: "/explicit/root",
      env: { OPENRIG_AGENT_STARTER_ROOT: "/env/root", HOME: "/home/test" },
      homeDirRoot: "/home/test/.openrig/agent-starters",
      fallbackRoot: "/fallback/root",
      ...fs,
    });
    expect(resolver.getRegistryRoot()).toBe("/explicit/root");
  });

  it("registry root: env var wins when opts.registryRoot is absent", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({
      env: { OPENRIG_AGENT_STARTER_ROOT: "/env/root", HOME: "/home/test" },
      homeDirRoot: "/home/test/.openrig/agent-starters",
      fallbackRoot: "/fallback/root",
      ...fs,
    });
    expect(resolver.getRegistryRoot()).toBe("/env/root");
  });

  it("registry root: homeDirRoot wins when registryRoot+env absent AND home dir exists", () => {
    const fs = makeFs({ "/home/test/.openrig/agent-starters": "dir" });
    const resolver = new AgentStarterResolver({
      env: { HOME: "/home/test" },
      homeDirRoot: "/home/test/.openrig/agent-starters",
      fallbackRoot: "/fallback/root",
      ...fs,
    });
    expect(resolver.getRegistryRoot()).toBe("/home/test/.openrig/agent-starters");
  });

  it("registry root: configured fallback wins when registryRoot+env absent AND home dir does NOT exist", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({
      env: { HOME: "/home/test" },
      homeDirRoot: "/home/test/.openrig/agent-starters",
      fallbackRoot: "/fallback/root",
      ...fs,
    });
    expect(resolver.getRegistryRoot()).toBe("/fallback/root");
  });

  it("registry root: missing home dir falls back to the portable home path by default", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({
      env: { HOME: "/home/test" },
      homeDirRoot: "/home/test/.openrig/agent-starters",
      ...fs,
    });
    expect(resolver.getRegistryRoot()).toBe("/home/test/.openrig/agent-starters");
  });

  // === Successful resolve ===

  it("clean entry resolves to one ResolvedStartupFile rooted at registryRoot", () => {
    const fs = makeFs({ "/registry/fixture-clean.yaml": CLEAN_ENTRY });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    const result = resolver.resolveStarter("fixture-clean");
    expect(result.registryPath).toBe("/registry/fixture-clean.yaml");
    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("fixture-clean.yaml");
    expect(file.absolutePath).toBe("/registry/fixture-clean.yaml");
    expect(file.ownerRoot).toBe("/registry");
    expect(file.appliesOn).toEqual(["fresh_start"]);
    expect(file.required).toBe(true);
  });

  // === Credential-scan refusal: THROWS, does not return ===

  it("THROWS AgentStarterCredentialScanFailedError on credential-path match", () => {
    const malicious = CLEAN_ENTRY.replace(
      "ready_check_evidence: ../evidence/fixture.md",
      "ready_check_evidence: ~/.claude/.credentials.json",
    );
    const fs = makeFs({ "/registry/fixture-mal.yaml": malicious });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    let caught: AgentStarterCredentialScanFailedError | undefined;
    try {
      resolver.resolveStarter("fixture-mal");
    } catch (err) {
      if (err instanceof AgentStarterCredentialScanFailedError) caught = err;
      else throw err;
    }
    expect(caught).toBeDefined();
    expect(caught!.reason).toContain("credential_path_disallowed");
    // R2-3 redaction: error message MUST NOT echo the matched line content.
    expect(caught!.reason).toContain("content redacted");
    expect(caught!.reason).not.toContain(".credentials.json");
    expect(caught!.message).not.toContain(".credentials.json");
  });

  it("THROWS AgentStarterCredentialScanFailedError on credential-content match (api_key)", () => {
    const malicious = `${CLEAN_ENTRY}api_key: example-not-real
`;
    const fs = makeFs({ "/registry/fixture-mal2.yaml": malicious });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    let caught: AgentStarterCredentialScanFailedError | undefined;
    try {
      resolver.resolveStarter("fixture-mal2");
    } catch (err) {
      if (err instanceof AgentStarterCredentialScanFailedError) caught = err;
      else throw err;
    }
    expect(caught).toBeDefined();
    expect(caught!.starterName).toBe("fixture-mal2");
    expect(caught!.reason).toContain("credential_content_disallowed");
    // R2-3 redaction: error MUST NOT contain the fixture secret string.
    expect(caught!.reason).toContain("content redacted");
    expect(caught!.reason).not.toContain("example-not-real");
    expect(caught!.message).not.toContain("example-not-real");
    expect(caught!.reason).not.toContain("api_key");
    expect(caught!.message).not.toContain("api_key");
  });

  it("THROWS on case-insensitive credential marker (API_KEY uppercase)", () => {
    const malicious = `${CLEAN_ENTRY}API_KEY: uppercase-not-real
`;
    const fs = makeFs({ "/registry/fixture-mal3.yaml": malicious });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    let caught: AgentStarterCredentialScanFailedError | undefined;
    try {
      resolver.resolveStarter("fixture-mal3");
    } catch (err) {
      if (err instanceof AgentStarterCredentialScanFailedError) caught = err;
      else throw err;
    }
    expect(caught).toBeDefined();
    // R2-3 redaction: uppercase marker also must not leak.
    expect(caught!.reason).toContain("content redacted");
    expect(caught!.reason).not.toContain("API_KEY");
    expect(caught!.message).not.toContain("API_KEY");
    expect(caught!.reason).not.toContain("uppercase-not-real");
    expect(caught!.message).not.toContain("uppercase-not-real");
  });

  // R2-3 leak negative: token-shaped secrets MUST NOT appear in error message.
  it("redacts sk- token-shaped fixture from error message (R2-3)", () => {
    const malicious = CLEAN_ENTRY.replace(
      'value: "fixture-native-id"',
      'value: "sk-fakefakefakefakefakefakefakefake"',
    );
    const fs = makeFs({ "/registry/fixture-mal-token.yaml": malicious });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    let caught: AgentStarterCredentialScanFailedError | undefined;
    try {
      resolver.resolveStarter("fixture-mal-token");
    } catch (err) {
      if (err instanceof AgentStarterCredentialScanFailedError) caught = err;
      else throw err;
    }
    expect(caught).toBeDefined();
    expect(caught!.reason).toContain("credential_content_disallowed");
    expect(caught!.reason).toContain("content redacted");
    // The token-shaped substring MUST NOT appear in either field.
    expect(caught!.reason).not.toContain("sk-fakefakefakefakefakefakefakefake");
    expect(caught!.message).not.toContain("sk-fakefakefakefakefakefakefakefake");
  });

  // R2-3 diagnostic preservation: refusal code, line number, and file
  // path MUST still appear so operators can triage.
  it("error message preserves non-sensitive diagnostics (refusal code + line + path)", () => {
    const malicious = `${CLEAN_ENTRY}api_key: example
`;
    const fs = makeFs({ "/registry/fixture-mal-diag.yaml": malicious });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    let caught: AgentStarterCredentialScanFailedError | undefined;
    try {
      resolver.resolveStarter("fixture-mal-diag");
    } catch (err) {
      if (err instanceof AgentStarterCredentialScanFailedError) caught = err;
      else throw err;
    }
    expect(caught).toBeDefined();
    expect(caught!.reason).toMatch(/credential_content_disallowed/);
    expect(caught!.reason).toMatch(/line \d+/);
    expect(caught!.reason).toContain("/registry/fixture-mal-diag.yaml");
  });

  it("allowlist exception: transcript_path under ~/.claude/projects/ is accepted", () => {
    const withTranscript = `${CLEAN_ENTRY}transcript_path: /Users/x/.claude/projects/fixture/abc.jsonl
`;
    const fs = makeFs({ "/registry/fixture-allow.yaml": withTranscript });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    const result = resolver.resolveStarter("fixture-allow");
    expect(result.files).toHaveLength(1);
  });

  // === Missing entry / malformed YAML ===

  it("throws on missing registry entry", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    expect(() => resolver.resolveStarter("nonexistent"))
      .toThrow(/no registry entry found/);
  });

  it("throws on malformed YAML (missing starter_id field)", () => {
    const fs = makeFs({ "/registry/fixture-bad.yaml": "this is not a starter entry\n" });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    expect(() => resolver.resolveStarter("fixture-bad"))
      .toThrow(/registry-entry shape/);
  });

  it("throws on empty file", () => {
    const fs = makeFs({ "/registry/fixture-empty.yaml": "" });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    expect(() => resolver.resolveStarter("fixture-empty"))
      .toThrow(/empty or unreadable/);
  });

  // === Name-shape validation (path-traversal guard) ===

  it("throws on invalid name with path-traversal characters", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    expect(() => resolver.resolveStarter("../etc/passwd"))
      .toThrow(/invalid name/);
  });

  it("throws on invalid name with slash", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    expect(() => resolver.resolveStarter("foo/bar"))
      .toThrow(/invalid name/);
  });
});
