// Fork Primitive + Starter Agent Images v0 (PL-016) — typed primitive
// parallel to skills + workflow_specs + context_packs (PL-014).
//
// An agent_image is a snapshot bundle of a productive seat's
// resumable state — runtime-specific resume token (Claude resume_token
// / Codex thread_id), source-seat lineage, optional cwd-deltas + notes
// — surfaced in the Specs library and consumable by AgentSpec
// `session_source: mode: agent_image, ref: { kind: image_name, ... }`.
// Storage at ~/.openrig/agent-images/<name>/ + workspace-local
// .openrig/agent-images/<name>/.
//
// MVP single-host context: filesystem-canonical; NO new SQLite tables;
// library cache is in-memory at the daemon scope.

export type AgentImageRuntime = "claude-code" | "codex";

export interface AgentImageManifest {
  name: string;
  version: string;
  runtime: AgentImageRuntime;
  /** Source seat's canonical session name, e.g. "velocity-driver@openrig-velocity". */
  sourceSeat: string;
  /** Native conversation id captured at snapshot time. Claude: the
   *  resume_token from the sessions table. Codex: the thread_id from
   *  codex-thread-id.ts. */
  sourceSessionId: string;
  /** Same value as sourceSessionId for v0 — kept as a separate field
   *  in the manifest so future versions can split runtime conversation
   *  identity from a runtime-resume token without breaking older
   *  manifests. */
  sourceResumeToken: string;
  /** PL-016 Finding 2 (Option 3, founder-confirmed 2026-05-04): the
   *  source seat's resolved cwd at snapshot time. Captured so the
   *  Use-as-starter snippet can emit `cwd: <source_cwd>` and the fork
   *  starts in the SAME directory the parent session was created in
   *  — Claude's project-dir-scoped session storage works because the
   *  jsonl file lives there. The daemon does NOT override cwd at fork
   *  dispatch — if operator manually changes the rig.yaml cwd, fork
   *  fails honestly with "no conversation found". Optional: manifests
   *  authored before Finding 2 omit this field; snippet renders
   *  without cwd line for back-compat. */
  sourceCwd?: string;
  createdAt: string;
  notes?: string;
  /** Optional supplementary files (analogous to context_pack files).
   *  v0 ships no consumers for this surface beyond passthrough; the
   *  startup orchestrator will compose them into the seat's cwd at
   *  launch time when the v0+1 trigger names them. */
  files: AgentImageManifestFile[];
  /** Operator-supplied or capturer-derived estimate. Used for at-a-
   *  glance display in the library; the library service ALSO computes
   *  a derivedEstimatedTokens from the actual on-disk content size. */
  estimatedTokens?: number;
  /** Lineage chain populated when the image is forked from another
   *  image (image creation can record `lineage: [<parent>, ...]`). */
  lineage?: string[];
}

export interface AgentImageManifestFile {
  path: string;
  role: string;
  summary?: string;
}

export interface AgentImageStats {
  /** Incremented atomically when the image is consumed (either by
   *  rig fork / agent-image fork or by a session_source: mode:
   *  agent_image consumer at instantiation time). */
  forkCount: number;
  /** ISO timestamp of the most-recent consumption. */
  lastUsedAt: string | null;
  /** Daemon-derived estimate of total bytes under the image dir
   *  (manifest + supplementary files). */
  estimatedSizeBytes: number;
  /** Fully-resolved lineage chain (mirrors manifest.lineage; kept on
   *  stats so it's mutable independently when a parent image is
   *  renamed). */
  lineage: string[];
}

export type AgentImageSourceType = "user_file" | "workspace" | "builtin";

export interface AgentImageEntry {
  /** Stable id `agent-image:<name>:<version>` parallel to context-pack:. */
  id: string;
  kind: "agent-image";
  name: string;
  version: string;
  runtime: AgentImageRuntime;
  sourceSeat: string;
  sourceSessionId: string;
  /** PL-016 Finding 2 — source seat's cwd at snapshot time. null when
   *  manifest predates Finding 2 fix (back-compat surface). Consumed
   *  by the Use-as-starter snippet generator. */
  sourceCwd: string | null;
  notes: string | null;
  createdAt: string;
  sourceType: AgentImageSourceType;
  /** Absolute path to the image directory. */
  sourcePath: string;
  /** Path relative to the discovery root that found this image. */
  relativePath: string;
  /** Most-recent mtime under the image dir. */
  updatedAt: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  files: AgentImageEntryFile[];
  /** Resume-token surface kept separate from manifest data so the
   *  library/list/get routes can omit it when the operator is browsing
   *  but include it when the consumer is the instantiator. */
  sourceResumeToken: string;
  stats: AgentImageStats;
  lineage: string[];
  /** True when an explicit `pin` file exists at <sourcePath>/.pinned.
   *  Pinned images are protected from `prune` regardless of active-
   *  reference scan results. */
  pinned: boolean;
}

export interface AgentImageEntryFile {
  path: string;
  role: string;
  summary: string | null;
  absolutePath: string | null;
  bytes: number | null;
  estimatedTokens: number | null;
}

export class AgentImageError extends Error {
  constructor(
    public readonly code:
      | "manifest_missing"
      | "manifest_parse_error"
      | "manifest_invalid"
      | "image_not_found"
      | "image_referenced"
      | "image_pinned"
      | "runtime_mismatch"
      | "stats_write_failed",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentImageError";
  }
}
