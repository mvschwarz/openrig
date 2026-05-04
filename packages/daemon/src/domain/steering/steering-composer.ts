// Operator Surface Reconciliation v0 — steering composer.
//
// Item 1 (HEADLINE): one-screen composed steering surface. Daemon-side
// composer reads four filesystem sources and returns a payload the UI
// renders across the priority-stack / roadmap-rail / lane-rails panels.
//
// Why this composer and NOT a full daemon orchestration of Mission
// Control + agentActivity + everything: the steering UI fetches PL-005
// queue views (in-motion / loop-state) and health summaries via their
// own existing endpoints, so the composer stays narrow + testable. The
// composer is responsible only for the filesystem-derived pieces:
//   - STEERING.md priority stack (verbatim render upstream)
//   - roadmap PROGRESS.md (PL-XXX checklist + next-unchecked marker)
//   - delivery-ready/mode-{0..3}/PROGRESS.md (per-lane top-N + health
//     badges + next-pull marker per Priority Rail Rule semantics)
//
// Configuration: per the env-var-pivot pattern from UI Enhancement
// Pack v0 (ConfigStore's strict VALID_KEYS won't admit dynamic family
// keys cleanly), the steering composer reads a single workspace root
// from OPENRIG_STEERING_WORKSPACE. Everything else derives relative to
// that root: STEERING.md, roadmap/PROGRESS.md, delivery-ready/mode-*/
// PROGRESS.md. Operator-overridable via OPENRIG_STEERING_PATH /
// OPENRIG_ROADMAP_PATH / OPENRIG_DELIVERY_READY_DIR for non-canonical
// layouts. Empty/unset → composer.isReady() = false → route returns
// 503 with structured setup hint.

import * as fs from "node:fs";
import * as path from "node:path";
import { ProgressIndexer, type ProgressFileNode, type ProgressRow } from "../progress/progress-indexer.js";

export interface SteeringComposerOpts {
  /** Workspace root (e.g., the openrig-work substrate dir). Optional
   *  per-piece overrides (steeringPath / roadmapPath / deliveryReadyDir)
   *  trump the workspace-root-derived defaults. */
  workspaceRoot: string | null;
  steeringPath?: string | null;
  roadmapPath?: string | null;
  deliveryReadyDir?: string | null;
  /** Per-lane top-N items to surface; default 3 (PRD § Item 1D). */
  topNPerLane?: number;
}

export interface PriorityStackPayload {
  /** Verbatim STEERING.md content. UI renders via the v0 MarkdownViewer
   *  for consistency with the Files browser. */
  content: string;
  absolutePath: string;
  mtime: string;
  byteCount: number;
}

export interface RoadmapRailItem {
  line: number;
  text: string;
  done: boolean;
  /** Detected PL-XXX rail-item code if present (e.g., "PL-019"). */
  railItemCode: string | null;
  /** True for the first unchecked item on the rail (UI marks visually). */
  isNextUnchecked: boolean;
}

export interface RoadmapRailPayload {
  absolutePath: string;
  mtime: string;
  items: RoadmapRailItem[];
  /** Total checkbox rows / done / next-unchecked-line for header. */
  counts: { total: number; done: number; nextUncheckedLine: number | null };
}

export interface LaneRailItem {
  line: number;
  text: string;
  status: "active" | "done" | "blocked" | "unknown";
  /** True when this is the lane's "next pull" per the Priority Rail
   *  Rule: first non-done, non-blocked checkbox row on the lane. */
  isNextPull: boolean;
}

export interface LaneRailPayload {
  /** "mode-0" / "mode-1" / etc. — derived from the file's parent dir. */
  laneId: string;
  absolutePath: string;
  mtime: string;
  /** Top-N items shown on the steering panel (active/blocked first;
   *  done items only filling remainder). */
  topItems: LaneRailItem[];
  /** Lane-health aggregate counts across ALL rows in the file. */
  healthBadges: { active: number; blocked: number; done: number; total: number };
  /** Convenience: line number of the lane's next-pull row, null if none. */
  nextPullLine: number | null;
}

export interface SteeringPayload {
  priorityStack: PriorityStackPayload | null;
  roadmapRail: RoadmapRailPayload | null;
  laneRails: LaneRailPayload[];
  /** Surface-level diagnostics for the UI to render setup hints when
   *  individual sources are missing. Each entry names the env var that
   *  would resolve it. */
  unavailableSources: Array<{ section: string; reason: string; envVar?: string }>;
}

const ENV_WORKSPACE = "OPENRIG_STEERING_WORKSPACE";
const ENV_LEGACY_WORKSPACE = "RIGGED_STEERING_WORKSPACE";
const ENV_STEERING_PATH = "OPENRIG_STEERING_PATH";
const ENV_ROADMAP_PATH = "OPENRIG_ROADMAP_PATH";
const ENV_DELIVERY_READY_DIR = "OPENRIG_DELIVERY_READY_DIR";

export function steeringOptsFromEnv(env: NodeJS.ProcessEnv = process.env): SteeringComposerOpts {
  // Use || (not ??) so an empty-string env var falls through to the next
  // candidate. Same precedent as the UI Enhancement Pack v0 env helpers.
  const workspaceRoot = (env[ENV_WORKSPACE] || env[ENV_LEGACY_WORKSPACE] || "").trim() || null;
  return {
    workspaceRoot,
    steeringPath: (env[ENV_STEERING_PATH] || "").trim() || null,
    roadmapPath: (env[ENV_ROADMAP_PATH] || "").trim() || null,
    deliveryReadyDir: (env[ENV_DELIVERY_READY_DIR] || "").trim() || null,
  };
}

export class SteeringComposer {
  private readonly opts: Required<Omit<SteeringComposerOpts, "workspaceRoot">> & { workspaceRoot: string | null };

  constructor(opts: SteeringComposerOpts) {
    this.opts = {
      workspaceRoot: opts.workspaceRoot,
      steeringPath: opts.steeringPath ?? null,
      roadmapPath: opts.roadmapPath ?? null,
      deliveryReadyDir: opts.deliveryReadyDir ?? null,
      topNPerLane: opts.topNPerLane ?? 3,
    };
  }

  /** True when at least one source is resolvable. Routes use this to
   *  decide between 200 (with possibly-empty unavailableSources) and
   *  503 (no sources at all). */
  isReady(): boolean {
    return Boolean(
      this.resolveSteeringPath() ||
      this.resolveRoadmapPath() ||
      this.resolveDeliveryReadyDir(),
    );
  }

  compose(): SteeringPayload {
    const unavailableSources: SteeringPayload["unavailableSources"] = [];
    const priorityStack = this.composePriorityStack(unavailableSources);
    const roadmapRail = this.composeRoadmapRail(unavailableSources);
    const laneRails = this.composeLaneRails(unavailableSources);
    return { priorityStack, roadmapRail, laneRails, unavailableSources };
  }

  // --- per-section composers ---

  private composePriorityStack(unavailableSources: SteeringPayload["unavailableSources"]): PriorityStackPayload | null {
    const p = this.resolveSteeringPath();
    if (!p) {
      unavailableSources.push({ section: "priorityStack", reason: "STEERING.md path not configured", envVar: ENV_STEERING_PATH });
      return null;
    }
    try {
      const content = fs.readFileSync(p, "utf-8");
      const stat = fs.statSync(p);
      return {
        content,
        absolutePath: p,
        mtime: stat.mtime.toISOString(),
        byteCount: stat.size,
      };
    } catch (err) {
      unavailableSources.push({
        section: "priorityStack",
        reason: `failed to read STEERING.md: ${err instanceof Error ? err.message : String(err)}`,
        envVar: ENV_STEERING_PATH,
      });
      return null;
    }
  }

  private composeRoadmapRail(unavailableSources: SteeringPayload["unavailableSources"]): RoadmapRailPayload | null {
    const p = this.resolveRoadmapPath();
    if (!p) {
      unavailableSources.push({ section: "roadmapRail", reason: "roadmap PROGRESS.md path not configured", envVar: ENV_ROADMAP_PATH });
      return null;
    }
    let content: string;
    let mtime: Date;
    try {
      content = fs.readFileSync(p, "utf-8");
      mtime = fs.statSync(p).mtime;
    } catch (err) {
      unavailableSources.push({
        section: "roadmapRail",
        reason: `failed to read roadmap PROGRESS.md: ${err instanceof Error ? err.message : String(err)}`,
        envVar: ENV_ROADMAP_PATH,
      });
      return null;
    }
    const items: RoadmapRailItem[] = [];
    let nextUncheckedSet = false;
    let nextUncheckedLine: number | null = null;
    let total = 0;
    let done = 0;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^\s*(?:[-*]\s+)?\[([ xX])\]\s+(.+)$/);
      if (!m) continue;
      const isDone = m[1]!.toLowerCase() === "x";
      const text = m[2]!.trim();
      total++;
      if (isDone) done++;
      const railCode = matchRailItemCode(text);
      const isNextUnchecked = !isDone && !nextUncheckedSet;
      if (isNextUnchecked) {
        nextUncheckedSet = true;
        nextUncheckedLine = i + 1;
      }
      items.push({
        line: i + 1,
        text,
        done: isDone,
        railItemCode: railCode,
        isNextUnchecked,
      });
    }
    return {
      absolutePath: p,
      mtime: mtime.toISOString(),
      items,
      counts: { total, done, nextUncheckedLine },
    };
  }

  private composeLaneRails(unavailableSources: SteeringPayload["unavailableSources"]): LaneRailPayload[] {
    const dir = this.resolveDeliveryReadyDir();
    if (!dir) {
      unavailableSources.push({
        section: "laneRails",
        reason: "delivery-ready directory not configured",
        envVar: ENV_DELIVERY_READY_DIR,
      });
      return [];
    }
    // Use the existing ProgressIndexer to parse mode-{0..3}/PROGRESS.md
    // — same checkbox-status semantics as the UI Enhancement Pack v0
    // /progress view, so the steering view stays consistent with what
    // the operator sees in the Progress workspace.
    const indexer = new ProgressIndexer({
      roots: [{ name: "delivery-ready", canonicalPath: dir }],
      maxDepth: 3,
    });
    const result = indexer.scan();
    const lanes: LaneRailPayload[] = [];
    for (const file of result.files) {
      // Derive laneId from "mode-N/PROGRESS.md" or fallback to relPath.
      const m = file.relPath.match(/^(mode-\d+)\/PROGRESS\.md$/);
      const laneId = m ? m[1]! : file.relPath.replace(/\/?PROGRESS\.md$/i, "") || file.relPath;
      lanes.push(this.composeLaneFromFile(laneId, file));
    }
    lanes.sort((a, b) => a.laneId.localeCompare(b.laneId));
    return lanes;
  }

  private composeLaneFromFile(laneId: string, file: ProgressFileNode): LaneRailPayload {
    const checkboxRows = file.rows.filter((r) => r.kind === "checkbox");
    // Priority Rail Rule "next pull": first non-done, non-blocked
    // checkbox row on the lane. Per the workstream-continuity convention
    // (cited in the PRD), shelf/queue recency does NOT override; first
    // ready item wins.
    const nextPullIdx = checkboxRows.findIndex((r) => r.status !== "done" && r.status !== "blocked");
    const nextPullLine = nextPullIdx >= 0 ? (checkboxRows[nextPullIdx]?.line ?? null) : null;
    // Top-N: prefer active+blocked rows; only fall back to done if there
    // aren't enough non-done rows to fill N (rare on healthy lanes,
    // common on closed lanes).
    const N = this.opts.topNPerLane;
    const nonDoneRows = checkboxRows.filter((r) => r.status !== "done");
    const doneRows = checkboxRows.filter((r) => r.status === "done");
    const orderedSelection = [...nonDoneRows, ...doneRows].slice(0, N);
    const topItems: LaneRailItem[] = orderedSelection.map((r: ProgressRow) => ({
      line: r.line,
      text: r.text,
      status: r.status as LaneRailItem["status"],
      isNextPull: r.line === nextPullLine,
    }));
    return {
      laneId,
      absolutePath: file.absolutePath,
      mtime: file.mtime,
      topItems,
      healthBadges: {
        active: file.counts.active,
        blocked: file.counts.blocked,
        done: file.counts.done,
        total: file.counts.total,
      },
      nextPullLine,
    };
  }

  // --- path resolvers ---

  private resolveSteeringPath(): string | null {
    if (this.opts.steeringPath) return this.opts.steeringPath;
    if (!this.opts.workspaceRoot) return null;
    const candidate = path.join(this.opts.workspaceRoot, "STEERING.md");
    return fs.existsSync(candidate) ? candidate : null;
  }

  private resolveRoadmapPath(): string | null {
    if (this.opts.roadmapPath) return this.opts.roadmapPath;
    if (!this.opts.workspaceRoot) return null;
    const candidate = path.join(this.opts.workspaceRoot, "roadmap", "PROGRESS.md");
    return fs.existsSync(candidate) ? candidate : null;
  }

  private resolveDeliveryReadyDir(): string | null {
    if (this.opts.deliveryReadyDir) return this.opts.deliveryReadyDir;
    if (!this.opts.workspaceRoot) return null;
    const candidate = path.join(this.opts.workspaceRoot, "delivery-ready");
    try {
      const st = fs.statSync(candidate);
      if (st.isDirectory()) return candidate;
    } catch { /* fall through */ }
    return null;
  }
}

const RAIL_CODE_REGEX = /\b(PL-\d{2,4})\b/;

export function matchRailItemCode(text: string): string | null {
  const m = text.match(RAIL_CODE_REGEX);
  return m ? m[1]! : null;
}
