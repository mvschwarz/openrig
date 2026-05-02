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

import { describe, it, expect } from "vitest";
import { Command } from "commander";
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
