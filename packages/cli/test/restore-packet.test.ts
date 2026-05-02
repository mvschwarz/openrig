// M2 Restore-Packet vertical — Tier 1 tests.
//
// M2a focus: schema-validator + restore-packet command shell + mutual-exclusion.
// M2b adds: codex-jsonl-parser + claude-transcript-parser + runtime-detect +
//           redaction + omitted-records (with Velocity round-trips).
// M2c adds: packet-writer atomic emission + daemon route integration.
//
// TDD discipline (per memory feedback_tdd_scope): each test was authored to
// fail first, then the implementation was written to green. The committed
// state is the green/passing state.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";

// Module-level mock for daemon-lifecycle so the M2c-CLI mock-daemon
// round-trip test can drive a fake "daemon running" state without
// touching the host's real daemon. Other tests in this file don't
// invoke daemon-lifecycle (they exercise pure parsers / packet-writer),
// so they're unaffected.
vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  validateRestoreSummary,
  RESTORE_SUMMARY_SCHEMA,
  type ValidationResult,
} from "../src/restore-packet/schema-validator.js";
import { restorePacketCommand } from "../src/commands/restore-packet.js";
import { redact, hasSecretPattern, SECRET_PATTERNS } from "../src/restore-packet/redaction.js";
import {
  classifyCodexRecord,
  classifyClaudeRecord,
  OmittedCounter,
} from "../src/restore-packet/omitted-records.js";
import { detectRuntime } from "../src/restore-packet/runtime-detect.js";
import { parseCodexJsonl } from "../src/restore-packet/codex-jsonl-parser.js";
import { parseClaudeTranscript } from "../src/restore-packet/claude-transcript-parser.js";

// Minimal valid summary fixture matching the M1 contract (§ 2.1) required-field
// set verbatim. Tests compose against this baseline by mutating one field at
// a time to drive the accept/reject matrix.
function validSummary(): Record<string, unknown> {
  return {
    source_session_id: "velocity-driver@openrig-velocity",
    source_rig: "openrig-velocity",
    source_runtime: "claude-code",
    source_cwd: "/Users/wrandom/code/projects/openrig-hub",
    target_rig: "openrig-velocity",
    target_runtime: "claude-code",
    target_workspace_root: "/Users/wrandom/code/projects/openrig-hub",
    default_target_repo: null,
    role_pointer: "rigs/openrig-velocity/state/velocity/driver-role.md",
    bounded_latest_transcript: {
      path: "transcript-latest.md",
      message_count: 87,
      bound: 120,
    },
    touched_files: {
      path: "touched-files.md",
      top_paths: [{ path: "packages/cli/src/commands/restore-packet.ts", count: 14 }],
    },
    durable_pointers: {
      queue_pointers: [],
      progress_pointers: [],
      field_note_pointers: [],
      artifact_pointers: [],
    },
    current_work_summary: "Working on M2a chunk of restore-packet vertical.",
    next_owner: "self",
    caveats: [],
    authority_boundaries: "Implement M2a only; do not touch M3+ surfaces.",
    omitted_classes: ["reasoning_records"],
    redaction_policy_id: "openrig-v0",
    source_trust_ranking: ["rig_whoami", "bounded_latest_transcript"],
    generator_version: "rig-restore-packet@0.1.0",
    generated_at: "2026-05-01T23:30:00Z",
  };
}

describe("M2 restore-packet schema-validator", () => {
  it("accepts a valid summary matching contract § 2.1", () => {
    const result: ValidationResult = validateRestoreSummary(validSummary());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects when source_session_id is missing", () => {
    const summary = validSummary();
    delete (summary as Record<string, unknown>)["source_session_id"];
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /source_session_id|required/.test(e.field) || /source_session_id|required/i.test(e.rule))).toBe(true);
  });

  it("rejects when source_runtime is not one of the enum values", () => {
    const summary = validSummary();
    summary["source_runtime"] = "bash";
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /source_runtime/.test(e.field))).toBe(true);
  });

  it("rejects when source_cwd is not absolute", () => {
    const summary = validSummary();
    summary["source_cwd"] = "relative/path";
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /source_cwd/.test(e.field))).toBe(true);
  });

  it("rejects when bounded_latest_transcript.bound is not 120", () => {
    const summary = validSummary();
    (summary["bounded_latest_transcript"] as Record<string, unknown>)["bound"] = 100;
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /bound/.test(e.field))).toBe(true);
  });

  it("rejects when durable_pointers is missing required arrays", () => {
    const summary = validSummary();
    summary["durable_pointers"] = { queue_pointers: [] };
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    // Missing progress_pointers / field_note_pointers / artifact_pointers
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects when redaction_policy_id is not a known policy", () => {
    const summary = validSummary();
    summary["redaction_policy_id"] = "custom-policy";
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /redaction_policy_id/.test(e.field))).toBe(true);
  });

  it("rejects when source_trust_ranking is empty", () => {
    const summary = validSummary();
    summary["source_trust_ranking"] = [];
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /source_trust_ranking/.test(e.field))).toBe(true);
  });

  it("rejects when generated_at is not ISO-8601", () => {
    const summary = validSummary();
    summary["generated_at"] = "yesterday";
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /generated_at/.test(e.field))).toBe(true);
  });

  it("rejects when an unknown top-level field is present (additionalProperties: false)", () => {
    const summary = validSummary();
    (summary as Record<string, unknown>)["new_field"] = "leaked";
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /new_field|additional/.test(e.field) || /additional/i.test(e.rule))).toBe(true);
  });

  it("accepts a summary with optional full_transcript present", () => {
    const summary = validSummary();
    summary["full_transcript"] = { path: "transcript.md", line_count: 4321 };
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(true);
  });

  // M2a R2 drift-catcher: the canonical JSON Schema file at
  // src/schemas/restore-summary.schema.json and the embedded TS const
  // RESTORE_SUMMARY_SCHEMA must stay byte-equivalent. Embedding the schema
  // in the validator is the M2a R2 packaging fix (tsc emits the const into
  // dist/restore-packet/schema-validator.js, so the validator works after
  // raw `tsc` emit without any extra build-script copy step). The JSON file
  // remains the canonical source for downstream tooling that reads JSON
  // Schema directly. This test fails loudly if either form drifts.
  it("M2a R2 drift-catcher: TS const RESTORE_SUMMARY_SCHEMA equals the canonical JSON schema file", () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const schemaJsonPath = resolve(
      __dirname,
      "..",
      "src",
      "schemas",
      "restore-summary.schema.json",
    );
    const jsonForm: unknown = JSON.parse(readFileSync(schemaJsonPath, "utf-8"));
    expect(RESTORE_SUMMARY_SCHEMA).toEqual(jsonForm);
  });
});

describe("M2 restore-packet CLI command shell + mutual-exclusion", () => {
  function runRestorePacket(argv: string[]): { exitCode: number | undefined; stderr: string[]; stdout: string[] } {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const origExitCode = process.exitCode;
    const origConsoleLog = console.log;
    const origConsoleError = console.error;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => stdout.push(args.join(" "));
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    try {
      const program = new Command();
      program.exitOverride();
      // Route commander's writeErr (used for missing-required-option messages)
      // into our stderr capture so test assertions can match against it.
      program.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
      const sub = restorePacketCommand();
      sub.exitOverride();
      sub.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
      sub.commands.forEach((c) => {
        c.exitOverride();
        c.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
      });
      program.addCommand(sub);
      try {
        program.parse(["node", "rig", ...argv]);
      } catch (err) {
        // commander throws on exitOverride + nonzero exit. Capture the
        // thrown CommanderError message into stderr so callers can match
        // against it (some commander error paths route through err.message
        // rather than configureOutput's writeErr).
        if (err instanceof Error && err.message) {
          stderr.push(err.message);
        }
        if (process.exitCode === undefined || process.exitCode === 0) {
          process.exitCode = 2;
        }
      }
    } finally {
      console.log = origConsoleLog;
      console.error = origConsoleError;
    }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    return { exitCode, stderr, stdout };
  }

  it("registers a `restore-packet` command with subcommands write / read / validate", () => {
    const cmd = restorePacketCommand();
    expect(cmd.name()).toBe("restore-packet");
    const subs = cmd.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(["read", "validate", "write"]);
  });

  it("write fails with explicit error when both --source-session AND --source-jsonl are supplied", () => {
    const { exitCode, stderr } = runRestorePacket([
      "restore-packet", "write",
      "--source-session", "fake@kernel",
      "--source-jsonl", "/tmp/fake.jsonl",
      "--target", "/tmp/out",
    ]);
    expect(exitCode).not.toBe(0);
    const errStr = stderr.join("\n");
    expect(errStr).toMatch(/mutually exclusive|exactly one|both supplied/i);
  });

  it("write fails with explicit error when neither --source-session nor --source-jsonl is supplied", () => {
    const { exitCode, stderr } = runRestorePacket([
      "restore-packet", "write",
      "--target", "/tmp/out",
    ]);
    expect(exitCode).not.toBe(0);
    const errStr = stderr.join("\n");
    expect(errStr).toMatch(/--source-session|--source-jsonl|exactly one/i);
  });

  it("write fails when --target is missing (commander requiredOption check)", () => {
    const { exitCode, stderr } = runRestorePacket([
      "restore-packet", "write",
      "--source-jsonl", "/tmp/fake.jsonl",
    ]);
    expect(exitCode).not.toBe(0);
    const errStr = stderr.join("\n");
    expect(errStr).toMatch(/--target|required/i);
  });

  it("read subcommand exists as M2a stub (full implementation in M3)", () => {
    const cmd = restorePacketCommand();
    const readCmd = cmd.commands.find((c) => c.name() === "read");
    expect(readCmd).toBeDefined();
    expect(readCmd!.description()).toMatch(/render|packet/i);
  });

  it("validate subcommand exists as M2a stub (full implementation in M3)", () => {
    const cmd = restorePacketCommand();
    const validateCmd = cmd.commands.find((c) => c.name() === "validate");
    expect(validateCmd).toBeDefined();
    expect(validateCmd!.description()).toMatch(/validate|schema/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// M2b sub-module tests (codex-jsonl-parser, claude-transcript-parser,
// runtime-detect, redaction, omitted-records). All fixtures are
// SYNTHETIC; no real transcript content imported. No auth tokens or
// device codes (Quality Lesson v9).
// ─────────────────────────────────────────────────────────────────────

describe("M2b redaction (openrig-v0 / velocity-v1 patterns)", () => {
  it("redacts sk-* tokens", () => {
    const text = "Some leaked sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ pattern here.";
    const redacted = redact(text);
    expect(redacted).not.toContain("sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts ghp_/ghs_/gho_ GitHub tokens", () => {
    const text = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123 was leaked.";
    const redacted = redact(text);
    expect(redacted).not.toContain("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts github_pat_ fine-grained tokens", () => {
    const text = "Token: github_pat_AbCdEfGh01234567890123456789";
    const redacted = redact(text);
    expect(redacted).not.toContain("github_pat_AbCdEfGh01234567890123456789");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const text = "Authorization: Bearer aBcD1234.eFgH5678.iJkL9012-mNoP";
    const redacted = redact(text);
    expect(redacted).not.toContain("Bearer aBcD1234.eFgH5678.iJkL9012-mNoP");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts long base64-shaped strings", () => {
    const text = "Encoded: aGVsbG93b3JsZGFlaW91YWVpb3VhZWlvdWFlaW91YWVpb3U=";
    const redacted = redact(text);
    expect(redacted).toContain("[REDACTED]");
  });

  it("leaves non-credential content unchanged byte-for-byte", () => {
    const text = "Normal message: visit https://example.com for docs.";
    const redacted = redact(text);
    expect(redacted).toBe(text);
  });

  it("hasSecretPattern detects each known credential class", () => {
    expect(hasSecretPattern("sk-AbCdEfGhIjKlMnOpQ")).toBe(true);
    expect(hasSecretPattern("normal text without secrets")).toBe(false);
    expect(hasSecretPattern("")).toBe(false);
  });

  it("exposes the pattern list (5 patterns per Velocity prior art)", () => {
    expect(SECRET_PATTERNS.length).toBe(5);
  });
});

describe("M2b omitted-records classifier", () => {
  it("classifies Codex function_call → function_call_output", () => {
    const result = classifyCodexRecord({ payload: { type: "function_call" } });
    expect(result.kind).toBe("omitted");
    if (result.kind === "omitted") {
      expect(result.reason).toBe("function_call_output");
    }
  });

  it("classifies Codex custom_tool_call → raw_tool_outputs", () => {
    const result = classifyCodexRecord({ payload: { type: "custom_tool_call" } });
    expect(result.kind).toBe("omitted");
    if (result.kind === "omitted") {
      expect(result.reason).toBe("raw_tool_outputs");
    }
  });

  it("classifies Codex reasoning → reasoning_records", () => {
    const result = classifyCodexRecord({ payload: { type: "reasoning" } });
    expect(result.kind).toBe("omitted");
    if (result.kind === "omitted") {
      expect(result.reason).toBe("reasoning_records");
    }
  });

  it("classifies Codex message+user-role → kept", () => {
    const result = classifyCodexRecord({ payload: { type: "message", role: "user" } });
    expect(result.kind).toBe("kept");
  });

  it("classifies Codex message+unknown-role → omitted (reasoning)", () => {
    const result = classifyCodexRecord({ payload: { type: "message", role: "system" } });
    expect(result.kind).toBe("omitted");
  });

  it("classifies Claude attachment → raw_tool_outputs", () => {
    const result = classifyClaudeRecord({ type: "attachment" });
    expect(result.kind).toBe("omitted");
    if (result.kind === "omitted") {
      expect(result.reason).toBe("raw_tool_outputs");
    }
  });

  it("classifies Claude user|assistant → kept", () => {
    expect(classifyClaudeRecord({ type: "user" }).kind).toBe("kept");
    expect(classifyClaudeRecord({ type: "assistant" }).kind).toBe("kept");
  });

  it("classifies Claude summary → reasoning_records", () => {
    const result = classifyClaudeRecord({ type: "summary" });
    expect(result.kind).toBe("omitted");
    if (result.kind === "omitted") {
      expect(result.reason).toBe("reasoning_records");
    }
  });

  it("OmittedCounter accumulates per-class counts and active-classes list", () => {
    const counter = new OmittedCounter();
    counter.recordOmission("reasoning_records");
    counter.recordOmission("reasoning_records");
    counter.recordOmission("function_call_output");
    counter.recordRedaction();

    expect(counter.counts.reasoning_records).toBe(2);
    expect(counter.counts.function_call_output).toBe(1);
    expect(counter.counts.redacted_secrets).toBe(1);
    expect(counter.counts.raw_tool_outputs).toBe(0);

    expect(counter.activeClasses()).toEqual([
      "reasoning_records",
      "function_call_output",
      "redacted_secrets",
    ]);
  });
});

describe("M2b runtime-detect", () => {
  it("detects Codex JSONL via response_item type marker", () => {
    const content = `{"type":"session_meta","payload":{"cwd":"/x"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":"hi"}}`;
    expect(detectRuntime(content)).toBe("codex");
  });

  it("detects Codex via session_meta alone", () => {
    const content = `{"type":"session_meta","payload":{"cwd":"/x"}}`;
    expect(detectRuntime(content)).toBe("codex");
  });

  it("detects Claude via top-level user/assistant type", () => {
    const content = `{"type":"customTitle","customTitle":"x","sessionId":"s"}
{"type":"user","message":{"role":"user","content":"hi"},"sessionId":"s"}`;
    expect(detectRuntime(content)).toBe("claude-code");
  });

  it("returns null on empty input", () => {
    expect(detectRuntime("")).toBe(null);
  });

  it("returns null on non-JSONL garbage", () => {
    expect(detectRuntime("hello world\nfoo bar")).toBe(null);
  });

  it("returns null on JSONL with no runtime markers (ambiguous)", () => {
    const content = `{"foo":"bar"}
{"baz":"qux"}`;
    expect(detectRuntime(content)).toBe(null);
  });

  it("does not use file extension or filename — pure content shape", () => {
    // Calling with a string that LOOKS like a filename should still return null.
    expect(detectRuntime("/tmp/fake.jsonl")).toBe(null);
    expect(detectRuntime("rollout-2026-04-23.jsonl")).toBe(null);
  });
});

describe("M2b codex-jsonl-parser", () => {
  it("parses session_meta + response_item messages into StructuredTranscript", () => {
    const content = `{"type":"session_meta","payload":{"cwd":"/Users/wrandom/code/projects/openrig-hub","id":"abc-123"}}
{"type":"response_item","timestamp":"2026-05-02T01:00:00Z","payload":{"type":"message","role":"user","content":"Hello world"}}
{"type":"response_item","timestamp":"2026-05-02T01:00:01Z","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"Hi back"}]}}`;
    const result = parseCodexJsonl(content);
    expect(result.sessionMeta?.cwd).toBe("/Users/wrandom/code/projects/openrig-hub");
    expect(result.sessionMeta?.sessionId).toBe("abc-123");
    expect(result.messageCount).toBe(2);
    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[0]!.text).toBe("Hello world");
    expect(result.messages[1]!.role).toBe("assistant");
    expect(result.messages[1]!.text).toBe("Hi back");
    expect(result.lineCount).toBe(3);
  });

  it("filters reasoning + function_call + custom_tool_call records and counts them", () => {
    const content = `{"type":"response_item","payload":{"type":"reasoning","content":"<thinking>"}}
{"type":"response_item","payload":{"type":"function_call","arguments":"{\\"path\\":\\"/Users/wrandom/x.txt\\"}"}}
{"type":"response_item","payload":{"type":"custom_tool_call","input":"some input"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":"kept"}}`;
    const result = parseCodexJsonl(content);
    expect(result.messageCount).toBe(1);
    expect(result.omittedCounts.reasoning_records).toBeGreaterThanOrEqual(1);
    expect(result.omittedCounts.function_call_output).toBe(1);
    expect(result.omittedCounts.raw_tool_outputs).toBe(1);
  });

  it("counts compacted records separately and skips them from messages", () => {
    const content = `{"type":"compacted","payload":{}}
{"type":"compacted","payload":{}}
{"type":"response_item","payload":{"type":"message","role":"user","content":"msg"}}`;
    const result = parseCodexJsonl(content);
    expect(result.compactedCount).toBe(2);
    expect(result.messageCount).toBe(1);
  });

  it("redacts credential patterns in message content", () => {
    const content = `{"type":"response_item","payload":{"type":"message","role":"user","content":"my token is sk-AbCdEfGhIjKlMnOpQrStUv now"}}`;
    const result = parseCodexJsonl(content);
    expect(result.messages[0]!.text).toContain("[REDACTED]");
    expect(result.messages[0]!.text).not.toContain("sk-AbCdEfGhIjKlMnOpQrStUv");
    expect(result.omittedCounts.redacted_secrets).toBe(1);
  });

  it("skips malformed JSONL lines silently (matches Velocity prior art)", () => {
    const content = `{"type":"response_item","payload":{"type":"message","role":"user","content":"first"}}
not valid json garbage line
{"type":"response_item","payload":{"type":"message","role":"user","content":"second"}}`;
    const result = parseCodexJsonl(content);
    expect(result.messageCount).toBe(2);
    expect(result.lineCount).toBe(3);
  });

  it("extracts paths from message content and tool args; sorts by frequency", () => {
    const content = `{"type":"response_item","payload":{"type":"message","role":"user","content":"see packages/cli/src/index.ts and packages/cli/src/index.ts again"}}
{"type":"response_item","payload":{"type":"function_call","arguments":"{\\"path\\":\\"/Users/wrandom/code/projects/openrig-hub/README.md\\"}"}}`;
    const result = parseCodexJsonl(content);
    expect(result.paths.length).toBeGreaterThan(0);
    const indexEntry = result.paths.find((p) => p.path === "packages/cli/src/index.ts");
    expect(indexEntry?.count).toBeGreaterThanOrEqual(2);
  });
});

describe("M2b claude-transcript-parser", () => {
  it("parses Claude user + assistant messages into StructuredTranscript", () => {
    const content = `{"type":"customTitle","customTitle":"M2b test","sessionId":"sess-1"}
{"type":"user","message":{"role":"user","content":"hello"},"cwd":"/x","sessionId":"sess-1","timestamp":"2026-05-02T01:00:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi back"}]},"cwd":"/x","sessionId":"sess-1","timestamp":"2026-05-02T01:00:01Z"}`;
    const result = parseClaudeTranscript(content);
    expect(result.messageCount).toBe(2);
    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[0]!.text).toBe("hello");
    expect(result.messages[1]!.role).toBe("assistant");
    expect(result.messages[1]!.text).toBe("hi back");
  });

  it("captures sessionMeta from the first record carrying cwd + sessionId", () => {
    const content = `{"type":"customTitle","customTitle":"x","sessionId":"sess-2"}
{"type":"user","message":{"role":"user","content":"first"},"cwd":"/Users/wrandom/code","sessionId":"sess-2"}`;
    const result = parseClaudeTranscript(content);
    expect(result.sessionMeta?.cwd).toBe("/Users/wrandom/code");
    expect(result.sessionMeta?.sessionId).toBe("sess-2");
  });

  it("filters attachments → raw_tool_outputs counter", () => {
    const content = `{"type":"user","message":{"role":"user","content":"see attached"},"cwd":"/x","sessionId":"s"}
{"type":"attachment","attachment":{"path":"/Users/wrandom/x.txt","content":"file body"},"cwd":"/x","sessionId":"s"}`;
    const result = parseClaudeTranscript(content);
    expect(result.messageCount).toBe(1);
    expect(result.omittedCounts.raw_tool_outputs).toBe(1);
  });

  it("redacts credential patterns in message content", () => {
    const content = `{"type":"user","message":{"role":"user","content":"my token is ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0 now"},"cwd":"/x","sessionId":"s"}`;
    const result = parseClaudeTranscript(content);
    expect(result.messages[0]!.text).toContain("[REDACTED]");
    expect(result.omittedCounts.redacted_secrets).toBe(1);
  });

  it("compactedCount is always 0 (Claude transcripts don't emit compaction records)", () => {
    const content = `{"type":"user","message":{"role":"user","content":"x"},"cwd":"/x","sessionId":"s"}`;
    const result = parseClaudeTranscript(content);
    expect(result.compactedCount).toBe(0);
  });

  it("emits the SAME StructuredTranscript shape as the Codex parser (interface conformance)", () => {
    const codex = parseCodexJsonl(`{"type":"response_item","payload":{"type":"message","role":"user","content":"x"}}`);
    const claude = parseClaudeTranscript(`{"type":"user","message":{"role":"user","content":"x"},"cwd":"/x","sessionId":"s"}`);
    // Field-by-field check that both expose the same top-level keys.
    const codexKeys = Object.keys(codex).sort();
    const claudeKeys = Object.keys(claude).sort();
    expect(codexKeys).toEqual(claudeKeys);
    // Both must expose omittedCounts with all 4 enum keys.
    expect(Object.keys(codex.omittedCounts).sort()).toEqual([
      "function_call_output",
      "raw_tool_outputs",
      "reasoning_records",
      "redacted_secrets",
    ]);
    expect(Object.keys(claude.omittedCounts).sort()).toEqual([
      "function_call_output",
      "raw_tool_outputs",
      "reasoning_records",
      "redacted_secrets",
    ]);
  });
});

describe("M2b interaction: parse → redact → omitted-records counter chain", () => {
  it("counts redacted_secrets AND filters all 3 codex omitted classes in one parse", () => {
    const content = `{"type":"session_meta","payload":{"cwd":"/x"}}
{"type":"response_item","payload":{"type":"reasoning"}}
{"type":"response_item","payload":{"type":"function_call","arguments":"{}"}}
{"type":"response_item","payload":{"type":"custom_tool_call","input":"{}"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":"my token sk-AbCdEfGhIjKlMnOpQrSt and more text"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":"clean reply"}}`;
    const result = parseCodexJsonl(content);
    expect(result.messageCount).toBe(2);
    expect(result.omittedCounts.reasoning_records).toBeGreaterThanOrEqual(1);
    expect(result.omittedCounts.function_call_output).toBe(1);
    expect(result.omittedCounts.raw_tool_outputs).toBe(1);
    expect(result.omittedCounts.redacted_secrets).toBe(1);
    // The user message is redacted but kept.
    expect(result.messages[0]!.text).toContain("[REDACTED]");
    // The assistant message is unchanged.
    expect(result.messages[1]!.text).toBe("clean reply");
  });
});

// ─────────────────────────────────────────────────────────────────────
// M2b R2: Claude parser nested tool_use / tool_result handling.
//
// Per guard's M2b BLOCK: the parser silently dropped tool_use parts
// (inside assistant content) and tool_result parts (inside user
// content) without counting them as omitted classes. Real Claude
// transcripts have these on nearly every turn; the previous M2b
// commit produced misleading omittedCounts of all-zero.
//
// R2 fix: walk message.content parts inside kept user/assistant
// records; count tool_use → function_call_output, tool_result →
// raw_tool_outputs; extract paths from omitted parts (mirroring
// Codex parser's behavior at codex-jsonl-parser.ts where function_call
// args + custom_tool_call input are walked for paths even though the
// records themselves are omitted from the message stream).
// ─────────────────────────────────────────────────────────────────────

describe("M2b R2 Claude parser nested-content-part handling", () => {
  it("guard reproducer fixture: tool_use + tool_result both counted; paths extracted", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "pwd" } },
          { type: "text", text: "done" },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    }) + "\n" + JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "/Users/wrandom/code/projects/openrig-hub",
          },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    // Both top-level records are KEPT (the parser still emits the visible
    // text "done" from the assistant turn; the user turn has only
    // tool_result content so no visible text — but the record was
    // classified as kept; without visible text it's dropped from
    // messages but the nested tool_result must STILL be counted.)
    expect(r.omittedCounts.function_call_output).toBe(1);
    expect(r.omittedCounts.raw_tool_outputs).toBe(1);
    expect(r.paths.some((p) => p.path === "/Users/wrandom/code/projects/openrig-hub")).toBe(true);
  });

  it("counts each tool_use part in a multi-tool assistant turn", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          { type: "tool_use", id: "t2", name: "Read", input: { path: "/Users/wrandom/code/x.md" } },
          { type: "text", text: "running both" },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.omittedCounts.function_call_output).toBe(2);
    expect(r.paths.some((p) => p.path === "/Users/wrandom/code/x.md")).toBe(true);
  });

  it("counts each tool_result part in a multi-result user turn", () => {
    // Note: the Velocity-prior-art path pattern is greedy on the
    // /Users/wrandom prefix and includes trailing whitespace and word
    // chars until end-of-line; using \n separators here so each path
    // is matched cleanly.
    const content = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "/Users/wrandom/code/a.md\nrunning" },
          { type: "tool_result", tool_use_id: "t2", content: "/Users/wrandom/code/b.md\nrunning" },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.omittedCounts.raw_tool_outputs).toBe(2);
    expect(r.paths.some((p) => p.path === "/Users/wrandom/code/a.md")).toBe(true);
    expect(r.paths.some((p) => p.path === "/Users/wrandom/code/b.md")).toBe(true);
  });

  it("mixed text + tool_use: visible text kept; tool_use counted", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll run a command:" },
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "pwd" } },
          { type: "text", text: "and report back" },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.messageCount).toBe(1);
    expect(r.messages[0]!.text).toContain("I'll run a command:");
    expect(r.messages[0]!.text).toContain("and report back");
    expect(r.omittedCounts.function_call_output).toBe(1);
  });

  it("tool_use with non-path input: counted but contributes no paths", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "echo hello" } },
          { type: "text", text: "done" },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.omittedCounts.function_call_output).toBe(1);
    // No /Users/wrandom or recognized prefix path in the input.
    expect(r.paths.length).toBe(0);
  });

  it("tool_result with non-path content: counted but contributes no paths", () => {
    const content = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "command exited with status 0" },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.omittedCounts.raw_tool_outputs).toBe(1);
    expect(r.paths.length).toBe(0);
  });

  it("tool_result with array content shape: walks the array for paths", () => {
    // Claude tool_result content can be either a string OR an array of
    // { type: "text", text } parts (the same shape as message content).
    const content = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "found at /Users/wrandom/code/projects/openrig-hub/README.md" },
            ],
          },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.omittedCounts.raw_tool_outputs).toBe(1);
    expect(r.paths.some((p) => p.path === "/Users/wrandom/code/projects/openrig-hub/README.md")).toBe(true);
  });

  it("kept text-only assistant turn (no tools): counters stay at zero", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.messageCount).toBe(1);
    expect(r.omittedCounts.function_call_output).toBe(0);
    expect(r.omittedCounts.raw_tool_outputs).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// M2c-CLI: packet-writer atomic emission + round-trip tests.
//
// packet-writer.ts assembles a v0 restore packet directory atomically:
// writes to a tempdir, validates the resulting restore-summary.json
// against the embedded JSON Schema, then renames tempdir → target.
// On any validation failure, the tempdir is removed; no partial packet
// is left in the operator's filesystem.
//
// Per M1 contract § 1: directory contains 4 required files
// (restore-instructions.md, transcript-latest.md, touched-files.md,
// restore-summary.json) plus optional transcript.md.
// ─────────────────────────────────────────────────────────────────────

describe("M2c-CLI packet-writer atomic emission", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-test-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function buildBaselineOpts(targetDir: string): Record<string, unknown> {
    return {
      targetDir,
      structured: parseCodexJsonl(`{"type":"session_meta","payload":{"cwd":"/Users/wrandom/code/projects/openrig-hub","id":"src-session-id"}}
{"type":"response_item","timestamp":"2026-05-02T01:00:00Z","payload":{"type":"message","role":"user","content":"Walk through the M1 contract"}}
{"type":"response_item","timestamp":"2026-05-02T01:00:01Z","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"Per § 2.1 the schema requires 21 fields"}]}}`),
      sourceRuntime: "codex" as const,
      targetRig: "openrig-velocity-claude",
      targetRuntime: "claude-code" as const,
      targetWorkspaceRoot: "/Users/wrandom/code/projects/openrig-hub",
      defaultTargetRepo: "/Users/wrandom/code/projects/openrig-hub/openrig",
      rolePointer: "rigs/openrig-velocity-claude/state/velocity/driver-role.md",
      currentWorkSummary: "Working on Restore-Packet vertical M2c-CLI chunk.",
      nextOwner: "self",
      caveats: ["Cross-runtime restore from Codex JSONL to Claude Code seat."],
      authorityBoundaries: "May edit packages/cli/ and packages/daemon/ within M2c boundary; no M3+ surfaces.",
      sourceTrustRanking: ["rig_whoami", "bounded_latest_transcript"],
      sourceSessionId: "velocity-driver@openrig-velocity",
      sourceRig: "openrig-velocity",
      sourceCwd: "/Users/wrandom/code/projects/openrig-hub",
      generatorVersion: "rig-restore-packet@0.1.0",
      includeFullTranscript: false,
    };
  }

  it("emits 4 required files + restore-summary.json schema-valid", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const targetDir = path.join(tmpRoot, "packet-1");
    const result = await writePacket(buildBaselineOpts(targetDir) as Parameters<typeof writePacket>[0]);

    expect(result.targetDir).toBe(targetDir);
    for (const required of ["restore-instructions.md", "transcript-latest.md", "touched-files.md", "restore-summary.json"]) {
      expect(fs.existsSync(path.join(targetDir, required)), `missing ${required}`).toBe(true);
    }
    // Optional transcript.md should NOT be present when includeFullTranscript=false.
    expect(fs.existsSync(path.join(targetDir, "transcript.md"))).toBe(false);

    // Summary parses and schema-validates.
    const summary = JSON.parse(fs.readFileSync(path.join(targetDir, "restore-summary.json"), "utf-8"));
    const validation = validateRestoreSummary(summary);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
  });

  it("emits transcript.md when includeFullTranscript=true; full_transcript key present in summary", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const targetDir = path.join(tmpRoot, "packet-full");
    const opts = buildBaselineOpts(targetDir);
    (opts as Record<string, unknown>)["includeFullTranscript"] = true;
    await writePacket(opts as Parameters<typeof writePacket>[0]);

    expect(fs.existsSync(path.join(targetDir, "transcript.md"))).toBe(true);
    const summary = JSON.parse(fs.readFileSync(path.join(targetDir, "restore-summary.json"), "utf-8"));
    expect(summary.full_transcript).toBeDefined();
    expect(typeof summary.full_transcript.path).toBe("string");
    expect(typeof summary.full_transcript.line_count).toBe("number");
  });

  it("populates contract § 2.1 required fields verbatim from operator-supplied options", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const targetDir = path.join(tmpRoot, "packet-fields");
    await writePacket(buildBaselineOpts(targetDir) as Parameters<typeof writePacket>[0]);

    const summary = JSON.parse(fs.readFileSync(path.join(targetDir, "restore-summary.json"), "utf-8"));
    expect(summary.target_rig).toBe("openrig-velocity-claude");
    expect(summary.target_runtime).toBe("claude-code");
    expect(summary.role_pointer).toBe("rigs/openrig-velocity-claude/state/velocity/driver-role.md");
    expect(summary.bounded_latest_transcript.bound).toBe(120);
    expect(summary.redaction_policy_id).toBe("openrig-v0");
    expect(summary.generator_version).toBe("rig-restore-packet@0.1.0");
    expect(summary.source_runtime).toBe("codex");
    expect(summary.source_session_id).toBe("velocity-driver@openrig-velocity");
    expect(Array.isArray(summary.touched_files.top_paths)).toBe(true);
    expect(summary.durable_pointers.queue_pointers).toBeDefined();
    expect(summary.durable_pointers.progress_pointers).toBeDefined();
    expect(summary.durable_pointers.field_note_pointers).toBeDefined();
    expect(summary.durable_pointers.artifact_pointers).toBeDefined();
  });

  it("rejects when target directory already exists", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const targetDir = path.join(tmpRoot, "preexisting");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, "marker.txt"), "do not overwrite");

    const opts = buildBaselineOpts(targetDir) as Parameters<typeof writePacket>[0];
    await expect(writePacket(opts)).rejects.toThrow(/exists|already/i);
    // Marker preserved (no partial overwrite).
    expect(fs.readFileSync(path.join(targetDir, "marker.txt"), "utf-8")).toBe("do not overwrite");
  });

  it("atomic emission: schema-validation failure mid-write leaves NO target dir AND cleans tempdir", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const targetDir = path.join(tmpRoot, "packet-fail");
    const opts = buildBaselineOpts(targetDir) as Record<string, unknown>;
    // Inject a contract violation: empty current_work_summary should fail
    // schema validation (minLength: 1).
    opts["currentWorkSummary"] = "";

    await expect(
      writePacket(opts as Parameters<typeof writePacket>[0]),
    ).rejects.toThrow(/schema|valid|current_work_summary/i);

    // Target dir was NEVER created (atomic rename semantics).
    expect(fs.existsSync(targetDir)).toBe(false);
    // No leftover .tmp- prefixed dirs in tmpRoot.
    const tmpRootContents = fs.readdirSync(tmpRoot);
    const leftovers = tmpRootContents.filter((name) => name.includes(".tmp-restore-packet-"));
    expect(leftovers).toEqual([]);
  });

  it("transcript-latest.md bounded at 120 messages; message_count reflects actual count", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");

    // Build 150 user messages (exceeds the 120 bound).
    const lines: string[] = [`{"type":"session_meta","payload":{"cwd":"/x"}}`];
    for (let i = 0; i < 150; i++) {
      lines.push(`{"type":"response_item","payload":{"type":"message","role":"user","content":"msg ${i}"}}`);
    }
    const opts = buildBaselineOpts(path.join(tmpRoot, "packet-bound")) as Record<string, unknown>;
    opts["structured"] = parseCodexJsonl(lines.join("\n"));
    await writePacket(opts as Parameters<typeof writePacket>[0]);

    const summary = JSON.parse(fs.readFileSync(path.join(tmpRoot, "packet-bound", "restore-summary.json"), "utf-8"));
    expect(summary.bounded_latest_transcript.bound).toBe(120);
    expect(summary.bounded_latest_transcript.message_count).toBe(120);

    // Latest transcript file contains exactly 120 sectioned messages.
    const latest = fs.readFileSync(path.join(tmpRoot, "packet-bound", "transcript-latest.md"), "utf-8");
    const sectionCount = (latest.match(/^## \d+\. /gm) ?? []).length;
    expect(sectionCount).toBe(120);
  });
});

describe("M2c-CLI Velocity-shape round-trip (synthetic 4-role fixtures)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-rt-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Build a synthetic Codex JSONL with the same structural shape as
  // Velocity prior art: session_meta + response_item messages + tool_calls
  // + reasoning records + a credential-pattern needle for redaction.
  function syntheticCodexJsonlFor(role: string): string {
    return [
      `{"type":"session_meta","payload":{"cwd":"/Users/wrandom/code/projects/openrig-hub","id":"velocity-${role}@openrig-velocity-code"}}`,
      `{"type":"response_item","payload":{"type":"reasoning","content":"<thinking>"}}`,
      `{"type":"response_item","payload":{"type":"function_call","arguments":"{\\"path\\":\\"packages/cli/src/index.ts\\"}"}}`,
      `{"type":"response_item","timestamp":"2026-04-23T18:08:00Z","payload":{"type":"message","role":"user","content":"${role}: please review the diff"}}`,
      `{"type":"response_item","timestamp":"2026-04-23T18:08:30Z","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"${role}: token sk-FakeAbCdEfGhIjKlMn was visible in logs"}]}}`,
      `{"type":"compacted","payload":{}}`,
    ].join("\n");
  }

  for (const role of ["driver", "guard", "planner", "tester"]) {
    it(`Velocity-shape ${role} round-trip: parser → packet-writer → schema-valid; counts + redaction preserved`, async () => {
      const { writePacket } = await import("../src/restore-packet/packet-writer.js");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const structured = parseCodexJsonl(syntheticCodexJsonlFor(role));

      // Sanity-check parser output before writer round-trip.
      expect(structured.messageCount).toBe(2);
      expect(structured.compactedCount).toBe(1);
      expect(structured.omittedCounts.reasoning_records).toBeGreaterThanOrEqual(1);
      expect(structured.omittedCounts.function_call_output).toBe(1);
      expect(structured.omittedCounts.redacted_secrets).toBe(1);

      const targetDir = path.join(tmpRoot, `packet-${role}`);
      await writePacket({
        targetDir,
        structured,
        sourceRuntime: "codex",
        targetRig: "openrig-velocity-claude",
        targetRuntime: "claude-code",
        targetWorkspaceRoot: "/Users/wrandom/code/projects/openrig-hub",
        defaultTargetRepo: "/Users/wrandom/code/projects/openrig-hub/openrig",
        rolePointer: `rigs/openrig-velocity-claude/state/velocity/${role}-role.md`,
        currentWorkSummary: `Synthetic ${role} round-trip for Velocity-shape parity.`,
        nextOwner: "self",
        caveats: [],
        authorityBoundaries: `${role} authority for Velocity-replay context.`,
        sourceTrustRanking: ["rig_whoami", "bounded_latest_transcript"],
        sourceSessionId: `velocity-${role}@openrig-velocity-code`,
        sourceRig: "openrig-velocity-code",
        sourceCwd: "/Users/wrandom/code/projects/openrig-hub",
        generatorVersion: "rig-restore-packet@0.1.0",
        includeFullTranscript: true,
      });

      const summary = JSON.parse(fs.readFileSync(path.join(targetDir, "restore-summary.json"), "utf-8"));
      const validation = validateRestoreSummary(summary);
      expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
      // Provenance preserved at relevant fields:
      expect(summary.source_session_id).toBe(`velocity-${role}@openrig-velocity-code`);
      expect(summary.source_cwd).toBe("/Users/wrandom/code/projects/openrig-hub");
      expect(summary.bounded_latest_transcript.message_count).toBe(2);
      // Omitted-class enumeration matches what the parser counted:
      expect(summary.omitted_classes).toContain("reasoning_records");
      expect(summary.omitted_classes).toContain("function_call_output");
      expect(summary.omitted_classes).toContain("redacted_secrets");
      // Redacted output: assistant's "sk-FakeAbCdEfGhIjKlMn" must NOT appear in transcript.md.
      const fullT = fs.readFileSync(path.join(targetDir, "transcript.md"), "utf-8");
      expect(fullT).not.toContain("sk-FakeAbCdEfGhIjKlMn");
      expect(fullT).toContain("[REDACTED]");
    });
  }
});

describe("M2c-CLI redaction + omitted-record round-trip end-to-end", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-er-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("mock-daemon --source-session round-trip writes packet and forwards no mutation", async () => {
    const { restorePacketCommand } = await import("../src/commands/restore-packet.js");
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");

    const requestedPaths: string[] = [];
    const mutationMethods = {
      post: vi.fn(async () => { throw new Error("mock-daemon: post should not be called by restore-packet write"); }),
      delete: vi.fn(async () => { throw new Error("mock-daemon: delete should not be called by restore-packet write"); }),
      postText: vi.fn(async () => { throw new Error("mock-daemon: postText should not be called"); }),
      postExpectText: vi.fn(async () => { throw new Error("mock-daemon: postExpectText should not be called"); }),
    };
    // Synthetic Codex JSONL the mock-daemon serves on the new full-read route.
    const fixtureContent = `{"type":"session_meta","payload":{"cwd":"/Users/wrandom/code/x","id":"src-session"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":"hello from session"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"reply"}]}}`;

    const deps = {
      lifecycleDeps: {} as Parameters<typeof restorePacketCommand>[0] extends undefined ? never : NonNullable<Parameters<typeof restorePacketCommand>[0]>["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (p: string) => {
          requestedPaths.push(p);
          if (p === "/api/transcripts/src-session/full") {
            return { status: 200, data: { content: fixtureContent, cwd: "/Users/wrandom/code/x" } };
          }
          return { status: 404, data: { error: "not found" } };
        }),
        getText: vi.fn(async () => ({ status: 200, data: "" })),
        ...mutationMethods,
      }),
    };

    const targetDir = path.join(tmpRoot, "via-daemon");
    const program = createProgram({ restorePacketDeps: deps as unknown as Parameters<typeof createProgram>[0]["restorePacketDeps"] });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-session", "src-session",
      "--target", targetDir,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      // src-session is bare (no @); operator must supply --source-rig-override
      // per R2 honest-fallback policy.
      "--source-rig-override", "openrig-test",
      "--current-work-summary", "mock-daemon round-trip with bare session id + rig override.",
      "--authority-boundaries", "test-only.",
    ]);

    // Daemon was queried at the new full-read route; no mutation methods called.
    expect(requestedPaths).toContain("/api/transcripts/src-session/full");
    expect(mutationMethods.post).not.toHaveBeenCalled();
    expect(mutationMethods.delete).not.toHaveBeenCalled();
    // Packet emitted.
    expect(fs.existsSync(targetDir)).toBe(true);
    const summary = JSON.parse(fs.readFileSync(path.join(targetDir, "restore-summary.json"), "utf-8"));
    const validation = validateRestoreSummary(summary);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
    expect(summary.source_session_id).toBe("src-session");
    // R2: operator-supplied --source-rig-override is honored.
    expect(summary.source_rig).toBe("openrig-test");
  });

  it("M2b R2 nested Claude content fixture: round-trips with non-zero omittedCounts in summary", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const content = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "pwd" } },
          { type: "text", text: "checking now" },
        ],
      },
      cwd: "/Users/wrandom/code/projects/openrig-hub",
      sessionId: "claude-session-id",
    }) + "\n" + JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "/Users/wrandom/code/projects/openrig-hub" },
        ],
      },
      cwd: "/Users/wrandom/code/projects/openrig-hub",
      sessionId: "claude-session-id",
    });
    const structured = parseClaudeTranscript(content);

    const targetDir = path.join(tmpRoot, "claude-nested");
    await writePacket({
      targetDir,
      structured,
      sourceRuntime: "claude-code",
      targetRig: "openrig-velocity-claude",
      targetRuntime: "claude-code",
      targetWorkspaceRoot: "/Users/wrandom/code/projects/openrig-hub",
      defaultTargetRepo: null,
      rolePointer: "rigs/openrig-velocity-claude/state/velocity/driver-role.md",
      currentWorkSummary: "Nested-content round-trip for M2c-CLI.",
      nextOwner: "self",
      caveats: [],
      authorityBoundaries: "Velocity authority.",
      sourceTrustRanking: ["rig_whoami"],
      sourceSessionId: "claude-session-id",
      sourceRig: "openrig-velocity-claude",
      sourceCwd: "/Users/wrandom/code/projects/openrig-hub",
      generatorVersion: "rig-restore-packet@0.1.0",
      includeFullTranscript: false,
    });

    const summary = JSON.parse(fs.readFileSync(path.join(targetDir, "restore-summary.json"), "utf-8"));
    expect(summary.omitted_classes).toContain("function_call_output");
    expect(summary.omitted_classes).toContain("raw_tool_outputs");
    // Touched-files inventory captured the path from the omitted tool_result.
    expect(summary.touched_files.top_paths.some((p: { path: string }) =>
      p.path === "/Users/wrandom/code/projects/openrig-hub")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// M2c-CLI R2 — `--source-jsonl` provenance fix.
//
// Guard BLOCKED M2c-CLI at openrig e5de3ab because the `--source-jsonl`
// adapter wrote the JSONL FILE PATH into `restore-summary.json.source_session_id`
// and forced `source_rig: "unknown"`, EVEN WHEN the parsed Codex JSONL had
// `session_meta.payload.id = "<seat>@<rig>"` available.
//
// These tests exercise the CLI command surface end-to-end (Quality Lesson
// v12 candidate) — they parseAsync through createProgram() against synthetic
// JSONL fixtures with realistic session_meta records, so the bug between
// parse and writePacket call IS exercised. Writer-internal tests bypass
// this path by passing manually-constructed sourceSessionId.
// ─────────────────────────────────────────────────────────────────────

describe("M2c-CLI R2 --source-jsonl provenance from parsed session_meta", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-r2-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // The exact reproducer fixture from the guard's BLOCK artifact.
  function jsonlWithSessionMeta(): string {
    return [
      JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: "/Users/wrandom/code/projects/openrig-hub",
          id: "velocity-driver@openrig-velocity",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "hello direct source",
        },
      }),
    ].join("\n");
  }

  function jsonlWithoutSessionMeta(): string {
    return [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "no session_meta in this JSONL",
        },
      }),
    ].join("\n");
  }

  function jsonlWithBareSessionMetaId(): string {
    // session_meta exists but the id is a bare token, not <seat>@<rig> shape.
    return [
      JSON.stringify({
        type: "session_meta",
        payload: { cwd: "/x", id: "bare-id-no-at" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: "hi" },
      }),
    ].join("\n");
  }

  it("guard reproducer: --source-jsonl with session_meta sets source_session_id from parsed id and source_rig from <seat>@<rig> split", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.join(tmpRoot, "source.jsonl");
    fs.writeFileSync(src, jsonlWithSessionMeta(), "utf8");
    const target = path.join(tmpRoot, "packet");

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-jsonl", src,
      "--target", target,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      "--current-work-summary", "R2 guard reproducer: provenance from parsed session_meta.",
      "--authority-boundaries", "R2 provenance check only.",
    ]);

    expect(fs.existsSync(target)).toBe(true);
    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    const validation = validateRestoreSummary(summary);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
    // Bug reproducer's expected values per BLOCK artifact:
    expect(summary.source_session_id).toBe("velocity-driver@openrig-velocity");
    expect(summary.source_rig).toBe("openrig-velocity");
    expect(summary.source_cwd).toBe("/Users/wrandom/code/projects/openrig-hub");
    // session_session_id MUST NOT be the file path.
    expect(summary.source_session_id).not.toContain("/source.jsonl");
    expect(summary.source_session_id).not.toContain(tmpRoot);
    // transcript.md emitted (messageCount > 0 → includeFullTranscript true).
    expect(fs.existsSync(path.join(target, "transcript.md"))).toBe(true);
  });

  it("--source-jsonl with NO session_meta and NO override flags fails with explicit guidance", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.join(tmpRoot, "no-session.jsonl");
    fs.writeFileSync(src, jsonlWithoutSessionMeta(), "utf8");
    const target = path.join(tmpRoot, "packet-no-session");

    const stderr: string[] = [];
    const origConsoleError = console.error;
    const origExitCode = process.exitCode;
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    process.exitCode = undefined;
    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "restore-packet", "write",
        "--source-jsonl", src,
        "--target", target,
        "--target-rig", "openrig-velocity-claude",
        "--target-runtime", "claude-code",
        "--current-work-summary", "no-session-meta error path.",
        "--authority-boundaries", "R2 provenance check only.",
      ]);
    } finally {
      console.error = origConsoleError;
    }
    expect(process.exitCode).not.toBe(0);
    process.exitCode = origExitCode;
    const errStr = stderr.join("\n");
    expect(errStr).toMatch(/session.meta|--source-session-id-override|--source-rig-override|provenance/i);
    // No partial packet written.
    expect(fs.existsSync(target)).toBe(false);
  });

  it("--source-jsonl with NO session_meta + both overrides succeeds with overridden provenance", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.join(tmpRoot, "no-session-with-overrides.jsonl");
    fs.writeFileSync(src, jsonlWithoutSessionMeta(), "utf8");
    const target = path.join(tmpRoot, "packet-overrides");

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-jsonl", src,
      "--target", target,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      "--source-session-id-override", "manual-driver@manual-rig",
      "--source-rig-override", "manual-rig",
      "--current-work-summary", "override path; honest provenance.",
      "--authority-boundaries", "R2 override path.",
    ]);

    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    expect(summary.source_session_id).toBe("manual-driver@manual-rig");
    expect(summary.source_rig).toBe("manual-rig");
    const validation = validateRestoreSummary(summary);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
  });

  it("--source-jsonl with bare-id session_meta fails without --source-rig-override (no silent unknown)", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.join(tmpRoot, "bare-id.jsonl");
    fs.writeFileSync(src, jsonlWithBareSessionMetaId(), "utf8");
    const target = path.join(tmpRoot, "packet-bare");

    const stderr: string[] = [];
    const origConsoleError = console.error;
    const origExitCode = process.exitCode;
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    process.exitCode = undefined;
    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "restore-packet", "write",
        "--source-jsonl", src,
        "--target", target,
        "--target-rig", "openrig-velocity-claude",
        "--target-runtime", "claude-code",
        "--current-work-summary", "bare-id no-rig-override path.",
        "--authority-boundaries", "R2 honest fallback.",
      ]);
    } finally {
      console.error = origConsoleError;
    }
    expect(process.exitCode).not.toBe(0);
    process.exitCode = origExitCode;
    const errStr = stderr.join("\n");
    expect(errStr).toMatch(/source.rig|--source-rig-override|<seat>@<rig>|derive/i);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("--source-jsonl with --source-session-id-override overrides parsed session_meta id", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    // JSONL has session_meta.id = velocity-driver@openrig-velocity
    const src = path.join(tmpRoot, "override-wins.jsonl");
    fs.writeFileSync(src, jsonlWithSessionMeta(), "utf8");
    const target = path.join(tmpRoot, "packet-override-wins");

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-jsonl", src,
      "--target", target,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      "--source-session-id-override", "operator-renamed@operator-rig",
      "--source-rig-override", "operator-rig",
      "--current-work-summary", "override-wins path.",
      "--authority-boundaries", "operator-supplied provenance.",
    ]);

    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    expect(summary.source_session_id).toBe("operator-renamed@operator-rig");
    expect(summary.source_rig).toBe("operator-rig");
  });
});

// ─────────────────────────────────────────────────────────────────────
// M2c-Daemon final M2 regression — Velocity 4-pack round-trip via CLI.
//
// Per dispatch qitem-20260502020626-8cd2b7a6 (item 4): load each of the
// four Velocity prior-art role packets, locate their original Codex
// JSONL, run --source-jsonl through the v0 generator, and assert
// provenance fields preserved + schema valid + redaction policy applied.
//
// Tests are gated on file presence: the original JSONL files live in
// ~/.codex/sessions/2026/04/23/ on the host. When absent (other devs /
// CI), the cases skip with a guard message — the synthetic Velocity
// round-trip describe above already exercises the structural shape; this
// suite adds REAL data validation when available (dispatch-condition).
// ─────────────────────────────────────────────────────────────────────

describe("M2c-Daemon final regression — Velocity 4-pack round-trip via CLI", () => {
  let tmpRoot: string;
  const VELOCITY_ROOT = "/Users/wrandom/code/substrate/shared-docs/openrig-work/field-notes/2026-04-27-velocity-claude-from-codex-restore";

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-velocity-cli-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  for (const role of ["driver", "guard", "planner", "tester"]) {
    it(`Velocity ${role} packet: --source-jsonl round-trip yields v0 packet with preserved provenance`, async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const refSummaryPath = path.join(VELOCITY_ROOT, role, "restore-summary.json");
      if (!fs.existsSync(refSummaryPath)) {
        console.warn(`SKIP: Velocity reference packet absent at ${refSummaryPath}`);
        return;
      }
      const refSummary = JSON.parse(fs.readFileSync(refSummaryPath, "utf-8")) as {
        source_jsonl?: string;
        source_session?: string;
        source_cwd?: string;
      };
      const sourceJsonl = refSummary.source_jsonl ?? "";
      if (!sourceJsonl || !fs.existsSync(sourceJsonl)) {
        console.warn(`SKIP: Velocity ${role} source JSONL absent at ${sourceJsonl}`);
        return;
      }

      const { createProgram } = await import("../src/index.js");
      const target = path.join(tmpRoot, `packet-${role}`);

      // Codex JSONL session_meta carries a UUID-shaped rollout id, not a
      // <seat>@<rig> name. The Velocity prior-art .mjs got the canonical
      // name from a CLI arg; for the v0 round-trip we mirror that by
      // passing --source-session-id-override + --source-rig-override
      // matching the reference packet's source_session value.
      const canonicalSessionId = refSummary.source_session ?? "";
      const canonicalRig = canonicalSessionId.split("@")[1] ?? "openrig-velocity-code";

      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "restore-packet", "write",
        "--source-jsonl", sourceJsonl,
        "--target", target,
        "--target-rig", "openrig-velocity-claude",
        "--target-runtime", "claude-code",
        "--source-session-id-override", canonicalSessionId,
        "--source-rig-override", canonicalRig,
        "--current-work-summary", `Velocity ${role} round-trip via M2c-Daemon final regression.`,
        "--authority-boundaries", `Restored ${role} authority for Velocity-replay context.`,
      ]);

      // v0 packet structure check.
      expect(fs.existsSync(target)).toBe(true);
      const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
      const validation = validateRestoreSummary(summary);
      expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);

      // Provenance fields preserved (Velocity prior-art -> v0 mapping).
      expect(summary.source_session_id).toBe(refSummary.source_session);
      // source_rig derived from <seat>@<rig> split of source_session.
      const expectedRig = refSummary.source_session?.split("@")[1];
      expect(summary.source_rig).toBe(expectedRig);
      expect(summary.source_cwd).toBe(refSummary.source_cwd);

      // Redaction policy applied.
      expect(summary.redaction_policy_id).toBe("openrig-v0");

      // Omitted-record counts are reasonable (Velocity packets should have
      // many reasoning_records and function_call_output records since they
      // were generated from full Codex sessions).
      expect(Array.isArray(summary.omitted_classes)).toBe(true);
      expect(summary.omitted_classes.length).toBeGreaterThan(0);

      // bounded_latest_transcript file was written.
      expect(fs.existsSync(path.join(target, "transcript-latest.md"))).toBe(true);
    }, 90000); // Velocity JSONLs are 22-37MB; allow generous timeout.
  }
});

// ─────────────────────────────────────────────────────────────────────
// M2c-Daemon final M2 regression — CLI-surface redaction + omitted
// round-trips. Per dispatch items 7 + 8: exercise the parse-to-write
// path through createProgram() (Quality Lesson v12 carry-forward) for
// (a) credential-pattern redaction via --source-jsonl, (b) M2b R2
// nested-content omitted-record counting (Quality Lesson v11
// carry-forward).
// ─────────────────────────────────────────────────────────────────────

describe("M2c-Daemon final regression — CLI-surface redaction + omitted round-trips", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-final-cli-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("--source-jsonl with credential-pattern fixture: emitted transcript is redacted at the wire", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    // Synthetic credentials. NOT real tokens. Per Quality Lesson v9.
    const src = path.join(tmpRoot, "with-creds.jsonl");
    fs.writeFileSync(src, [
      JSON.stringify({
        type: "session_meta",
        payload: { cwd: "/x", id: "creds-driver@creds-rig" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "saw token sk-FakeAbCdEfGhIjKlMnOpQr in logs" }],
        },
      }),
    ].join("\n"), "utf8");

    const target = path.join(tmpRoot, "packet-creds");
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-jsonl", src,
      "--target", target,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      "--current-work-summary", "redaction CLI round-trip.",
      "--authority-boundaries", "redaction proof.",
    ]);

    const transcriptLatest = fs.readFileSync(path.join(target, "transcript-latest.md"), "utf-8");
    expect(transcriptLatest).not.toContain("sk-FakeAbCdEfGhIjKlMnOpQr");
    expect(transcriptLatest).toContain("[REDACTED]");

    // Summary's omitted_classes records the redaction occurrence.
    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    expect(summary.omitted_classes).toContain("redacted_secrets");
    expect(summary.redaction_policy_id).toBe("openrig-v0");
  });

  it("--source-jsonl with M2b R2 nested Claude content (tool_use + tool_result): omitted counts populated via CLI surface", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    // Claude transcript with nested tool_use + tool_result inside top-level
    // assistant/user records (the M2b R2 reproducer shape per Quality
    // Lesson v11 carry-forward).
    const src = path.join(tmpRoot, "claude-nested.jsonl");
    fs.writeFileSync(src, [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "pwd" } },
            { type: "text", text: "checking now" },
          ],
        },
        cwd: "/Users/wrandom/code/projects/openrig-hub",
        sessionId: "claude-final@openrig-velocity-claude",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "/Users/wrandom/code/projects/openrig-hub" },
          ],
        },
        cwd: "/Users/wrandom/code/projects/openrig-hub",
        sessionId: "claude-final@openrig-velocity-claude",
      }),
    ].join("\n"), "utf8");

    const target = path.join(tmpRoot, "packet-claude-nested");
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-jsonl", src,
      "--target", target,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      "--source-runtime", "claude-code",
      "--current-work-summary", "M2b R2 nested-content via CLI surface.",
      "--authority-boundaries", "Quality Lesson v11 carry-forward.",
    ]);

    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    const validation = validateRestoreSummary(summary);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
    expect(summary.omitted_classes).toContain("function_call_output");
    expect(summary.omitted_classes).toContain("raw_tool_outputs");
    // Provenance from session_meta-equivalent (Claude per-record sessionId).
    expect(summary.source_session_id).toBe("claude-final@openrig-velocity-claude");
    expect(summary.source_rig).toBe("openrig-velocity-claude");
    expect(summary.source_cwd).toBe("/Users/wrandom/code/projects/openrig-hub");
    // Touched-files inventory captured the path from the omitted tool_result.
    expect(summary.touched_files.top_paths.some((p: { path: string }) =>
      p.path === "/Users/wrandom/code/projects/openrig-hub")).toBe(true);
  });
});
