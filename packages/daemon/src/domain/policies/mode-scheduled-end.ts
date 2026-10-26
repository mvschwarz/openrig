// A person's mode ends at the scheduled end they chose: one watchdog job per application, on the same engine and clock as
// quiet hours' release (no scheduler of its own). Armed with the application, it ends that application only, with the
// same end-if-mine path as "I'm back", and never one the person already ended or switched away from. The account is the
// operator's to give: the job tells the kernel operator, which reads the account's facts and delivers it.
import type Database from "better-sqlite3";
import type { QueueCreateInput, QueueRepository } from "../queue-repository.js";
import type { WatchdogJobsRepository } from "../watchdog-jobs-repository.js";
import { HumanModeService, registryAvailability, type ModeApplication } from "../gateway/human-operating-modes.js";
import { loadHumanRegistry } from "../gateway/human-registry.js";
import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";

export const MODE_SCHEDULED_END_POLICY = "mode-scheduled-end";
/** The kernel's operator agent (pod operator, member agent), whose role guidance covers giving the account. */
export const KERNEL_OPERATOR_SESSION = "operator-agent@kernel";

const applicationSpec = (applicationId: string) => `applicationId: "${applicationId}"`;

/** One active job per application; an existing one is reused. */
export function armModeScheduledEnd(input: { jobsRepo: WatchdogJobsRepository; applicationId: string; entityId: string; scheduledEnd: string }): { jobId: string } {
  const existing = input.jobsRepo.listActive().find(
    (j) => j.policy === MODE_SCHEDULED_END_POLICY && j.specYaml.includes(applicationSpec(input.applicationId)));
  if (existing) return { jobId: existing.jobId };
  const job = input.jobsRepo.register({
    policy: MODE_SCHEDULED_END_POLICY,
    specYaml: ["context:", `  ${applicationSpec(input.applicationId)}`, `  entityId: "${input.entityId}"`, `  scheduledEnd: "${input.scheduledEnd}"`].join("\n"),
    targetSession: `${input.entityId}@external`,
    intervalSeconds: 60,
    registeredBySession: "daemon@kernel",
  });
  return { jobId: job.jobId };
}

export interface ModeScheduledEndInput {
  db: Database.Database;
  queueRepo: QueueRepository;
  jobsRepo: WatchdogJobsRepository;
  home: string;
  jobId: string;
  now?: Date;
}

/** The notice's stable id: one per application, so a retry finds what an earlier run already sent. */
export const modeEndNoticeId = (applicationId: string): string => `qitem-mode-end-${applicationId}`;

/** One evaluation. `not-yet`: before its time. `ended`: it ended at its time and the operator has the notice.
 *  `notice-pending`: it ended at its time, but the notice couldn't be created; the job stays active and the next run
 *  creates it. `already-ended`: ended by hand or by a switch, so nothing is done. `ended` and `already-ended` retire it. */
export async function runModeScheduledEnd(input: ModeScheduledEndInput):
  Promise<{ state: "not-yet" | "ended" | "notice-pending" | "already-ended"; notified?: string; why?: string }> {
  const job = input.jobsRepo.getById(input.jobId);
  const grab = (k: string) => job?.specYaml.match(new RegExp(`${k}:\\s*"([^"\\n]+)"`))?.[1];
  const applicationId = grab("applicationId");
  const scheduledEnd = grab("scheduledEnd");
  if (!job || job.state !== "active" || !applicationId || !scheduledEnd) return { state: "already-ended" };
  const now = input.now ?? new Date();
  const modes = new HumanModeService({ db: input.db, availability: registryAvailability(input.home), now: () => now });
  const app = modes.get(applicationId);
  if (!app) {
    input.jobsRepo.markTerminal(input.jobId, "the mode's record is gone");
    return { state: "already-ended" };
  }
  if (!app.endedAt) {
    if (now.getTime() < Date.parse(scheduledEnd)) return { state: "not-yet" };
    modes.endIfStill(applicationId, "scheduled", SCHEDULER);
  }
  const ended = modes.get(applicationId)!;
  // Ended by this job (now, or by a run that couldn't tell the operator): the notice is owed until its row exists.
  if (ended.endReason !== "scheduled" || ended.endedBy !== SCHEDULER) {
    input.jobsRepo.markTerminal(input.jobId, "the mode had already ended");
    return { state: "already-ended" };
  }
  const noticeId = modeEndNoticeId(applicationId);
  const existing = input.queueRepo.getById(noticeId);
  if (existing) {
    input.jobsRepo.markTerminal(input.jobId, `ended at its scheduled time; ${existing.destinationSession} told`);
    return { state: "ended", notified: existing.destinationSession };
  }
  const recipient = recipientFor(input, ended);
  if (!recipient.ok && !recipient.known) return { state: "notice-pending", why: recipient.why }; // stays active: asked again next run
  if (!recipient.ok) {
    // No address the queue would accept: say so on the job and stop, rather than retry a refusal forever.
    input.jobsRepo.markTerminal(input.jobId, `ended at its scheduled time; no notice: ${recipient.why}`);
    return { state: "ended", notified: undefined };
  }
  const notice = noticeFor(ended, scheduledEnd, noticeId, recipient);
  try {
    await input.queueRepo.create(notice);
  } catch {
    return { state: "notice-pending" }; // stays active: the next run creates it
  }
  input.jobsRepo.markTerminal(input.jobId, `ended at its scheduled time; ${recipient.to} told${recipient.why ? ` (${recipient.why})` : ""}`);
  return { state: "ended", notified: recipient.to };
}

const SCHEDULER = "daemon@kernel";

/** `known: false`: who can be told couldn't be established (the person registry or the address check failed), so nothing
 *  is decided yet. */
type Recipient = { ok: true; to: string; kind: "operator" | "applied-by" | "person"; why: string | null } | { ok: false; known: boolean; why: string };

/** Who's told, through the queue's own destination check: the kernel operator, which gives the account; where it isn't on
 *  this host, the seat that applied the mode, if the queue would accept it (a named operator outside a seat isn't a
 *  destination); otherwise the person, whose account it is. */
function recipientFor(input: ModeScheduledEndInput, ended: ModeApplication): Recipient {
  const unknown = (why: string): Recipient => ({ ok: false, known: false, why });
  // A check that throws hasn't said no.
  const accepts = (to: string): boolean | Error => { try { return input.queueRepo.acceptsDestination(to); } catch (error) { return error as Error; } };
  const operatorHere = !!input.db.prepare("SELECT 1 FROM sessions WHERE session_name = ? LIMIT 1").get(KERNEL_OPERATOR_SESSION);
  if (operatorHere) {
    const ok = accepts(KERNEL_OPERATOR_SESSION);
    if (ok instanceof Error) return unknown(`checking ${KERNEL_OPERATOR_SESSION} failed: ${ok.message}`);
    if (ok) return { ok: true, to: KERNEL_OPERATOR_SESSION, kind: "operator", why: null };
  }
  const noOperator = `${KERNEL_OPERATOR_SESSION} isn't on this host`;
  const applier = accepts(ended.startedBy);
  if (applier instanceof Error) return unknown(`checking ${ended.startedBy} failed: ${applier.message}`);
  if (applier) return { ok: true, to: ended.startedBy, kind: "applied-by", why: noOperator };
  // The queue's check reads the person registry too, and reads an unreadable one as "not registered" (for an applier
  // addressed as a person, too): read it here, so a registry that can't be read is "can't tell yet", never "nobody to tell".
  const reg = loadHumanRegistry(input.home);
  if (!reg.ok) return unknown(`the person registry couldn't be read: ${reg.error}`);
  const notSeat = `${ended.startedBy}, who applied it, isn't an address the queue accepts`;
  const person = reg.entities.find((e) => e.entityId === ended.entityId)?.address;
  if (!person) return { ok: false, known: true, why: `${noOperator}, ${notSeat}, and ${ended.entityId} isn't registered` };
  const toPerson = accepts(person);
  if (toPerson instanceof Error) return unknown(`checking ${person} failed: ${toPerson.message}`);
  if (toPerson) return { ok: true, to: person, kind: "person", why: `${noOperator}, and ${notSeat}` };
  return { ok: false, known: true, why: `${noOperator}, ${notSeat}, and ${person} isn't an address the queue accepts` };
}

function noticeFor(ended: ModeApplication, scheduledEnd: string, qitemId: string, recipient: Extract<Recipient, { ok: true }>): QueueCreateInput {
  const account = `rig gateway human mode account ${ended.entityId} ${ended.applicationId}`;
  if (recipient.kind === "person") {
    // The person's own: an update, never a decision to answer.
    return {
      qitemId,
      sourceSession: SCHEDULER,
      destinationSession: recipient.to,
      humanIntent: "update",
      summary: `Your ${ended.modeName} ended at its scheduled time`,
      body: `Your ${ended.modeName} ended at its scheduled time. Its account: \`${account}\`; ask your operator to go through it.`,
      tags: ["mode-scheduled-end"],
      wakeTrigger: "openrig",
    };
  }
  const where = ended.settings.delivery.account ?? "their registered channel";
  return {
    qitemId,
    sourceSession: SCHEDULER,
    destinationSession: recipient.to,
    summary: `${ended.entityId}'s ${ended.modeName} ended at its scheduled time`,
    body: [
      `${ended.entityId}'s ${ended.modeName} ended at its scheduled time (${scheduledEnd}; ended ${ended.endedAt}).`,
      `Give them the account where the mode's delivery says: ${where}. Read the facts first:`,
      `  ${account}`,
      `Applied by ${ended.startedBy}.${recipient.why ? ` Sent to ${recipient.to} because ${recipient.why}.` : ""}`,
    ].join("\n"),
    tags: ["mode-scheduled-end"],
    wakeTrigger: "openrig",
  };
}

/** The waiting skip: a quiet reason in the engine, so a mode waiting to end leaves no history row or event each minute. */
export const MODE_END_NOT_YET = "mode_end_not_yet";

/** Watchdog-engine wrapper: the scheduler's cadence drives evaluation; the application's own record owns the timing. */
export function makeModeScheduledEndPolicy(deps: Omit<ModeScheduledEndInput, "jobId" | "now">): Policy {
  return {
    name: MODE_SCHEDULED_END_POLICY,
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const r = await runModeScheduledEnd({ ...deps, jobId: job.jobId });
      if (r.state === "not-yet") return { action: "skip", reason: MODE_END_NOT_YET };
      if (r.state === "notice-pending") return { action: "skip", reason: `ended; the notice is still to be created${r.why ? `: ${r.why}` : ""}` };
      return { action: "terminal", reason: r.state === "ended" ? "mode ended at its scheduled time" : "mode had already ended" };
    },
  } as Policy;
}
