import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

export interface CompactPlanDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (url: string) => DaemonClient;
}

interface RigEntry {
  rigId: string;
  name: string;
}

interface NodeEntry {
  rigId: string;
  rigName: string;
  logicalId: string;
  canonicalSessionName: string | null;
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: string | null;
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  contextUsage?: {
    usedPercentage: number | null;
    remainingPercentage: number | null;
    contextWindowSize: number | null;
    source: string | null;
    availability: string | null;
    sampledAt: string | null;
    fresh: boolean;
  };
}

interface BasePlanEntry {
  session: string | null;
  rig: string;
  logicalId: string;
  runtime: string;
  usedPercentage: number | null;
  contextWindowSize: number | null;
  estimatedUsedTokens: number | null;
  contextFreshness: "fresh" | "stale" | "unknown";
  sessionStatus: string | null;
  startupStatus: string | null;
}

interface CompactPlanThresholds {
  thresholdTokens: number;
  thresholdPercent: number;
}

interface CompactPlanSeatPolicy {
  oneSeatAtATime: true;
  autoCompactAllowed: false;
  explicitAuthorizationRequired: true;
}

interface NotificationPacket {
  recipient: string | null;
  subject: string;
  text: string;
}

interface CandidateEntry extends BasePlanEntry {
  status: "candidate_with_caveats";
  thresholdReason: string;
  reasons: string[];
  missingEvidence: string[];
  precompactRequirements: string[];
  seatPolicy: CompactPlanSeatPolicy;
  notificationPacket: NotificationPacket;
  nextAction: string;
}

interface BlockedEntry extends BasePlanEntry {
  status: "blocked";
  thresholdReason: string | null;
  reasons: string[];
  missingEvidence: string[];
  precompactRequirements: string[];
  seatPolicy: CompactPlanSeatPolicy;
  notificationPacket: NotificationPacket;
  nextAction: string;
}

interface SkippedEntry extends BasePlanEntry {
  status: "skipped";
  reason: string;
}

interface CompactPlanResult {
  summary: {
    totalSeats: number;
    claudeSeats: number;
    candidateCount: number;
    blockedCount: number;
    skippedCount: number;
    requiresAuthorization: true;
  };
  policy: {
    mode: "read_only_plan";
    defaultThresholdTokens: number;
    defaultThresholdPercent: number;
    thresholdTokens: number;
    thresholdPercent: number;
    oneSeatAtATime: true;
    autoCompactAllowed: false;
    explicitAuthorizationRequired: true;
  };
  recommendedOrder: string[];
  candidates: CandidateEntry[];
  blocked: BlockedEntry[];
  skipped: SkippedEntry[];
}

const DEFAULT_THRESHOLD_TOKENS = 400_000;
const PERCENT_FALLBACK_THRESHOLD = 80;
const FRESHNESS_THRESHOLD_S = 600;
const PRECOMPACT_REQUIREMENTS = [
  "fresh_context_sample",
  "checkpoint_or_restore_packet_verification",
  "explicit_operator_authorization",
  "one_seat_at_a_time_only",
  "post_compaction_restore_audit",
];
const SEAT_POLICY: CompactPlanSeatPolicy = {
  oneSeatAtATime: true,
  autoCompactAllowed: false,
  explicitAuthorizationRequired: true,
};

function defaultThresholds(): CompactPlanThresholds {
  return {
    thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
    thresholdPercent: PERCENT_FALLBACK_THRESHOLD,
  };
}

function estimateUsedTokens(usedPercentage: number | null, contextWindowSize: number | null): number | null {
  if (usedPercentage == null || contextWindowSize == null) return null;
  return Math.round(contextWindowSize * usedPercentage / 100);
}

function computeFreshness(contextUsage: NodeEntry["contextUsage"]): "fresh" | "stale" | "unknown" {
  if (!contextUsage || contextUsage.usedPercentage == null) return "unknown";
  if (contextUsage.sampledAt) {
    const ageSeconds = (Date.now() - new Date(contextUsage.sampledAt).getTime()) / 1000;
    return ageSeconds <= FRESHNESS_THRESHOLD_S ? "fresh" : "stale";
  }
  if (contextUsage.fresh) return "fresh";
  return "unknown";
}

function baseEntry(node: NodeEntry): BasePlanEntry {
  const usedPercentage = node.contextUsage?.usedPercentage ?? null;
  const contextWindowSize = node.contextUsage?.contextWindowSize ?? null;
  return {
    session: node.canonicalSessionName,
    rig: node.rigName,
    logicalId: node.logicalId,
    runtime: node.runtime ?? "unknown",
    usedPercentage,
    contextWindowSize,
    estimatedUsedTokens: estimateUsedTokens(usedPercentage, contextWindowSize),
    contextFreshness: computeFreshness(node.contextUsage),
    sessionStatus: node.sessionStatus,
    startupStatus: node.startupStatus,
  };
}

function isClaude(node: NodeEntry): boolean {
  return node.runtime === "claude-code";
}

function isSeatRunningReady(node: NodeEntry): boolean {
  return node.sessionStatus === "running" && node.startupStatus === "ready";
}

function candidateSortScore(candidate: CandidateEntry): number {
  return candidate.estimatedUsedTokens ?? ((candidate.usedPercentage ?? 0) * 1_000);
}

function notificationPacket(node: NodeEntry, status: "candidate_with_caveats" | "blocked", reasons: string[], missingEvidence: string[]): NotificationPacket {
  const recipient = node.canonicalSessionName;
  const subject = status === "candidate_with_caveats"
    ? `Compact-plan marshal check for ${node.logicalId}`
    : `Compact-plan evidence needed for ${node.logicalId}`;
  const session = recipient ?? node.logicalId;
  const text = status === "candidate_with_caveats"
    ? [
      `Read-only compact-plan flagged ${session} for one-seat-at-a-time Claude continuity triage.`,
      `Reasons: ${reasons.join(", ")}.`,
      `Before any compaction: verify checkpoint/restore evidence, get explicit operator authorization, compact only this seat, and audit restore after compact-in-place.`,
      `No automatic compaction has been run.`,
    ].join(" ")
    : [
      `Read-only compact-plan cannot safely plan ${session} yet.`,
      `Blockers: ${reasons.join(", ")}.`,
      `Missing evidence: ${missingEvidence.join(", ") || "none"}.`,
      `Resolve these before requesting one-seat-at-a-time compaction authorization.`,
    ].join(" ");
  return { recipient, subject, text };
}

function thresholdReason(base: BasePlanEntry, thresholds: CompactPlanThresholds): string | null {
  if (base.estimatedUsedTokens != null && base.estimatedUsedTokens >= thresholds.thresholdTokens) {
    return "above_token_threshold";
  }
  if (base.estimatedUsedTokens == null && (base.usedPercentage ?? 0) >= thresholds.thresholdPercent) {
    return "above_percent_threshold_missing_window";
  }
  return null;
}

function analyzeNode(node: NodeEntry, thresholds: CompactPlanThresholds): CandidateEntry | BlockedEntry | SkippedEntry {
  const base = baseEntry(node);

  if (!isClaude(node)) {
    return {
      ...base,
      status: "skipped",
      reason: node.runtime === "codex" ? "codex_not_managed_by_claude_compact_in_place" : "non_claude_runtime",
    };
  }

  const blockedReasons: string[] = [];
  const blockedMissingEvidence: string[] = [];
  if (!node.canonicalSessionName) {
    blockedReasons.push("missing_canonical_session");
    blockedMissingEvidence.push("canonical_session_name");
  }
  if (!isSeatRunningReady(node)) {
    blockedReasons.push("seat_not_running_or_ready");
  }
  if (base.usedPercentage == null) {
    blockedReasons.push("context_unknown");
    blockedMissingEvidence.push("context_usage");
  }

  if (blockedReasons.length > 0) {
    return {
      ...base,
      status: "blocked",
      thresholdReason: thresholdReason(base, thresholds),
      reasons: blockedReasons,
      missingEvidence: blockedMissingEvidence,
      precompactRequirements: PRECOMPACT_REQUIREMENTS,
      seatPolicy: SEAT_POLICY,
      notificationPacket: notificationPacket(node, "blocked", blockedReasons, blockedMissingEvidence),
      nextAction: "Resolve blocked seat state and collect fresh context before adding this seat to marshal triage.",
    };
  }

  const reason = thresholdReason(base, thresholds);
  if (!reason) {
    return {
      ...base,
      status: "skipped",
      reason: "below_threshold",
    };
  }

  const reasons = [
    reason,
    "authorization_required",
  ];
  const missingEvidence = ["checkpoint_or_restore_packet_verification"];

  if (base.contextWindowSize == null) {
    missingEvidence.push("context_window_size");
  }
  if (base.contextFreshness === "stale") {
    reasons.push("context_stale");
    missingEvidence.push("fresh_context_sample");
  } else if (base.contextFreshness === "unknown") {
    reasons.push("context_freshness_unknown");
    missingEvidence.push("fresh_context_sample");
  }
  if (!node.tmuxAttachCommand && !node.resumeCommand) {
    missingEvidence.push("attach_or_resume_evidence");
  }

  return {
    ...base,
    status: "candidate_with_caveats",
    thresholdReason: reason,
    reasons,
    missingEvidence,
    precompactRequirements: PRECOMPACT_REQUIREMENTS,
    seatPolicy: SEAT_POLICY,
    notificationPacket: notificationPacket(node, "candidate_with_caveats", reasons, missingEvidence),
    nextAction: "Verify checkpoint/restore evidence, get explicit authorization, compact one Claude seat, then audit restore using claude-compact-in-place.",
  };
}

function buildPlan(nodes: NodeEntry[], thresholds = defaultThresholds()): CompactPlanResult {
  const candidates: CandidateEntry[] = [];
  const blocked: BlockedEntry[] = [];
  const skipped: SkippedEntry[] = [];

  for (const node of nodes) {
    const entry = analyzeNode(node, thresholds);
    if (entry.status === "candidate_with_caveats") candidates.push(entry);
    else if (entry.status === "blocked") blocked.push(entry);
    else skipped.push(entry);
  }

  candidates.sort((a, b) => {
    const score = candidateSortScore(b) - candidateSortScore(a);
    if (score !== 0) return score;
    return (a.session ?? a.logicalId).localeCompare(b.session ?? b.logicalId);
  });

  return {
    summary: {
      totalSeats: nodes.length,
      claudeSeats: nodes.filter(isClaude).length,
      candidateCount: candidates.length,
      blockedCount: blocked.length,
      skippedCount: skipped.length,
      requiresAuthorization: true,
    },
    policy: {
      mode: "read_only_plan",
      defaultThresholdTokens: DEFAULT_THRESHOLD_TOKENS,
      defaultThresholdPercent: PERCENT_FALLBACK_THRESHOLD,
      thresholdTokens: thresholds.thresholdTokens,
      thresholdPercent: thresholds.thresholdPercent,
      oneSeatAtATime: true,
      autoCompactAllowed: false,
      explicitAuthorizationRequired: true,
    },
    recommendedOrder: candidates
      .map((candidate) => candidate.session)
      .filter((session): session is string => Boolean(session)),
    candidates,
    blocked,
    skipped,
  };
}

function printHuman(plan: CompactPlanResult): void {
  console.log("READ-ONLY PLAN - does not compact");
  console.log("Policy: read_only_plan; one-seat-at-a-time marshal triage; autoCompactAllowed=false; explicit authorization required.");
  console.log(`Thresholds: ${plan.policy.thresholdTokens} estimated tokens; ${plan.policy.thresholdPercent}% when context window size is missing.`);
  console.log(`Summary: ${plan.summary.candidateCount} candidates | ${plan.summary.blockedCount} blocked | ${plan.summary.skippedCount} skipped`);
  console.log();

  if (plan.recommendedOrder.length > 0) {
    console.log("One-seat-at-a-time recommended marshal triage order:");
    for (const [index, session] of plan.recommendedOrder.entries()) {
      console.log(`  ${index + 1}. ${session}`);
    }
  } else {
    console.log("One-seat-at-a-time recommended marshal triage order: none");
  }

  if (plan.candidates.length > 0) {
    console.log();
    console.log("Candidates with caveats:");
    for (const candidate of plan.candidates) {
      const estimate = candidate.estimatedUsedTokens == null ? "unknown tokens" : `${candidate.estimatedUsedTokens} estimated tokens`;
      console.log(`  - ${candidate.session}: ${estimate}; threshold=${candidate.thresholdReason}; reasons=${candidate.reasons.join(", ")}; missing=${candidate.missingEvidence.join(", ")}`);
      console.log(`    Notify: ${candidate.notificationPacket.text}`);
    }
  }

  if (plan.blocked.length > 0) {
    console.log();
    console.log("Blocked / not safely plannable:");
    for (const blocked of plan.blocked) {
      console.log(`  - ${blocked.session ?? blocked.logicalId}: reasons=${blocked.reasons.join(", ")}; missing=${blocked.missingEvidence.join(", ") || "none"}`);
      console.log(`    Notify: ${blocked.notificationPacket.text}`);
    }
  }

  console.log();
  console.log("Next action: verify checkpoint/restore evidence, get explicit authorization, compact one Claude seat only, then audit restore with claude-compact-in-place.");
}

export function compactPlanCommand(depsOverride?: CompactPlanDeps): Command {
  const cmd = new Command("compact-plan")
    .description("Plan Claude compact-in-place candidates without compacting anything")
    .addHelpText("after", `
Examples:
  rig compact-plan                    Show a read-only Claude compaction triage plan
  rig compact-plan --rig openrig-pm   Plan one rig only
  rig compact-plan --refresh          Re-sample context before planning
  rig compact-plan --json             JSON output for agents`);

  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--json", "JSON output for agents")
    .option("--rig <name>", "Plan one rig only")
    .option("--refresh", "Re-sample context usage before planning")
    .option("--threshold-tokens <n>", "Estimated used-token threshold for Claude compact-plan candidates")
    .option("--threshold-percent <0-100>", "Used-percent threshold when context window size is missing")
    .action(async (opts: { json?: boolean; rig?: string; refresh?: boolean; thresholdTokens?: string; thresholdPercent?: string }) => {
      const deps = getDepsF();
      const thresholds = parseThresholdOptions(opts);
      if (!thresholds.ok) {
        console.error(thresholds.error);
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon is not running. Start it with: rig daemon start");
        console.error("Cannot build compact-plan without current read-only rig inventory.");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));

      try {
        const psResult = await client.get<RigEntry[]>("/api/ps");
        const rigs = psResult.data ?? [];
        const targetRigs = opts.rig ? rigs.filter((rig) => rig.name === opts.rig) : rigs;

        if (opts.rig && targetRigs.length === 0) {
          console.error(`Rig "${opts.rig}" not found. List rigs with: rig ps`);
          process.exitCode = 1;
          return;
        }

        if (opts.refresh && targetRigs.length > 0) {
          const firstRig = targetRigs[0]!;
          try {
            const refreshResult = await client.get(`/api/rigs/${firstRig.rigId}/nodes?refresh=true`);
            if (refreshResult.status >= 400) {
              console.error("Compact-plan refresh failed. Data may be stale.");
              console.error(`Detail: ${JSON.stringify(refreshResult.data)}`);
              console.error("Fix: retry without --refresh to see stale data, or check daemon logs.");
              process.exitCode = 2;
              return;
            }
          } catch (refreshErr) {
            console.error("Compact-plan refresh failed. Data may be stale.");
            console.error(`Detail: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`);
            console.error("Fix: retry without --refresh to see stale data, or check daemon logs.");
            process.exitCode = 2;
            return;
          }
        }

        const allNodes: NodeEntry[] = [];
        for (const rig of targetRigs) {
          const nodesResult = await client.get<NodeEntry[]>(`/api/rigs/${rig.rigId}/nodes`);
          if (Array.isArray(nodesResult.data)) {
            allNodes.push(...nodesResult.data);
          }
        }

        const plan = buildPlan(allNodes, thresholds.value);
        if (opts.json) {
          console.log(JSON.stringify(plan, null, 2));
        } else {
          printHuman(plan);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        console.error("Fix: check daemon status with: rig daemon status");
        process.exitCode = 2;
      }
    });

  return cmd;
}

function parseThresholdOptions(opts: { thresholdTokens?: string; thresholdPercent?: string }): { ok: true; value: CompactPlanThresholds } | { ok: false; error: string } {
  const thresholds = defaultThresholds();

  if (opts.thresholdTokens != null) {
    const value = Number(opts.thresholdTokens);
    if (!Number.isInteger(value) || value <= 0) {
      return { ok: false, error: "--threshold-tokens must be a positive integer" };
    }
    thresholds.thresholdTokens = value;
  }

  if (opts.thresholdPercent != null) {
    const value = Number(opts.thresholdPercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return { ok: false, error: "--threshold-percent must be a number from 0 to 100" };
    }
    thresholds.thresholdPercent = value;
  }

  return { ok: true, value: thresholds };
}
