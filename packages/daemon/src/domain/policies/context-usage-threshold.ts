import { statSync } from "node:fs";
import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";

export interface ContextUsageConditionSource {
  measure(job: PolicyJob): number;
}

const transcriptByteSource: ContextUsageConditionSource = {
  measure: (job) => statSync(job.watchedFilePath ?? "").size,
};

export function makeContextUsageThresholdPolicy(
  source: ContextUsageConditionSource = transcriptByteSource,
): Policy {
  return {
    name: "context-usage-threshold",
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      if (!job.thresholdBytes) {
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
      if (job.currentGenerationTranscriptPending) {
        return {
          action: "skip",
          reason: "current_generation_transcript_pending",
          notes: {
            targetSession: job.target.session,
            occupantGeneration: job.occupantGeneration,
          },
        };
      }

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
      if (observedBytes < job.thresholdBytes) {
        return {
          action: "skip",
          reason: "context_usage_below_threshold",
          notes: {
            observedBytes,
            thresholdBytes: job.thresholdBytes,
            watchedFilePath: job.watchedFilePath,
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

      const reason =
        `${observedBytes} transcript bytes crossed the ${job.thresholdBytes}-byte threshold ` +
        `for occupant ${job.occupantGeneration}.`;
      return {
        action: "send",
        target: job.target,
        message: job.message ?? `Context usage threshold crossed for ${job.target.session}. ${reason}`,
        notes: {
          reason,
          observedBytes,
          thresholdBytes: job.thresholdBytes,
          watchedFilePath: job.watchedFilePath,
          occupantGeneration: job.occupantGeneration,
        },
      };
    },
  };
}

export const contextUsageThresholdPolicy = makeContextUsageThresholdPolicy();
