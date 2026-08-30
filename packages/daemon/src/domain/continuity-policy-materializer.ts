import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  RegisterWatchdogJobInput,
  WatchdogJob,
} from "./watchdog-jobs-repository.js";
import {
  buildWidthRecoveryReceipt,
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
  "Retune threshold_bytes from a measured transcript-density sample for that seat; never copy the default blindly across session shapes.",
  "The margin is the protection: sampling happens at a turn boundary, so a threshold tuned near the context wall can fire only after the safe window is already gone.",
  "The first product-path run is still a separate adoption receipt; hand-rolled hook runs are design evidence, never proof this path executed.",
].join(" ");

export interface ContinuityPolicyMaterializationInput {
  compactionStrategy: CompactionStrategy;
  runtime: string;
  targetSession: string;
  watchedFilePath: string | null;
  /** Explicit cutover executor. Required only by apprentice-handover. */
  mechanic?: string;
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

type StoredContinuityJob = Pick<
  WatchdogJob,
  "jobId" | "state" | "specYaml" | "requiresJobId"
> & Partial<Pick<
  WatchdogJob,
  | "watchedFilePath"
  | "thresholdBytes"
  | "intervalSeconds"
  | "activeWakeIntervalSeconds"
  | "scanIntervalSeconds"
  | "registeredBySession"
  | "terminalReason"
  | "watchedFileGeneration"
  | "lastFiredGeneration"
>>;

export interface ContinuityJobsRegistrar {
  register(input: RegisterWatchdogJobInput): Pick<WatchdogJob, "jobId">;
  markTerminal?(jobId: string, reason: string): void;
  listExactTuple?(
    policy: string,
    targetSession: string,
    targetGenerationUuid: string | null,
  ): StoredContinuityJob[];
}

export interface ContinuityCutoverAction {
  type: "create-cutover-baton";
  jobId: string;
  occupantGeneration: string;
  sourceSession: string;
  destination: string;
  body: string;
}

export interface ContinuityQueueWriter {
  create(input: {
    qitemId: string;
    sourceSession: string;
    destinationSession: string;
    body: string;
    nudge?: boolean;
  }): Promise<{ qitemId: string }>;
}

export interface ContinuityHistoryWriter {
  record(input: {
    jobId: string;
    evaluatedAt: string;
    outcome: "skipped";
    skipReason: string;
    evaluationNotes: Record<string, unknown>;
  }): unknown;
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
    mechanicDestination: input.mechanic!,
  };
}

function watchdogSpec(input: {
  message: string;
  targetSession: string;
  threshold: number;
  continuityMode: CompactionStrategy;
  continuityAction?: { destination: string; body: string };
}): string {
  const inlineMessage = input.message.replace(/\s+/g, " ").trim();
  return [
    "policy: context-usage-threshold",
    "generated_by: continuity-policy-materializer",
    `continuity_mode: ${input.continuityMode}`,
    "target:",
    `  session: ${input.targetSession}`,
    `threshold_bytes: ${input.threshold}`,
    `message: ${JSON.stringify(inlineMessage)}`,
    ...(input.continuityAction
      ? [
          "context:",
          "  continuity_action:",
          "    type: create-cutover-baton",
          `    destination: ${JSON.stringify(input.continuityAction.destination)}`,
          `    body: ${JSON.stringify(input.continuityAction.body.replace(/\s+/g, " ").trim())}`,
        ]
      : []),
    "",
  ].join("\n");
}

function materializesContinuityJobs(
  input: Pick<ContinuityPolicyMaterializationInput, "runtime" | "compactionStrategy">,
): boolean {
  return input.runtime === "claude-code" &&
    (input.compactionStrategy === "apprentice-handover" || input.compactionStrategy === "managed-compaction");
}

export function materializeContinuityPolicy(
  input: ContinuityPolicyMaterializationInput,
): ContinuityPolicyPlan {
  if (!materializesContinuityJobs(input)) {
    return { jobs: [], docText: CONTINUITY_POLICY_DOC };
  }
  if (input.compactionStrategy === "apprentice-handover" && !input.mechanic) {
    throw new Error(
      "mechanic is required for apprentice-handover; declare a canonical seat@rig at spec-default, profile, or member lifecycle level, then follow continuity/apprentice-cutover.md",
    );
  }
  const density = input.tokensPerMegabyte ?? DEFAULT_DENSE_SESSION_TOKENS_PER_MB;
  const prepareThreshold = thresholdBytes(PREPARE_TARGET_TOKENS, density);
  const watchedFilePath = input.watchedFilePath?.trim() || null;
  const common = {
    policy: "context-usage-threshold",
    targetSession: input.targetSession,
    intervalSeconds: 60,
    scanIntervalSeconds: 60,
    activeWakeIntervalSeconds: null,
    registeredBySession: input.registeredBySession ?? "daemon@kernel",
    watchedFilePath,
  };
  if (input.compactionStrategy === "managed-compaction") {
    const prepareMessage = [
      `Managed compaction preparation threshold crossed for ${input.targetSession}.`,
      "Deposit continuity context now with rig context recap-write before the enforcer reaches its compaction threshold; this nudge prepares and never compacts.",
      CONTINUITY_POLICY_DOC,
    ].join("\n\n");
    return {
      docText: CONTINUITY_POLICY_DOC,
      jobs: [{
        ...common,
        key: "prepare",
        requiresKey: null,
        thresholdBytes: prepareThreshold,
        requiresJobId: null,
        specYaml: watchdogSpec({
          message: prepareMessage,
          targetSession: input.targetSession,
          threshold: prepareThreshold,
          continuityMode: input.compactionStrategy,
        }),
      }],
    };
  }
  const cutoverThreshold = thresholdBytes(CUTOVER_TARGET_TOKENS, density);
  const identity = seatIdentity(input);
  const prepareMessage = `${renderRung1IncumbentNotice(identity)}\n\n${CONTINUITY_POLICY_DOC}`;
  const cutoverBaton = renderRung2Baton(identity);
  const cutoverMessage = [
    `Continuity cutover threshold crossed for ${input.targetSession}.`,
    cutoverBaton.template,
  ].join("\n\n");
  return {
    docText: CONTINUITY_POLICY_DOC,
    jobs: [
      {
        ...common,
        key: "prepare",
        requiresKey: null,
        thresholdBytes: prepareThreshold,
        requiresJobId: null,
        specYaml: watchdogSpec({
          message: prepareMessage,
          targetSession: input.targetSession,
          threshold: prepareThreshold,
          continuityMode: input.compactionStrategy,
        }),
      },
      {
        ...common,
        key: "cutover",
        requiresKey: "prepare",
        thresholdBytes: cutoverThreshold,
        requiresJobId: null,
        specYaml: watchdogSpec({
          message: cutoverMessage,
          targetSession: input.targetSession,
          threshold: cutoverThreshold,
          continuityMode: input.compactionStrategy,
          continuityAction: {
            destination: cutoverBaton.destination,
            body: cutoverBaton.template,
          },
        }),
      },
    ],
  };
}

export function armContinuityPolicy(
  input: ContinuityPolicyMaterializationInput,
  registrar: ContinuityJobsRegistrar,
): Array<Pick<WatchdogJob, "jobId">> {
  const plan = materializeContinuityPolicy(input);
  const existing = (registrar.listExactTuple?.(
    "context-usage-threshold",
    input.targetSession,
    null,
  ) ?? []).filter(
    (job) =>
      job.state !== "terminal" &&
      job.specYaml.includes("generated_by: continuity-policy-materializer"),
  );

  const retireUnexpected = (keep: Set<string>): void => {
    const stale = existing.filter((job) => !keep.has(job.jobId));
    if (stale.length > 0 && !registrar.markTerminal) {
      throw new Error(`continuity_policy_reconciliation_unsupported: ${input.targetSession}`);
    }
    for (const job of stale) {
      registrar.markTerminal!(job.jobId, "continuity_policy_reconciled");
    }
  };
  const matches = (
    job: StoredContinuityJob,
    desired: ContinuityWatchdogPlan,
    requiresJobId: string | null,
  ): boolean =>
    job.specYaml === desired.specYaml &&
    job.requiresJobId === requiresJobId &&
    job.watchedFilePath === (desired.watchedFilePath ?? null) &&
    job.thresholdBytes === (desired.thresholdBytes ?? null) &&
    job.intervalSeconds === desired.intervalSeconds &&
    job.activeWakeIntervalSeconds === (desired.activeWakeIntervalSeconds ?? null) &&
    job.scanIntervalSeconds === (desired.scanIntervalSeconds ?? null) &&
    job.registeredBySession === desired.registeredBySession;
  const isCurrentShapeCandidate = (job: StoredContinuityJob): boolean =>
    job.state === "active" ||
    (job.state === "stopped" &&
      job.terminalReason !== "continuity_policy_reconciled" &&
      job.terminalReason !== "registering generation retired (seat handover)");

  if (plan.jobs.length === 0) {
    retireUnexpected(new Set());
    return [];
  }

  if (plan.jobs.length === 1) {
    const exact = existing
      .filter((job) => isCurrentShapeCandidate(job) && matches(job, plan.jobs[0]!, null))
      .sort((a, b) => Number(b.state === "stopped") - Number(a.state === "stopped"))[0];
    if (exact) {
      retireUnexpected(new Set([exact.jobId]));
      return [exact];
    }
  } else {
    const exactPairs = existing
      .filter((job) => isCurrentShapeCandidate(job) && matches(job, plan.jobs[0]!, null))
      .flatMap((prepare) => {
        const cutover = existing.find((job) =>
          isCurrentShapeCandidate(job) && matches(job, plan.jobs[1]!, prepare.jobId)
        );
        return cutover ? [{ prepare, cutover }] : [];
      })
      .sort((a, b) =>
        Number(b.prepare.state === "stopped" || b.cutover.state === "stopped") -
        Number(a.prepare.state === "stopped" || a.cutover.state === "stopped")
      );
    const exact = exactPairs[0];
    if (exact) {
      retireUnexpected(new Set([exact.prepare.jobId, exact.cutover.jobId]));
      return [exact.prepare, exact.cutover];
    }
  }

  retireUnexpected(new Set());
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

function continuityBatonQitemId(action: ContinuityCutoverAction): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9-]/g, "-");
  return `qitem-continuity-${safe(action.jobId)}-${safe(action.occupantGeneration)}`;
}

/** Existing QueueRepository.create is the only custody writer; the deterministic id makes retry identity. */
export async function createContinuityCutoverBaton(
  action: ContinuityCutoverAction,
  queue: ContinuityQueueWriter,
): Promise<{ qitemId: string }> {
  return queue.create({
    qitemId: continuityBatonQitemId(action),
    sourceSession: action.sourceSession,
    destinationSession: action.destination,
    body: action.body,
    nudge: true,
  });
}

/** Append a post-restore width receipt to the one managed prep job for this occupant. */
export function recordManagedWidthReceipt(
  input: {
    sessionName: string;
    occupantGeneration: string | null;
    postRestoreUsedPercentage: number;
    saturationBoundPercentage: number;
    evaluatedAt?: string;
  },
  jobs: ContinuityJobsRegistrar,
  history: ContinuityHistoryWriter,
): { jobId: string; receipt: ReturnType<typeof buildWidthRecoveryReceipt> } | null {
  if (!input.occupantGeneration) {
    throw new Error(`continuity_width_receipt_generation_unresolved: ${input.sessionName}`);
  }
  const managed = (jobs.listExactTuple?.(
    "context-usage-threshold",
    input.sessionName,
    null,
  ) ?? []).filter((job) =>
    job.state !== "terminal" &&
    job.specYaml.includes("generated_by: continuity-policy-materializer") &&
    job.specYaml.includes("continuity_mode: managed-compaction")
  );
  // The shared enforcer also serves manual/default-mode compaction. No managed
  // registration means this callback is outside A9 and intentionally writes nothing.
  if (managed.length === 0) return null;
  if (managed.length !== 1) {
    throw new Error(
      `continuity_width_receipt_job_ambiguous: expected one managed prep job for ${input.sessionName}; found ${managed.length}`,
    );
  }
  const job = managed[0]!;
  if (
    job.watchedFileGeneration != null &&
    job.watchedFileGeneration !== input.occupantGeneration
  ) {
    throw new Error(
      `continuity_width_receipt_generation_mismatch: ${job.jobId} is bound to ${job.watchedFileGeneration}, not ${input.occupantGeneration}`,
    );
  }
  const receipt = buildWidthRecoveryReceipt({
    usedPercentage: input.postRestoreUsedPercentage,
    maximumUsablePercentage: input.saturationBoundPercentage,
  });
  history.record({
    jobId: job.jobId,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    outcome: "skipped",
    skipReason: "post_restore_width_receipt",
    evaluationNotes: {
      occupantGeneration: input.occupantGeneration,
      ...receipt,
    },
  });
  return { jobId: job.jobId, receipt };
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
    const watchedFilePath = materializesContinuityJobs(input)
      ? this.resolveWatchedFilePath(input)
      : null;
    return armContinuityPolicy({ ...input, watchedFilePath }, this.jobsRepository);
  }
}
