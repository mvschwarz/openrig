// restore-packet.ts — `rig restore-packet {write,read,validate}` CLI command.
//
// M2a: command shape + mutual-exclusion + read/validate stubs.
// M2b: source-adapter wiring (codex-jsonl-parser, claude-transcript-parser,
//      runtime-detect, redaction, omitted-records).
// M2c-CLI: write action full impl using packet-writer.ts; --source-jsonl
//          + --source-session adapter wiring; CLI flag defaults for the
//          ~11 contract-required fields not derivable from the parser.
// M2c-Daemon: full-read transcript route + auth + redaction + tests.
// M3: real read + validate implementations replacing the stubs.

import { Command } from "commander";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import { detectRuntime } from "../restore-packet/runtime-detect.js";
import { parseCodexJsonl } from "../restore-packet/codex-jsonl-parser.js";
import { parseClaudeTranscript } from "../restore-packet/claude-transcript-parser.js";
import { writePacket, type WritePacketOptions } from "../restore-packet/packet-writer.js";
import {
  validateRestoreSummary,
  type ValidationError,
} from "../restore-packet/schema-validator.js";
import type { SourceRuntime, StructuredTranscript } from "../restore-packet/types.js";

// Per M1 contract § 1: 4 required packet files. Used by validate's
// packet-shape check and by read for transcript-presence detection.
const REQUIRED_PACKET_FILES = [
  "restore-instructions.md",
  "transcript-latest.md",
  "touched-files.md",
  "restore-summary.json",
] as const;

export interface RestorePacketDeps {
  lifecycleDeps?: LifecycleDeps;
  clientFactory?: (url: string) => DaemonClient;
}

interface WriteOptions {
  sourceSession?: string;
  sourceJsonl?: string;
  sourceRuntime?: string;
  /**
   * R2: explicit operator override for source_session_id. Wins over parsed
   * session_meta and over the --source-session arg. Required when JSONL
   * has no session_meta record.
   */
  sourceSessionIdOverride?: string;
  /**
   * R2: explicit operator override for source_rig. Wins over <seat>@<rig>
   * derivation. Required when the canonical source_session_id is bare
   * (no @) and the operator has not supplied --source-session-id-override
   * with @ shape.
   */
  sourceRigOverride?: string;
  target: string;
  targetRig?: string;
  targetRuntime?: string;
  targetWorkspaceRoot?: string;
  defaultTargetRepo?: string;
  rolePointer?: string;
  currentWorkSummary?: string;
  nextOwner?: string;
  caveat?: string[];
  authorityBoundaries?: string;
  sourceTrustRanking?: string;
  generatorVersion?: string;
}

/**
 * R2: derive canonical (source_session_id, source_rig) per honest-fallback
 * policy. Override flags > parsed session_meta (jsonl) > supplied --source-session.
 *
 * Returns either the derived pair (with no exception) OR throws an Error
 * containing the explicit operator-facing guidance message. The action
 * caller catches and routes to reportFailure().
 */
function deriveProvenance(
  opts: WriteOptions,
  parsedSessionId: string | null,
  hasJsonl: boolean,
): { sourceSessionId: string; sourceRig: string } {
  // Step 1: source_session_id — override > parsed > --source-session arg.
  let sourceSessionId: string;
  if (typeof opts.sourceSessionIdOverride === "string" && opts.sourceSessionIdOverride.length > 0) {
    sourceSessionId = opts.sourceSessionIdOverride;
  } else if (hasJsonl) {
    if (!parsedSessionId) {
      throw new Error(
        "no session_meta record in source JSONL; supply --source-session-id-override <id> AND --source-rig-override <rig> to set provenance explicitly. Silent fallback to file-path-as-session-id is not allowed (M2c-CLI R2 honest-provenance policy).",
      );
    }
    sourceSessionId = parsedSessionId;
  } else {
    // hasSession path: operator-named session is authoritative.
    sourceSessionId = opts.sourceSession!;
  }

  // Step 2: source_rig — override > <seat>@<rig> split.
  let sourceRig: string;
  if (typeof opts.sourceRigOverride === "string" && opts.sourceRigOverride.length > 0) {
    sourceRig = opts.sourceRigOverride;
  } else {
    const m = /^[^@]+@([^@]+)$/.exec(sourceSessionId);
    const captured = m?.[1];
    if (!captured) {
      throw new Error(
        `could not derive source_rig from session id '${sourceSessionId}' (does not match <seat>@<rig> shape); supply --source-rig-override <rig> explicitly. Silent fallback to source_rig:"unknown" is not allowed (M2c-CLI R2 honest-provenance policy).`,
      );
    }
    sourceRig = captured;
  }

  return { sourceSessionId, sourceRig };
}

function reportFailure(message: string): void {
  console.error(`rig restore-packet write: ${message}`);
  process.exitCode = 2;
}

function isValidRuntime(value: string | undefined): value is SourceRuntime {
  return value === "codex" || value === "claude-code";
}

async function fetchSourceTranscriptViaDaemon(
  session: string,
  deps: RestorePacketDeps | undefined,
): Promise<{ content: string; sourceCwd: string | null }> {
  const lifecycleDeps = deps?.lifecycleDeps ?? realDeps();
  const status = await getDaemonStatus(lifecycleDeps);
  if (status.state !== "running" || typeof status.port !== "number") {
    throw new Error("daemon not running; start it with: rig daemon start");
  }
  const url = getDaemonUrl(status);
  const client = (deps?.clientFactory ?? ((u: string) => new DaemonClient(u)))(url);
  // M2c-Daemon will define this route. M2c-CLI calls it; M2c-CLI tests
  // mock the daemon (compact-plan.test.ts:166-176 pattern). The path is
  // a draft — M2c-Daemon may pick a different naming convention; if so,
  // M2c-Daemon will land that change in restore-packet.ts the same commit
  // that adds the daemon route.
  const path = `/api/transcripts/${encodeURIComponent(session)}/full`;
  const response = await client.get<{ content: string; cwd?: string | null }>(path);
  if (response.status >= 400 || !response.data) {
    throw new Error(
      `daemon transcript fetch failed: HTTP ${response.status}: ${
        typeof response.data === "object" && response.data !== null
          ? JSON.stringify(response.data)
          : "(no body)"
      }`,
    );
  }
  return {
    content: response.data.content ?? "",
    sourceCwd: response.data.cwd ?? null,
  };
}

function buildWritePacketOptions(
  opts: WriteOptions,
  structured: StructuredTranscript,
  sourceRuntime: SourceRuntime,
  sourceCwdFallback: string,
  sourceSessionId: string,
  sourceRig: string,
): WritePacketOptions {
  const trustRankingDefault = "rig_whoami,bounded_latest_transcript";
  const trustRankingRaw = opts.sourceTrustRanking ?? trustRankingDefault;
  const trustRanking = trustRankingRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    targetDir: resolvePath(opts.target),
    structured,
    sourceRuntime,
    targetRig: opts.targetRig ?? "openrig-velocity",
    targetRuntime: isValidRuntime(opts.targetRuntime) ? opts.targetRuntime : "claude-code",
    targetWorkspaceRoot: opts.targetWorkspaceRoot ?? structured.sessionMeta?.cwd ?? sourceCwdFallback,
    defaultTargetRepo: opts.defaultTargetRepo ?? null,
    rolePointer: opts.rolePointer ?? `rigs/${opts.targetRig ?? "openrig-velocity"}/state/velocity/role.md`,
    currentWorkSummary: opts.currentWorkSummary ?? "Cross-runtime restore packet generated by rig restore-packet write.",
    nextOwner: opts.nextOwner ?? "self",
    caveats: opts.caveat ?? [],
    authorityBoundaries: opts.authorityBoundaries ?? "Restored seat authority per source session role.",
    sourceTrustRanking: trustRanking,
    sourceSessionId,
    sourceRig,
    sourceCwd: structured.sessionMeta?.cwd ?? sourceCwdFallback,
    generatorVersion: opts.generatorVersion ?? "rig-restore-packet@0.1.0",
    includeFullTranscript: structured.messages.length > 0,
  };
}

export function restorePacketCommand(depsOverride?: RestorePacketDeps): Command {
  const cmd = new Command("restore-packet")
    .description(
      "Generate, read, and validate cross-runtime restore packets per the v0 standard",
    );

  cmd.command("write")
    .description(
      "Generate a restore packet from a source session or JSONL file",
    )
    .option("--source-session <session>", "Source session name (daemon-backed)")
    .option(
      "--source-jsonl <path>",
      "Source Codex/Claude JSONL transcript file (direct)",
    )
    .option(
      "--source-runtime <runtime>",
      "Force source runtime (claude-code | codex); auto-detected if omitted",
    )
    .requiredOption(
      "--target <dir>",
      "Target packet directory (must not exist; created atomically)",
    )
    .option("--target-rig <rig>", "Target rig name for the restored seat")
    .option(
      "--target-runtime <runtime>",
      "Target runtime (claude-code | codex)",
    )
    .option(
      "--target-workspace-root <path>",
      "Target workspace root absolute path",
    )
    .option(
      "--default-target-repo <path>",
      "Default target repo absolute path or null",
    )
    .option(
      "--role-pointer <path>",
      "Role guidance pointer path or URI for the restored seat",
    )
    .option(
      "--current-work-summary <text>",
      "One-paragraph summary of the source seat's current work",
    )
    .option(
      "--next-owner <name>",
      'Who the restored seat hands off to next (default: "self")',
    )
    .option(
      "--caveat <text>",
      "Caveat to include in the packet (repeatable)",
      (value: string, prev: string[] = []) => prev.concat([value]),
      [] as string[],
    )
    .option(
      "--authority-boundaries <text>",
      "Explicit statement of restored-seat authority",
    )
    .option(
      "--source-trust-ranking <csv>",
      "Comma-separated source-trust ranking; default: rig_whoami,bounded_latest_transcript",
    )
    .option(
      "--generator-version <version>",
      'Generator version identifier (default: "rig-restore-packet@0.1.0")',
    )
    .option(
      "--source-session-id-override <id>",
      "Operator override for source_session_id (R2; required when JSONL has no session_meta record)",
    )
    .option(
      "--source-rig-override <rig>",
      "Operator override for source_rig (R2; required when canonical session id is bare with no <seat>@<rig> shape)",
    )
    .action(async (opts: WriteOptions) => {
      const hasSession = typeof opts.sourceSession === "string" && opts.sourceSession.length > 0;
      const hasJsonl = typeof opts.sourceJsonl === "string" && opts.sourceJsonl.length > 0;
      if (hasSession && hasJsonl) {
        reportFailure(
          "--source-session and --source-jsonl are mutually exclusive; supply exactly one.",
        );
        return;
      }
      if (!hasSession && !hasJsonl) {
        reportFailure(
          "exactly one of --source-session or --source-jsonl is required.",
        );
        return;
      }

      try {
        let content: string;
        let sourceCwdFallback: string;
        if (hasJsonl) {
          const jsonlPath = resolvePath(opts.sourceJsonl!);
          content = readFileSync(jsonlPath, "utf-8");
          sourceCwdFallback = "/";
        } else {
          const session = opts.sourceSession!;
          const fetched = await fetchSourceTranscriptViaDaemon(session, depsOverride);
          content = fetched.content;
          sourceCwdFallback = fetched.sourceCwd ?? "/";
        }

        let runtime: SourceRuntime | null = null;
        if (isValidRuntime(opts.sourceRuntime)) {
          runtime = opts.sourceRuntime;
        } else if (typeof opts.sourceRuntime === "string" && opts.sourceRuntime.length > 0) {
          reportFailure(
            `--source-runtime must be 'codex' or 'claude-code'; got '${opts.sourceRuntime}'.`,
          );
          return;
        } else {
          runtime = detectRuntime(content);
          if (runtime === null) {
            reportFailure(
              "could not auto-detect source runtime; pass --source-runtime <claude-code|codex> explicitly.",
            );
            return;
          }
        }

        const structured = runtime === "codex"
          ? parseCodexJsonl(content)
          : parseClaudeTranscript(content);

        // R2: derive (source_session_id, source_rig) honestly. Override
        // flags > parsed session_meta (jsonl) > supplied --source-session
        // arg. Throws an Error with explicit operator guidance when the
        // honest-provenance policy can't be satisfied.
        let provenance: { sourceSessionId: string; sourceRig: string };
        try {
          provenance = deriveProvenance(opts, structured.sessionMeta?.sessionId ?? null, hasJsonl);
        } catch (err) {
          reportFailure((err as Error).message);
          return;
        }

        const writeOpts = buildWritePacketOptions(
          opts,
          structured,
          runtime,
          sourceCwdFallback,
          provenance.sourceSessionId,
          provenance.sourceRig,
        );
        const result = await writePacket(writeOpts);

        // Per Quality Lesson v9: log only metadata, NOT transcript content.
        console.log(`packet: ${result.targetDir}`);
        console.log(`files: ${result.files.length}`);
        for (const f of result.files) {
          console.log(`  - ${f}`);
        }
        console.log(`messages: ${structured.messageCount}`);
        console.log(`omitted-classes: ${Object.entries(structured.omittedCounts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(",") || "(none)"}`);
      } catch (err) {
        reportFailure((err as Error).message);
      }
    });

  cmd.command("read")
    .description("Render a restore packet contents (human or --json)")
    .argument("<packet-dir>", "Packet directory path")
    .option("--json", "Emit machine-readable JSON output")
    .action(async (packetDir: string, opts: { json?: boolean }) => {
      const dir = resolvePath(packetDir);
      const summaryPath = joinPath(dir, "restore-summary.json");
      if (!existsSync(summaryPath)) {
        console.error(
          `rig restore-packet read: restore-summary.json not found at ${summaryPath}.`,
        );
        process.exitCode = 2;
        return;
      }
      let summary: Record<string, unknown>;
      try {
        summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as Record<string, unknown>;
      } catch (err) {
        console.error(
          `rig restore-packet read: restore-summary.json is not valid JSON: ${(err as Error).message}.`,
        );
        process.exitCode = 2;
        return;
      }

      if (opts.json) {
        // Per IMPL § M3: --json emits raw restore-summary.json content
        // verbatim; round-trippable.
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      // Human output: restore-instructions body + summary metadata + transcript digest.
      const instructionsPath = joinPath(dir, "restore-instructions.md");
      if (existsSync(instructionsPath)) {
        console.log(readFileSync(instructionsPath, "utf-8"));
      } else {
        console.log("(restore-instructions.md absent in packet directory)");
      }
      console.log("--- Summary metadata ---");
      const metadataKeys = [
        "source_session_id",
        "source_rig",
        "source_cwd",
        "source_runtime",
        "target_rig",
        "target_runtime",
        "generator_version",
      ];
      for (const k of metadataKeys) {
        const v = summary[k];
        console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
      }
      const blt = summary.bounded_latest_transcript as { bound?: number; message_count?: number } | undefined;
      if (blt) {
        console.log(`bounded_latest_transcript.bound: ${blt.bound}`);
        console.log(`bounded_latest_transcript.message_count: ${blt.message_count}`);
      }
      const omittedClasses = summary.omitted_classes;
      console.log(`omitted_classes: ${Array.isArray(omittedClasses) ? omittedClasses.join(",") || "(none)" : "(unknown)"}`);

      // Transcript digest line (per IMPL § M3 + contract § 1 parity rule).
      const transcriptPath = joinPath(dir, "transcript.md");
      const hasFullTranscriptKey = Object.prototype.hasOwnProperty.call(summary, "full_transcript");
      if (existsSync(transcriptPath)) {
        const sz = statSync(transcriptPath).size;
        console.log(`transcript.md: ${sz} bytes`);
        if (!hasFullTranscriptKey) {
          console.log("(parity warning: transcript.md present but full_transcript summary key absent)");
        }
      } else {
        if (hasFullTranscriptKey) {
          console.log("(parity warning: full_transcript summary key present but transcript.md absent)");
        } else {
          console.log("transcript.md absent (full_transcript key absent in summary; valid per parity rule)");
        }
      }
    });

  cmd.command("validate")
    .description("Validate a restore packet against the v0 schema")
    .argument("<packet-dir>", "Packet directory path")
    .option("--json", "Emit machine-readable validation report")
    .action(async (packetDir: string, opts: { json?: boolean }) => {
      const dir = resolvePath(packetDir);
      const errors: ValidationError[] = [];

      // Packet-shape check: 4 required files per contract § 1.
      for (const required of REQUIRED_PACKET_FILES) {
        const p = joinPath(dir, required);
        if (!existsSync(p)) {
          errors.push({
            field: required,
            value: "<missing>",
            rule: `packet-shape: required file missing at ${p}`,
            severity: "error",
          });
        }
      }

      // Schema validation if restore-summary.json exists.
      let summary: Record<string, unknown> | null = null;
      const summaryPath = joinPath(dir, "restore-summary.json");
      if (existsSync(summaryPath)) {
        try {
          summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          errors.push({
            field: "restore-summary.json",
            value: "<invalid-json>",
            rule: `restore-summary.json parse failed: ${(err as Error).message}`,
            severity: "error",
          });
        }
        if (summary) {
          const schemaResult = validateRestoreSummary(summary);
          for (const e of schemaResult.errors) errors.push(e);
        }
      }

      // Parity check (per contract § 1 + § 8): full_transcript summary key
      // ↔ transcript.md presence.
      if (summary) {
        const hasFullTranscriptKey = Object.prototype.hasOwnProperty.call(summary, "full_transcript");
        const transcriptExists = existsSync(joinPath(dir, "transcript.md"));
        if (hasFullTranscriptKey && !transcriptExists) {
          errors.push({
            field: "full_transcript",
            value: "<key-present-file-absent>",
            rule: "parity: full_transcript summary key present but transcript.md absent at packet directory",
            severity: "error",
          });
        }
        if (!hasFullTranscriptKey && transcriptExists) {
          errors.push({
            field: "transcript.md",
            value: "<file-present-key-absent>",
            rule: "parity: transcript.md present but full_transcript summary key absent",
            severity: "error",
          });
        }
      }

      const hasErrorSeverity = errors.some((e) => e.severity === "error");
      const valid = !hasErrorSeverity;

      if (opts.json) {
        console.log(JSON.stringify({ valid, errors }, null, 2));
      } else {
        if (errors.length === 0) {
          console.log(`valid: packet at ${dir} passed all checks.`);
        } else {
          console.log(`${valid ? "valid (with warnings)" : "invalid"}: ${errors.length} issue(s) at ${dir}`);
          for (const e of errors) {
            const tag = e.severity === "warning" ? "WARNING" : "ERROR";
            console.log(`  [${tag}] ${e.field}: ${e.rule} (value: ${e.value})`);
          }
        }
      }

      // Per contract § 8: required-field violations / parity violations →
      // exit nonzero. Optional-field warnings → exit 0.
      if (hasErrorSeverity) {
        process.exitCode = 2;
      }
    });

  return cmd;
}
