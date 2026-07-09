// OPR.0.4.1.19 — Story tab: queue lineage as a scrollable, upward-growing
// git-graph UI (most-recent at the TOP, origin at the BOTTOM).
//
// NORTH STAR: represent the REAL queue system. The graph is reconstructed from
// queue-item lineage (story-graph-model); git vocabulary is illustrative only.
// State badges show the REAL qitem state — there is no "merged" queue state
// (that mockup label is illustrative); a visual fan-in is a rendering affordance,
// never a 2-parent data node. 3-tier home: one-line row -> full-width-bands
// expand -> existing right-hand drawer (QueueItemTrigger).

import { useMemo, useState } from "react";
import { QueueItemTrigger } from "../drawer-triggers/QueueItemTrigger.js";
import type { QueueItemViewerData } from "../drawer-viewers/QueueItemViewer.js";
import { FileLink } from "../ui/FileLink.js";
import { formatStoryDate, type StoryForest, type StoryNode } from "../../lib/story-graph-model.js";
import { EmptyState } from "../ui/empty-state.js";
import { sessionMemberLabel } from "../../lib/session-name.js";
import "./StoryGraph.css";

const TOPLINE_H = 54;
const LANE_W = 28;
const LANE_X0 = 28;
const NODE_R = 5.5;
const NODE_R_BIG = 6.5;

function shortSeat(session: string | null | undefined): string {
  if (!session) return "unknown";
  // OPR.0.4.6.MH1 FR-8: the shared parse contract's display helper.
  return sessionMemberLabel(session);
}

/** Map the REAL qitem state to a badge class + label. No invented states. */
function stateBadge(node: StoryNode): { cls: string; label: string } {
  const reason = (node.closureReason ?? "").toLowerCase();
  switch (node.state) {
    case "in-progress":
      return { cls: "sg-progress", label: "In progress" };
    case "blocked":
      return { cls: "sg-blocked", label: "Blocked" };
    case "handed-off":
      return { cls: "sg-done", label: "Handed off" };
    case "failed":
    case "denied":
    case "canceled":
      return { cls: "sg-blocked", label: node.state.charAt(0).toUpperCase() + node.state.slice(1) };
    case "done":
    default:
      // A terminal close-out; show the real closure flavor when present.
      if (reason === "no-follow-on") return { cls: "sg-done", label: "Done" };
      if (reason === "handed_off_to") return { cls: "sg-done", label: "Handed off" };
      return { cls: "sg-done", label: "Done" };
  }
}

/** Gutter node colour follows state; human-origin nodes are amber-filled. */
function nodeStroke(node: StoryNode): string {
  if (node.isHumanOrigin) return "var(--sg-amber)";
  if (node.state === "in-progress") return "var(--sg-blue)";
  if (node.state === "blocked") return "var(--sg-amber)";
  return "var(--sg-green)";
}

/** Pull obvious artifact paths out of the agent-speak body. Honest: omit the
 *  band when none are present (never fabricate outputs). */
function extractArtifacts(body: string): string[] {
  const matches = body.match(/[\w./-]+\.(?:ts|tsx|js|jsx|md|png|jpg|gif|mp4|patch|diff|json|yaml|yml|sql|css|html)\b/g);
  if (!matches) return [];
  return Array.from(new Set(matches)).slice(0, 6);
}

function bodyContext(body: string): string {
  const trimmed = (body ?? "").trim();
  if (trimmed.length <= 240) return trimmed;
  return `${trimmed.slice(0, 237)}…`;
}

function toViewerData(node: StoryNode): QueueItemViewerData {
  // Tier-3 drawer = the FULL queue-item detail: every field + the full chain.
  return {
    qitemId: node.qitemId,
    source: node.sourceSession,
    destination: node.destinationSession,
    state: node.state,
    tags: node.tags,
    createdAt: node.tsCreated,
    body: node.body,
    updatedAt: node.tsUpdated,
    priority: node.priority,
    tier: node.tier,
    closureReason: node.closureReason,
    closureTarget: node.closureTarget,
    handedOffFrom: node.handedOffFrom,
    handedOffTo: node.handedOffTo,
    blockedOn: node.blockedOn,
    claimedAt: node.claimedAt,
    expiresAt: node.expiresAt,
    closureRequiredAt: node.closureRequiredAt,
    lastNudgeAttempt: node.lastNudgeAttempt,
    lastNudgeResult: node.lastNudgeResult,
    lastHeartbeat: node.lastHeartbeat,
    resolution: node.resolution,
    targetRepo: node.targetRepo,
    chain: node.chain,
    // Tier-3 = the full source-of-truth view: render EVERY field labeled, empties
    // shown as "—" (not hidden). Other QueueItemViewer callsites stay compact.
    fullDetail: true,
  };
}

/** A body artifact is "viewable" when it is an absolute path — route it through
 *  FileLink so a click opens it in the drawer (FileViewer infers kind, so images
 *  render inline). Non-absolute refs (repo/workspace-relative) are not reliably
 *  resolvable against the daemon allowlist, so they stay inert + explicitly
 *  labelled rather than pretending to be openable. */
function isViewableArtifact(path: string): boolean {
  return path.startsWith("/");
}

export function StoryGraph({ forest }: { forest: StoryForest }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Row layout (top -> bottom = most-recent -> origin). Each row owns a topline
  // (54px) plus, when expanded, a detail panel. Heights drive the gutter SVG so
  // the continuous lanes reflow on expand/collapse.
  const layout = useMemo(() => {
    const rows: { node: StoryNode; topY: number; centerY: number; height: number; isExpanded: boolean }[] = [];
    let y = 0;
    for (const node of forest.nodes) {
      const isExpanded = expanded.has(node.qitemId);
      const detailH = isExpanded ? estimateDetailHeight(node) : 0;
      const height = TOPLINE_H + detailH;
      rows.push({ node, topY: y, centerY: y + TOPLINE_H / 2, height, isExpanded });
      y += height;
    }
    return { rows, totalH: y };
  }, [forest.nodes, expanded]);

  const centerById = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of layout.rows) m.set(r.node.qitemId, r.centerY);
    return m;
  }, [layout.rows]);

  const laneX = (lane: number) => LANE_X0 + lane * LANE_W;
  const gutterWidth = Math.max(88, LANE_X0 + Math.max(0, forest.laneCount - 1) * LANE_W + LANE_X0);

  if (forest.nodes.length === 0) {
    return (
      <EmptyState
        label="NO STORY YET"
        description="No queue items are indexed for this scope. The Story graph reconstructs from queue-item lineage as work flows through the topology."
        variant="card"
        testId="story-graph-empty"
      />
    );
  }

  return (
    <div className="sg-wrap" data-testid="story-graph" style={{ ["--sg-gutter" as string]: `${gutterWidth}px` }}>
      <div className="sg-legend">
        STORY &middot; QUEUE LINEAGE AS A GIT GRAPH &middot; ONE CLEAN LINE PER NODE &middot; CLICK TO EXPAND &middot;{" "}
        <b>HUMAN-ORIGIN LANE</b>
      </div>
      <div className="sg-tbl">
        <div className="sg-thead">
          <div>GRAPH</div>
          <div>SUMMARY</div>
          <div>OWNER</div>
          <div>STATE</div>
          <div>DATE</div>
          <div>QITEM</div>
        </div>
        <div className="sg-tbody">
          <div className="sg-gutcol" aria-hidden="true">
            <svg
              width={gutterWidth}
              height={layout.totalH}
              viewBox={`0 0 ${gutterWidth} ${layout.totalH}`}
              preserveAspectRatio="none"
            >
              {/* Parent edges: child (upper) -> parent (lower). Same lane = straight;
                  different lane = a smooth curve (the fan-out / branch). */}
              {layout.rows.map(({ node, centerY }) => {
                if (!node.parentId) return null;
                const py = centerById.get(node.parentId);
                if (py === undefined) return null;
                const cx = laneX(node.lane);
                const px = laneX(forest.nodes.find((n) => n.qitemId === node.parentId)?.lane ?? node.lane);
                const stroke = nodeStroke(node);
                const d =
                  cx === px
                    ? `M${cx},${centerY} L${px},${py}`
                    : `M${cx},${centerY} C${cx},${(centerY + py) / 2} ${px},${(centerY + py) / 2} ${px},${py}`;
                return <path key={`e-${node.qitemId}`} d={d} stroke={stroke} strokeWidth={3} fill="none" />;
              })}
              {/* Nodes */}
              {layout.rows.map(({ node, centerY }) => {
                const cx = laneX(node.lane);
                const stroke = nodeStroke(node);
                const big = node.isRoot || node.isHumanOrigin;
                const fill = node.isHumanOrigin ? "var(--sg-amber)" : node.isRoot ? stroke : "var(--sg-paper)";
                return (
                  <circle
                    key={`n-${node.qitemId}`}
                    cx={cx}
                    cy={centerY}
                    r={big ? NODE_R_BIG : NODE_R}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={3}
                  />
                );
              })}
            </svg>
          </div>
          <div className="sg-rows">
            {layout.rows.map(({ node, isExpanded }) => {
              const badge = stateBadge(node);
              const ownerLabel = node.isHumanOrigin
                ? `${shortSeat(node.sourceSession)} → ${shortSeat(node.destinationSession)}`
                : shortSeat(node.owner);
              return (
                <div key={node.qitemId} className={`sg-trow${node.isHumanOrigin ? " sg-human" : ""}`}>
                  <button
                    type="button"
                    className="sg-topline"
                    onClick={() => toggle(node.qitemId)}
                    aria-expanded={isExpanded}
                    data-testid={`story-row-${node.qitemId}`}
                  >
                    <span className="sg-cell">
                      <span className="sg-summary">{node.summary}</span>
                      <span className="sg-chev">{isExpanded ? "▲" : "▾"}</span>
                    </span>
                    <span className="sg-cell sg-owner">{ownerLabel}</span>
                    <span className={`sg-cell sg-state ${badge.cls}`}>
                      <span className="sg-sd" />
                      {badge.label}
                    </span>
                    <span className="sg-cell sg-date">{formatStoryDate(node.tsCreated)}</span>
                    <span className="sg-cell sg-qid">{node.qitemId}</span>
                  </button>
                  {isExpanded ? <StoryDetail node={node} forest={forest} /> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Estimate the expanded panel height so the gutter SVG can lay out lanes. The
 *  estimate is intentionally generous; the real DOM height may differ slightly
 *  but the lane geometry stays continuous because every node's centerY is on its
 *  54px topline. */
function estimateDetailHeight(node: StoryNode): number {
  const hasArtifacts = extractArtifacts(node.body).length > 0;
  // context (~36) + lineage band (~34) + optional artifacts (~34) + meta (~40) + padding
  return 36 + 34 + (hasArtifacts ? 34 : 0) + 40 + 22;
}

function StoryDetail({ node, forest }: { node: StoryNode; forest: StoryForest }) {
  const artifacts = extractArtifacts(node.body);
  const byId = useMemo(() => new Map(forest.nodes.map((n) => [n.qitemId, n])), [forest.nodes]);
  // Lineage chain: resolved ancestors (root->parent) -> self -> forward (handedOffTo / children).
  const ancestors = node.chain.filter((id) => byId.has(id));
  const children = forest.nodes.filter((n) => n.parentId === node.qitemId).map((n) => n.qitemId);

  return (
    <div className="sg-detail" data-testid={`story-detail-${node.qitemId}`}>
      <div className="sg-dctx">{bodyContext(node.body)}</div>
      <div className="sg-band">
        <div className="sg-bl">LINEAGE</div>
        <div className="sg-bc">
          <span className="sg-chain">
            {ancestors.map((id) => (
              <LineageRef key={id} node={byId.get(id)!} />
            ))}
            {ancestors.length > 0 ? <span className="sg-carrow">→</span> : null}
            <span className="sg-cnode sg-self">◆ this</span>
            {children.map((id) => (
              <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <span className="sg-carrow">→</span>
                <LineageRef node={byId.get(id)!} />
              </span>
            ))}
          </span>
        </div>
      </div>
      {artifacts.length > 0 ? (
        <div className="sg-band">
          <div className="sg-bl">ARTIFACTS</div>
          <div className="sg-bc">
            {artifacts.map((a) =>
              isViewableArtifact(a) ? (
                <FileLink
                  key={a}
                  absolutePath={a}
                  path={a}
                  className="sg-chip sg-chip-link"
                  testId={`story-artifact-${a}`}
                >
                  {a}
                </FileLink>
              ) : (
                <span
                  key={a}
                  className="sg-chip sg-chip-inert"
                  title="reference (not directly viewable)"
                >
                  {a}
                </span>
              ),
            )}
          </div>
        </div>
      ) : null}
      <div className="sg-metarow">
        {node.tags.length > 0 ? (
          <span className="sg-tags">
            {node.tags.slice(0, 8).map((t) => (
              <span key={t} className="sg-tagpill">
                {t}
              </span>
            ))}
          </span>
        ) : null}
        <span className="sg-fieldline">
          {shortSeat(node.sourceSession)} → {shortSeat(node.destinationSession)}
          {node.closureReason ? ` · ${node.closureReason}` : ""}
          {` · opened ${formatStoryDate(node.tsCreated)}`}
        </span>
        <QueueItemTrigger
          data={toViewerData(node)}
          testId={`story-open-${node.qitemId}`}
          className="sg-openlink"
        >
          Open full queue item →
        </QueueItemTrigger>
      </div>
    </div>
  );
}

function LineageRef({ node }: { node: StoryNode }) {
  return (
    <QueueItemTrigger
      data={toViewerData(node)}
      testId={`story-lineage-${node.qitemId}`}
      className="sg-cnode"
    >
      {node.qitemId} {shortSeat(node.destinationSession)}
    </QueueItemTrigger>
  );
}
