import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  RegisterWatchdogJobInput,
  WatchdogJob,
} from "./watchdog-jobs-repository.js";
import {
  renderRung1IncumbentNotice,
  renderRung2Baton,
  type ContinuitySeatIdentity,
} from "./continuity-stack-packets.js";

export type CompactionStrategy =
  | "default-compaction"
  | "managed-compaction"
  | "handover"
  | "apprentice-handover";

const DECIMAL_MEGABYTE = 1_000_000;
const DEFAULT_DENSE_SESSION_TOKENS_PER_MB = 153_000;
const PREPARE_TARGET_TOKENS = 600_000;
const CUTOVER_TARGET_TOKENS = 900_000;

export const CONTINUITY_POLICY_DOC = [
  "Transcript bytes are a calibrated proxy, not tokens: measured density on this VM ranged 113K–153K tokens/MB and varies by session shape.",
  "The conservative default uses the dense end of that range; a seat may supply its observed density when materializing its own registrations.",
  "The margin is the protection: sampling happens at a turn boundary, so a threshold tuned near the context wall can fire only after the safe window is already gone.",
  "The first product-path run is still a separate adoption receipt; hand-rolled hook runs are design evidence, never proof this path executed.",
].join(" ");

export interface ContinuityPolicyMaterializationInput {
  compactionStrategy: CompactionStrategy;
  runtime: string;
  targetSession: string;
  watchedFilePath: string;
  tokensPerMegabyte?: number;
  registeredBySession?: string;
  seatIdentity?: Partial<ContinuitySeatIdentity>;
}

export interface ContinuityWatchdogPlan extends RegisterWatchdogJobInput {
  key: "prepare" | "cutover";
  requiresKey: "prepare" | null;
}

export interface ContinuityPolicyPlan {
  jobs: ContinuityWatchdogPlan[];
  docText: string;
}

export interface ContinuityJobsRegistrar {
  register(input: RegisterWatchdogJobInput): Pick<WatchdogJob, "jobId">;
}

function thresholdBytes(targetTokens: number, tokensPerMegabyte: number): number {
  if (!Number.isFinite(tokensPerMegabyte) || tokensPerMegabyte <= 0) {
    throw new Error("tokensPerMegabyte must be a positive calibrated value");
  }
  return Math.floor((targetTokens / tokensPerMegabyte) * DECIMAL_MEGABYTE);
}

function seatIdentity(input: ContinuityPolicyMaterializationInput): ContinuitySeatIdentity {
  return {
    sessionName: input.targetSession,
    successorSessionName: input.seatIdentity?.successorSessionName ?? "<staged-successor>",
    predecessorResumeHandle: input.seatIdentity?.predecessorResumeHandle ?? "<verbatim-resume-handle>",
    mechanicDestination: input.seatIdentity?.mechanicDestination ?? "<mechanic-destination>",
  };
}

function watchdogSpec(message: string, targetSession: string, threshold: number): string {
  const inlineMessage = message.replace(/\s+/g, " ").trim();
  return [
    "policy: context-usage-threshold",
    "generated_by: continuity-policy-materializer",
    "target:",
    `  session: ${targetSession}`,
    `threshold_bytes: ${threshold}`,
    `message: ${JSON.stringify(inlineMessage)}`,
    "",
  ].join("\n");
}

export function materializeContinuityPolicy(
  input: ContinuityPolicyMaterializationInput,
): ContinuityPolicyPlan {
  if (input.runtime !== "claude-code" || input.compactionStrategy !== "apprentice-handover") {
    return { jobs: [], docText: CONTINUITY_POLICY_DOC };
  }
  if (!input.watchedFilePath.trim()) {
    throw new Error(`watched_file_unresolved: no Claude transcript found for ${input.targetSession}`);
  }
  const density = input.tokensPerMegabyte ?? DEFAULT_DENSE_SESSION_TOKENS_PER_MB;
  const prepareThreshold = thresholdBytes(PREPARE_TARGET_TOKENS, density);
  const cutoverThreshold = thresholdBytes(CUTOVER_TARGET_TOKENS, density);
  const identity = seatIdentity(input);
  const prepareMessage = `${renderRung1IncumbentNotice(identity)}\n\n${CONTINUITY_POLICY_DOC}`;
  const cutoverMessage = [
    `Continuity cutover threshold crossed for ${input.targetSession}.`,
    renderRung2Baton(identity).template,
  ].join("\n\n");
  const common = {
    policy: "context-usage-threshold",
    targetSession: input.targetSession,
    intervalSeconds: 60,
    scanIntervalSeconds: 60,
    activeWakeIntervalSeconds: null,
    registeredBySession: input.registeredBySession ?? "daemon@kernel",
    watchedFilePath: input.watchedFilePath,
  };
  return {
    docText: CONTINUITY_POLICY_DOC,
    jobs: [
      {
        ...common,
        key: "prepare",
        requiresKey: null,
        thresholdBytes: prepareThreshold,
        requiresJobId: null,
        specYaml: watchdogSpec(prepareMessage, input.targetSession, prepareThreshold),
      },
      {
        ...common,
        key: "cutover",
        requiresKey: "prepare",
        thresholdBytes: cutoverThreshold,
        requiresJobId: null,
        specYaml: watchdogSpec(cutoverMessage, input.targetSession, cutoverThreshold),
      },
    ],
  };
}

export function armContinuityPolicy(
  input: ContinuityPolicyMaterializationInput,
  registrar: ContinuityJobsRegistrar,
): Array<Pick<WatchdogJob, "jobId">> {
  const plan = materializeContinuityPolicy(input);
  const registered = new Map<string, Pick<WatchdogJob, "jobId">>();
  for (const job of plan.jobs) {
    const requiresJobId = job.requiresKey
      ? registered.get(job.requiresKey)?.jobId ?? null
      : null;
    const { key: _key, requiresKey: _requiresKey, ...registration } = job;
    const result = registrar.register({ ...registration, requiresJobId });
    registered.set(job.key, result);
  }
  return [...registered.values()];
}

export function findClaudeTranscriptByToken(projectsRoot: string, token: string): string | null {
  if (!token.trim() || !existsSync(projectsRoot)) return null;
  let directories: string[];
  try {
    directories = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  for (const directory of directories) {
    const candidate = join(projectsRoot, directory, `${token}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class ContinuityPolicyMaterializer {
  constructor(
    private readonly jobsRepository: ContinuityJobsRegistrar,
    private readonly resolveWatchedFilePath: (input: {
      sessionId: string;
      targetSession: string;
    }) => string | null,
  ) {}

  arm(input: Omit<ContinuityPolicyMaterializationInput, "watchedFilePath"> & { sessionId: string }): Array<Pick<WatchdogJob, "jobId">> {
    if (input.runtime !== "claude-code" || input.compactionStrategy !== "apprentice-handover") return [];
    const watchedFilePath = this.resolveWatchedFilePath(input);
    if (!watchedFilePath) {
      throw new Error(`watched_file_unresolved: no Claude transcript found for ${input.targetSession}`);
    }
    return armContinuityPolicy({ ...input, watchedFilePath }, this.jobsRepository);
  }
}
