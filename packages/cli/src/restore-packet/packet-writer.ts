// packet-writer.ts — assembles + atomically writes a v0 restore packet
// directory.
//
// Per M1 contract § 1: emits 4 required files (restore-instructions.md,
// transcript-latest.md, touched-files.md, restore-summary.json) plus
// optional transcript.md (when full transcript material is available;
// presence in lockstep with `full_transcript` summary key).
//
// Atomic emission via tempdir-then-rename:
// 1. Write all files into a sibling tempdir (`<targetDir>.tmp-<rand>/`).
// 2. Validate the tempdir's restore-summary.json against the embedded
//    JSON Schema (RESTORE_SUMMARY_SCHEMA from schema-validator.ts).
// 3. If valid: rename tempdir → targetDir (single fs.rename; atomic on
//    same filesystem).
// 4. If validation fails OR any write step fails: rmSync the tempdir;
//    propagate the error. The targetDir is NEVER created in this case.
//
// Pre-condition: targetDir MUST NOT exist (operator must supply a fresh
// path). Reject with explicit error otherwise.

import { mkdirSync, writeFileSync, existsSync, renameSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import {
  validateRestoreSummary,
  type ValidationResult,
} from "./schema-validator.js";
import type { StructuredTranscript, SourceRuntime } from "./types.js";

const TRANSCRIPT_BOUND = 120;

export interface WritePacketOptions {
  /** Absolute path of the target packet directory. MUST NOT exist. */
  targetDir: string;
  /** Parsed source structured representation. */
  structured: StructuredTranscript;
  /** Runtime kind of the source seat. */
  sourceRuntime: SourceRuntime;
  /** Target rig name (operator-supplied). */
  targetRig: string;
  /** Target runtime kind (operator-supplied). */
  targetRuntime: SourceRuntime;
  /** Target workspace root (absolute path). */
  targetWorkspaceRoot: string;
  /** Default target repo (absolute path or null). */
  defaultTargetRepo: string | null;
  /** Path/URI to role guidance for the restored seat. */
  rolePointer: string;
  /** One-paragraph human-readable summary of current work. */
  currentWorkSummary: string;
  /** Who the restored seat hands off to next; "self" if continuing. */
  nextOwner: string;
  /** Caveats list (cross-runtime quirks, redaction notes, etc.). */
  caveats: string[];
  /** Explicit statement of restored-seat authority. */
  authorityBoundaries: string;
  /** Ordered source-trust ranking (subset of contract enum). */
  sourceTrustRanking: string[];
  /** Source session id. */
  sourceSessionId: string;
  /** Source cwd (absolute path). */
  sourceCwd: string;
  /** Generator version identifier (e.g., "rig-restore-packet@0.1.0"). */
  generatorVersion: string;
  /** Whether to include the full transcript.md file. */
  includeFullTranscript: boolean;
}

export interface WritePacketResult {
  targetDir: string;
  files: string[];
  summaryPath: string;
}

function transcriptMarkdownFromMessages(
  title: string,
  session: string,
  messages: StructuredTranscript["messages"],
  note: string,
): string {
  const body = messages
    .map((m, i) => {
      const ts = m.timestamp ? ` ${m.timestamp}` : "";
      return `## ${i + 1}. ${m.role}${ts}\n\n${m.text}\n`;
    })
    .join("\n");
  return `# ${title}\n\nSource session: \`${session}\`\n\n${note}\n\n${body}`;
}

function buildTranscriptLatest(
  structured: StructuredTranscript,
  sourceSessionId: string,
): string {
  const latest = structured.messages.slice(-TRANSCRIPT_BOUND);
  return transcriptMarkdownFromMessages(
    "Bounded Latest Transcript",
    sourceSessionId,
    latest,
    `This bounded transcript contains the latest ${latest.length} extracted messages for normal restore. Use transcript.md only when deeper forensic recovery is needed.`,
  );
}

function buildTranscriptFull(
  structured: StructuredTranscript,
  sourceSessionId: string,
): string {
  return transcriptMarkdownFromMessages(
    "Full Transcript",
    sourceSessionId,
    structured.messages,
    "This transcript contains developer/user/assistant messages extracted from the source. Reasoning records, tool calls, and tool outputs are omitted by design (see restore-summary.json `omitted_classes`).",
  );
}

function buildTouchedFiles(structured: StructuredTranscript): string {
  const rows = structured.paths.length > 0
    ? structured.paths.map((entry) => `- \`${entry.path}\` (${entry.count})`).join("\n")
    : "- No paths detected in extracted messages or tool arguments.";
  return `# Touched Files And Path Inventory\n\nBest-effort path inventory from messages and tool arguments. This is a triage aid, not a complete proof of all files read or written.\n\n${rows}\n`;
}

function buildRestoreInstructions(opts: WritePacketOptions): string {
  return `# Restore Instructions

You are a restored seat in \`${opts.targetRig}\`. This packet records the cross-runtime context for resuming work from \`${opts.sourceSessionId}\`.

## Identity

1. Run \`rig whoami --json\`.
2. Trust the current rig identity over the source-session transcript.
3. Current workspace root: \`${opts.targetWorkspaceRoot}\`.
4. Default target repo: \`${opts.defaultTargetRepo ?? "(none)"}\`.
5. Role guidance pointer: \`${opts.rolePointer}\`.

## Restore Steps

1. Read this file.
2. Read \`touched-files.md\`.
3. Read \`transcript-latest.md\` for bounded current context.
4. Use \`transcript.md\` only if the bounded transcript is insufficient.
5. State: "restored from packet generated by ${opts.generatorVersion}; current rig is ${opts.targetRig}; default target repo is ${opts.defaultTargetRepo ?? "none"}."
6. Name any caveats before resuming work.
7. Hand off to next owner: \`${opts.nextOwner}\` (or "self" to continue).

## Current Work

${opts.currentWorkSummary}

## Authority Boundaries

${opts.authorityBoundaries}

## Caveats

${opts.caveats.length > 0 ? opts.caveats.map((c) => `- ${c}`).join("\n") : "- (none recorded)"}

## Packet Stats

- Source runtime: \`${opts.sourceRuntime}\`
- Target runtime: \`${opts.targetRuntime}\`
- JSONL/transcript lines processed: ${opts.structured.lineCount}
- Extracted messages: ${opts.structured.messageCount}
- Compaction records: ${opts.structured.compactedCount}
- Source cwd: \`${opts.sourceCwd}\`
`;
}

function buildSummary(opts: WritePacketOptions): Record<string, unknown> {
  const omittedClassesActive: string[] = [];
  for (const k of ["reasoning_records", "raw_tool_outputs", "function_call_output", "redacted_secrets"] as const) {
    if (opts.structured.omittedCounts[k] > 0) omittedClassesActive.push(k);
  }
  const messageCount = Math.min(opts.structured.messages.length, TRANSCRIPT_BOUND);
  const summary: Record<string, unknown> = {
    source_session_id: opts.sourceSessionId,
    source_rig: opts.sourceSessionId.includes("@") ? opts.sourceSessionId.split("@")[1] ?? "unknown" : "unknown",
    source_runtime: opts.sourceRuntime,
    source_cwd: opts.sourceCwd,
    target_rig: opts.targetRig,
    target_runtime: opts.targetRuntime,
    target_workspace_root: opts.targetWorkspaceRoot,
    default_target_repo: opts.defaultTargetRepo,
    role_pointer: opts.rolePointer,
    bounded_latest_transcript: {
      path: "transcript-latest.md",
      message_count: messageCount,
      bound: TRANSCRIPT_BOUND,
    },
    touched_files: {
      path: "touched-files.md",
      top_paths: opts.structured.paths.slice(0, 30),
    },
    durable_pointers: {
      queue_pointers: [],
      progress_pointers: [],
      field_note_pointers: [],
      artifact_pointers: [],
    },
    current_work_summary: opts.currentWorkSummary,
    next_owner: opts.nextOwner,
    caveats: opts.caveats,
    authority_boundaries: opts.authorityBoundaries,
    omitted_classes: omittedClassesActive,
    redaction_policy_id: "openrig-v0",
    source_trust_ranking: opts.sourceTrustRanking,
    generator_version: opts.generatorVersion,
    generated_at: new Date().toISOString(),
  };
  if (opts.includeFullTranscript) {
    summary.full_transcript = {
      path: "transcript.md",
      line_count: opts.structured.messages.length,
    };
  }
  return summary;
}

/**
 * Write a v0 restore packet directory atomically.
 *
 * Atomic guarantee: if any step fails (including schema validation of
 * restore-summary.json), the targetDir is never created and any
 * intermediate tempdir is removed. Operators see either a complete
 * valid packet at targetDir, or no packet at all.
 */
export async function writePacket(opts: WritePacketOptions): Promise<WritePacketResult> {
  if (existsSync(opts.targetDir)) {
    throw new Error(`restore-packet write: target directory already exists: ${opts.targetDir}`);
  }

  // Build all file contents BEFORE creating any disk state. This way if
  // an in-memory step throws (unlikely, but defensive), no tempdir was
  // created.
  const summary = buildSummary(opts);
  const validation: ValidationResult = validateRestoreSummary(summary);
  if (!validation.valid) {
    const errSummary = validation.errors
      .slice(0, 5)
      .map((e) => `${e.field}: ${e.rule}`)
      .join("; ");
    throw new Error(
      `restore-packet write: schema validation failed before atomic rename: ${errSummary}`,
    );
  }

  const restoreInstructions = buildRestoreInstructions(opts);
  const transcriptLatest = buildTranscriptLatest(opts.structured, opts.sourceSessionId);
  const touchedFiles = buildTouchedFiles(opts.structured);
  const transcriptFull = opts.includeFullTranscript
    ? buildTranscriptFull(opts.structured, opts.sourceSessionId)
    : null;

  // Create tempdir as a sibling of targetDir using mkdtemp for race-free
  // unique name. The dirname() must exist and be writable; we don't
  // mkdir the parent for the operator (operator authority bedrock).
  const parentDir = dirname(opts.targetDir);
  const tempPrefix = `${basename(opts.targetDir)}.tmp-restore-packet-`;
  const tempDir = mkdtempSync(join(parentDir, tempPrefix));

  try {
    writeFileSync(join(tempDir, "restore-instructions.md"), restoreInstructions, "utf-8");
    writeFileSync(join(tempDir, "transcript-latest.md"), transcriptLatest, "utf-8");
    writeFileSync(join(tempDir, "touched-files.md"), touchedFiles, "utf-8");
    writeFileSync(join(tempDir, "restore-summary.json"), JSON.stringify(summary, null, 2), "utf-8");
    if (transcriptFull !== null) {
      writeFileSync(join(tempDir, "transcript.md"), transcriptFull, "utf-8");
    }

    // Re-validate by parsing the on-disk summary (round-trip self-check).
    // This catches any structural divergence between buildSummary's
    // in-memory shape and the JSON.stringify() serialization.
    const onDisk = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (await import("node:fs")).readFileSync(join(tempDir, "restore-summary.json"), "utf-8"),
    );
    const recheck = validateRestoreSummary(onDisk);
    if (!recheck.valid) {
      throw new Error(
        `restore-packet write: on-disk schema recheck failed: ${recheck.errors.slice(0, 5).map((e) => `${e.field}: ${e.rule}`).join("; ")}`,
      );
    }

    // Atomic rename tempdir → targetDir. fs.rename is atomic when source
    // and destination are on the same filesystem; we keep them sibling
    // so this holds.
    renameSync(tempDir, opts.targetDir);
  } catch (err) {
    // Clean up tempdir on any failure; do NOT leave a partial packet.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; original error takes precedence.
    }
    throw err;
  }

  const files = [
    "restore-instructions.md",
    "transcript-latest.md",
    "touched-files.md",
    "restore-summary.json",
  ];
  if (transcriptFull !== null) files.push("transcript.md");

  return {
    targetDir: opts.targetDir,
    files,
    summaryPath: join(opts.targetDir, "restore-summary.json"),
  };
}
