// Fork Primitive + Starter Agent Images v0 (PL-016) — snapshot capturer.
//
// Captures a productive seat's resumable state into a new agent_image:
// runtime-specific resume token + manifest + optional cwd-deltas. Used
// by `rig agent-image create <source-session> --name <name>` and the
// daemon HTTP route /api/agent-images/snapshot.
//
// Resume-token discovery routes through resume-token-discovery.ts so
// the same logic is shared with the /api/agent-images/fork route.
//
// Failure modes surface honest errors per architecture.md § Resume
// honesty (no fabricated tokens; no auto-fallback to fresh).

import type Database from "better-sqlite3";
import type { SessionRegistry } from "../session-registry.js";
import type { RigRepository } from "../rig-repository.js";
import {
  AgentImageError,
  type AgentImageManifest,
} from "./agent-image-types.js";
import { AgentImageLibraryService } from "./agent-image-library-service.js";
import { discoverResumeToken } from "./resume-token-discovery.js";

export interface CaptureSnapshotOpts {
  sourceSession: string;
  name: string;
  version?: string;
  notes?: string;
  estimatedTokens?: number;
  lineage?: string[];
  files?: Map<string, string>;
}

export interface CaptureSnapshotResult {
  imageId: string;
  imagePath: string;
  manifest: AgentImageManifest;
}

export interface SnapshotCapturerDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  agentImageLibrary: AgentImageLibraryService;
  /** Target install root — typically ~/.openrig/agent-images/. */
  targetRoot: string;
  /** Test seam — defaults to () => new Date(). */
  now?: () => Date;
}

export class SnapshotCapturer {
  private readonly deps: SnapshotCapturerDeps;
  private readonly now: () => Date;

  constructor(deps: SnapshotCapturerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  capture(opts: CaptureSnapshotOpts): CaptureSnapshotResult {
    const { sourceSession, name } = opts;
    const version = opts.version ?? "1";

    const discovery = discoverResumeToken(this.deps.db, sourceSession);
    if (!discovery.ok) {
      throw new AgentImageError(
        discovery.failure.code === "session_not_found" ? "image_not_found" : "runtime_mismatch",
        discovery.failure.message,
        { sourceSession },
      );
    }
    const { runtime, nativeId, nodeCwd } = discovery.result;
    if (!nativeId) {
      throw new AgentImageError(
        "image_not_found",
        `Could not discover a resume token for ${runtime} source session '${sourceSession}'. The session may not have a native conversation id yet — try again after the seat has produced output, or use rig context --refresh to re-sample.`,
        { sourceSession, runtime },
      );
    }

    const manifest: AgentImageManifest = {
      name,
      version,
      runtime,
      sourceSeat: sourceSession,
      sourceSessionId: nativeId,
      sourceResumeToken: nativeId,
      // PL-016 Finding 2 (Option 3, founder-confirmed 2026-05-04):
      // capture source seat's resolved cwd so the Use-as-starter
      // snippet can emit `cwd: <source_cwd>`. nodeCwd may be null when
      // the source node has no recorded cwd (legacy fixture or seat
      // pre-cwd-capture); manifest field is omitted in that case.
      ...(nodeCwd ? { sourceCwd: nodeCwd } : {}),
      createdAt: this.now().toISOString(),
      ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
      files: [],
      ...(opts.estimatedTokens !== undefined ? { estimatedTokens: opts.estimatedTokens } : {}),
      ...(opts.lineage !== undefined ? { lineage: [...opts.lineage] } : {}),
    };
    const fileContents = opts.files ?? new Map<string, string>();
    const imagePath = this.deps.agentImageLibrary.install(this.deps.targetRoot, manifest, fileContents);
    this.deps.agentImageLibrary.scan();
    return { imageId: `agent-image:${name}:${version}`, imagePath, manifest };
  }
}
