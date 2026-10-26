import { statSync } from "node:fs";
import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";

export interface ContextUsageConditionSource {
  measure(job: PolicyJob): number;
}

const transcriptByteSource: ContextUsageConditionSource = {
  measure: (job) => statSync(job.watchedFilePath ?? "").size,
};

/**
 * Issue #1180 — the threshold unit a job is gated by. Exactly one is set at
 * registration: transcript bytes (legacy), sampled tokens, or percent of the
 * seat's own reported context window.
 */
type ThresholdUnit = "bytes" | "tokens" | "percent";

function thresholdUnit(job: PolicyJob): ThresholdUnit {
  if (job.thresholdTokens != null) return "tokens";
  if (job.thresholdPercent != null) return "percent";
  return "bytes";
}

export function makeContextUsageThresholdPolicy(
  source: ContextUsageConditionSource = transcriptByteSource,
): Policy {
  return {
    name: "context-usage-threshold",
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const unit = thresholdUnit(job);
      const threshold = unit === "tokens"
        ? job.thresholdTokens
        : unit === "percent"
          ? job.thresholdPercent
          : job.thresholdBytes;
      if (threshold == null) {
        return { action: "terminal", reason: "threshold_invalid" };
      }
      if (!job.occupantGeneration) {
        return {
          action: "terminal",
          reason: "occupant_generation_unresolved",
          notes: { targetSession: job.target.session },
        };
      }
      if (job.lastFiredGeneration === job.occupantGeneration) {
        // Keep one post-fire receipt observation in history, then make the
        // stable once-per-generation no-op quiet so a long-lived job does not
        // append a row on every scheduler interval.
        return {
          action: "skip",
          reason: job.lastEvaluationAt === job.lastFireAt
            ? "threshold_already_fired"
            : "threshold_receipt_stable",
          notes: {
            occupantGeneration: job.occupantGeneration,
            watchedFilePath: job.watchedFilePath,
          },
        };
      }
      if (unit === "bytes" && job.currentGenerationTranscriptPending) {
        return {
          action: "skip",
          reason: "current_generation_transcript_pending",
          notes: {
            targetSession: job.target.session,
            occupantGeneration: job.occupantGeneration,
          },
        };
      }

      let observed: { value: number; notes: Record<string, unknown> };
      if (unit === "bytes") {
        let observedBytes: number;
        try {
          observedBytes = source.measure(job);
        } catch (error) {
          return {
            action: "terminal",
            reason: "watched_file_unresolved",
            notes: {
              watchedFilePath: job.watchedFilePath,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
        observed = {
          value: observedBytes,
          notes: { observedBytes, watchedFilePath: job.watchedFilePath },
        };
      } else {
        // Token/percent jobs trigger on the seat's SAMPLED context use, not a
        // transcript-byte proxy (issue #1180). A seat only samples on a turn,
        // so a missing or stale sample never fires — frozen telemetry must not
        // hand a context over. The watch tells its target once per occupant and
        // reason that it can't read the sample, then stays quiet while nothing
        // changes; that notice is not the threshold, so a later fresh sample
        // still fires.
        const unreadable = (reason: string, detail: string, notes: Record<string, unknown>): PolicyEvaluation => {
          // The receipt names every reason already told to this occupant, so alternating reasons don't repeat.
          const prefix = `unreadable:${job.occupantGeneration}:`;
          const told = job.lastFiredCondition?.startsWith(prefix) ? job.lastFiredCondition.slice(prefix.length).split(",") : [];
          if (told.includes(reason)) {
            return { action: "skip", reason: "context_sample_unreadable_notified", notes: { ...notes, unreadable: reason } };
          }
          const level = unit === "percent" ? `${threshold}%` : `${threshold}-token`;
          return {
            action: "send",
            target: job.target,
            message: `Context watch ${job.jobId} can't read ${job.target.session}'s context use (${detail}), so it can't tell ` +
              `whether the ${level} threshold is reached. It acts on the next fresh sample, and won't repeat this for this occupant.`,
            notes: { ...notes, unreadable: reason },
            conditionReceipt: prefix + [...told, reason].sort().join(","),
            notice: true,
          };
        };
        const sample = job.contextUsageSample;
        const seat = { targetSession: job.target.session, occupantGeneration: job.occupantGeneration };
        if (!sample || (sample.usedPercentage == null && sample.usedTokens == null)) {
          return unreadable("context_sample_unavailable", "no sample for this occupant yet", seat);
        }
        if (!sample.fresh) {
          return unreadable("context_sample_stale", `its last sample, at ${sample.sampledAt}, is 10 or more minutes old`,
            { ...seat, sampledAt: sample.sampledAt });
        }
        if (unit === "percent") {
          if (sample.usedPercentage == null) {
            return unreadable("context_sample_unavailable", "the sample has no percentage", seat);
          }
          observed = {
            value: sample.usedPercentage,
            notes: {
              observedPercent: sample.usedPercentage,
              contextWindowSize: sample.contextWindowSize,
            },
          };
        } else {
          if (sample.usedTokens == null) {
            // compact-plan's fallback is percent; here the operator asked for a
            // token count, so an unknown window is honest insufficiency.
            return unreadable("context_window_unknown", "the sample has no token count or window size",
              { ...seat, usedPercentage: sample.usedPercentage });
          }
          observed = {
            value: sample.usedTokens,
            notes: {
              observedTokens: sample.usedTokens,
              contextWindowSize: sample.contextWindowSize,
            },
          };
        }
      }
      if (observed.value < threshold) {
        return {
          action: "skip",
          reason: "context_usage_below_threshold",
          notes: {
            ...observed.notes,
            ...(unit === "bytes"
              ? { thresholdBytes: threshold }
              : { threshold, unit }),
          },
        };
      }
      if (job.requiresJobId && !job.requiredReceiptSatisfied) {
        return {
          action: "skip",
          reason: job.requiredReceiptDeferred
            ? "required_watchdog_receipt_not_yet_eligible"
            : "required_watchdog_receipt_missing",
          notes: {
            requiresJobId: job.requiresJobId,
            occupantGeneration: job.occupantGeneration,
          },
        };
      }

      const observedLabel = unit === "bytes"
        ? `${observed.value} transcript bytes`
        : unit === "tokens"
          ? `${observed.value} sampled context tokens`
          : `${observed.value}% of the seat's context window`;
      const reason =
        `${observedLabel} crossed the ${threshold}-${unit === "bytes" ? "byte" : unit} threshold ` +
        `for occupant ${job.occupantGeneration}.`;
      return {
        action: "send",
        target: job.target,
        message: job.message ?? `Context usage threshold crossed for ${job.target.session}. ${reason}`,
        notes: {
          reason,
          ...observed.notes,
          ...(unit === "bytes"
            ? { thresholdBytes: threshold }
            : { threshold, unit, sampledAt: job.contextUsageSample?.sampledAt ?? null }),
          occupantGeneration: job.occupantGeneration,
        },
      };
    },
  };
}

export const contextUsageThresholdPolicy = makeContextUsageThresholdPolicy();
