import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ResolvedStartupFile } from "./runtime-adapter.js";
import type { SessionSourceRebuildSpec } from "./types.js";

/**
 * Result of resolving a `session_source.mode: rebuild` artifact set into the
 * `ResolvedStartupFile[]` shape that `adapter.deliverStartup` already
 * accepts. Records gaps (paths the operator declared but that don't exist
 * on disk at resolve time) without failing — the operator's other declared
 * artifacts may still carry enough context. The launch only fails if NONE
 * of the declared paths resolved.
 */
export interface RebuildArtifactsResult {
  ok: true;
  files: ResolvedStartupFile[];
  /** Paths from `ref.value` that did not resolve to an existing file. */
  gaps: string[];
}

export type RebuildArtifactsOutcome =
  | RebuildArtifactsResult
  | { ok: false; error: string; gaps: string[] };

/**
 * Test/host injection seam: lets unit tests assert path resolution without
 * touching the real filesystem.
 */
export type ExistsFn = (path: string) => boolean;

/**
 * Resolve operator-declared rebuild artifacts into the orchestrator's
 * existing `ResolvedStartupFile[]` shape, preserving the operator's
 * trust-precedence ordering.
 *
 * Identity-honesty notes:
 * - This function does NOT execute, parse, or evaluate artifact contents.
 *   It just records that a path exists and hands the orchestrator the
 *   metadata it needs to deliver the bytes via the standard `deliverStartup`
 *   seam (which itself only reads + paste-injects via tmux for the
 *   `send_text` hint).
 * - The artifacts are tagged `appliesOn: ["fresh_start"]` because rebuild
 *   IS a fresh launch from the runtime's perspective; the artifacts seed
 *   it with operator context, but the runtime conversation itself is new.
 *   `continuityOutcome: rebuilt` (set by the orchestrator) is the only
 *   signal that distinguishes this from a vanilla fresh launch.
 *
 * @param spec - the rebuild spec from the member; `ref.value` is the
 *               operator-declared list of artifact paths in trust-
 *               precedence order (highest-trust first).
 * @param opts.exists - filesystem existence check; defaults to `existsSync`.
 *                      Tests pass a stub.
 */
export function resolveRebuildArtifacts(
  spec: SessionSourceRebuildSpec,
  opts: { exists?: ExistsFn } = {},
): RebuildArtifactsOutcome {
  const exists = opts.exists ?? existsSync;
  const gaps: string[] = [];
  const files: ResolvedStartupFile[] = [];
  for (const path of spec.ref.value) {
    if (!exists(path)) {
      gaps.push(path);
      continue;
    }
    files.push({
      path: basename(path),
      absolutePath: path,
      ownerRoot: dirname(path),
      // `send_text` so the orchestrator's existing post-launch TUI delivery
      // path picks these up after the harness is ready. Operator-curated
      // context is meant to seed the running conversation, not to land as
      // filesystem-projected guidance/skill content.
      deliveryHint: "send_text",
      required: true,
      // `fresh_start` because rebuild IS a fresh-launch from the runtime's
      // perspective; the artifacts are the operator-declared seed context.
      appliesOn: ["fresh_start"],
    });
  }
  if (files.length === 0) {
    return {
      ok: false,
      error: `rebuild: none of the ${spec.ref.value.length} declared artifact path${spec.ref.value.length === 1 ? "" : "s"} resolved to an existing file. Verify the paths in session_source.ref.value (declared in trust-precedence order; highest-trust first).`,
      gaps,
    };
  }
  return { ok: true, files, gaps };
}
