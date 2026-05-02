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
import {
  validateRestoreSummary,
  type ValidationResult,
} from "../src/restore-packet/schema-validator.js";
import { restorePacketCommand } from "../src/commands/restore-packet.js";

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
