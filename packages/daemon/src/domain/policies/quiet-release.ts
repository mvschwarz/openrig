// Quiet hours: releasing what was held. While a person's quiet window is on, a routine ask is recorded on its row with
// one exact hold note and posts nothing. One release job per quiet window, on the watchdog substrate (no timer of its
// own), checks the person's quiet state each time it's evaluated:
// - while quiet is on, it does nothing; so extending or replacing the window, or a job evaluated early, releases nothing;
// - once quiet is off ("I'm back", a clear, or the end of the window), each held ask that is still eligible is posted
//   individually through the ordinary gateway path, as itself: its full brief, its actual recipient and its reply
//   identity, with no mention and no second digest wait. An ask whose situation changed gets a visible disposition
//   instead;
// - the job stays until every held ask has its posted receipt or a disposition, so a restart or a failed post is
//   redriven, and the gateway's decision id makes a re-dispatch converge on one post;
// - a dispatched release can wait in the gateway's buffer and be replayed after a restart, so the gateway checks it
//   again at post time (the same `releaseVerdict`): quiet back on keeps it held for the job, and a changed row,
//   recipient or posting threshold gives the same disposition the job would. Nothing posts into changed circumstances.

import type { QueueRepository } from "../queue-repository.js";
import { isBlockerLive } from "../queue-repository.js";
import type { WatchdogJobsRepository } from "../watchdog-jobs-repository.js";
import { makeQueuePorts } from "../gateway/slack/queue-access.js";
import { OUTBOUND_OP, toPayload } from "../gateway/slack/outbound-driver.js";
import { loadConfig } from "../gateway/slack/config.js";
import { HumanQuietStore, quietHoldFor } from "../gateway/human-quiet-windows.js";
import type { QueueItem } from "../gateway/slack/queue-access.js";
import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";

export const QUIET_RELEASE_POLICY = "quiet-release";
const HOLD_PREFIX = "delivery-decision: quiet-hold";
const DISPATCHED_PREFIX = "quiet-release-dispatched";
export const DISPOSITION_PREFIX = "quiet-release-disposition";
const RETURNED_PREFIX = "quiet-release-returned";

export interface QuietHold {
  windowId: string;
  occurrence: string;
  revision: number;
  notificationKey: string;
}

/** The one form of the hold note. Its prefix isn't the digest's, so the 4h/daily flush can never select it. */
export function formatQuietHoldNote(hold: QuietHold): string {
  return `${HOLD_PREFIX} window=${hold.windowId} occurrence=${hold.occurrence} revision=${hold.revision} notification_key=${hold.notificationKey}`;
}

export function parseQuietHoldNote(note: string): QuietHold | null {
  const m = /^delivery-decision: quiet-hold window=(\S+) occurrence=(\S+) revision=(\d+) notification_key=(\S+)$/.exec(note);
  return m ? { windowId: m[1]!, occurrence: m[2]!, revision: Number(m[3]), notificationKey: m[4]! } : null;
}

export const hasToken = (note: string, prefix: string, key: string): boolean =>
  note.startsWith(`${prefix} `) && note.split(/\s+/).includes(`notification_key=${key}`);

/** Record a held ask on its row (once per episode) and make sure its window's release job is armed: one SQLite
 *  transaction, so a hold note never commits without the job that releases it (or the reverse). */
export function holdForQuiet(input: {
  queueRepo: QueueRepository;
  jobsRepo: WatchdogJobsRepository;
  qitemId: string;
  entityId: string;
  hold: QuietHold;
}): void {
  noteWithReleaseJob(input.queueRepo, input.jobsRepo, input.hold.windowId, input.entityId, input.qitemId, (notes) =>
    notes.some((n) => parseQuietHoldNote(n)?.notificationKey === input.hold.notificationKey) ? null : formatQuietHoldNote(input.hold));
}

/** Arm the window's release job and write a note on the row, together or not at all. `note` returns the note to write,
 *  or null when the row already has it. Events from the note are delivered only after the transaction commits. */
function noteWithReleaseJob(queueRepo: QueueRepository, jobsRepo: WatchdogJobsRepository, windowId: string, entityId: string,
  qitemId: string, note: (existing: string[]) => string | null): void {
  const events = queueRepo.db.transaction(() => {
    armQuietRelease({ jobsRepo, windowId, entityId });
    const text = note(queueRepo.listTransitions(qitemId).map((t) => t.transitionNote ?? ""));
    return text ? queueRepo.updateWithinTransaction({ qitemId, actorSession: "daemon@kernel", transitionNote: text }).persistedEvents : [];
  })();
  queueRepo.notifyCommitted(events);
}

/** How a release job's spec names its window: the job lookup here and custody's read both match on it. */
export const releaseJobWindowSpec = (windowId: string): string => `windowId: "${windowId}"`;

/** One active release job per quiet window; an existing one is reused. */
export function armQuietRelease(input: { jobsRepo: WatchdogJobsRepository; windowId: string; entityId: string }): { jobId: string } {
  const existing = input.jobsRepo.listActive().find(
    (j) => j.policy === QUIET_RELEASE_POLICY && j.specYaml.includes(releaseJobWindowSpec(input.windowId)));
  if (existing) return { jobId: existing.jobId };
  const job = input.jobsRepo.register({
    policy: QUIET_RELEASE_POLICY,
    specYaml: ["context:", `  windowId: "${input.windowId}"`, `  entityId: "${input.entityId}"`].join("\n"),
    targetSession: `${input.entityId}@external`,
    intervalSeconds: 60,
    registeredBySession: "daemon@kernel",
  });
  return { jobId: job.jobId };
}

export type ReleaseDisposition = "row-not-active" | "superseded" | "recipient-changed" | "below-posting-threshold";
export type ReleaseVerdict =
  | { kind: "post"; alert: QueueItem }
  | { kind: "quiet"; windowId: string }
  | { kind: "disposition"; reason: ReleaseDisposition }
  /** Something the verdict depends on couldn't be read (the registry, the alert list, the quiet state): decide nothing,
   *  write nothing, and try again later. Never a disposition: a transient failure must not lose a live ask. */
  | { kind: "unavailable"; detail: string };

/** Whether a held ask should post now, decided from the current state: its recipient's quiet, the row, and the posting
 *  threshold. The release job asks before dispatching, and the gateway asks again at post time, so a release that was
 *  dispatched but not yet posted (buffered, then replayed after a restart) never posts into changed circumstances. */
export async function releaseVerdict(input: {
  queueRepo: QueueRepository;
  home: string;
  registry: RunQuietReleaseInput["registry"];
  entityId: string;
  qitemId: string;
  notificationKey: string;
  now: Date;
  alerts?: QueueItem[];
}): Promise<ReleaseVerdict> {
  let quiet: ReturnType<typeof quietHoldFor>;
  let alerts: QueueItem[] | null;
  try {
    quiet = quietHoldFor(input.queueRepo.db, input.entityId, input.now);
    alerts = quiet ? [] : input.alerts ?? await currentAlerts(input.queueRepo, input.home, input.registry);
  } catch (error) {
    return { kind: "unavailable", detail: (error as Error).message };
  }
  if (quiet) return { kind: "quiet", windowId: quiet.windowId };
  if (!alerts) return { kind: "unavailable", detail: "the human registry couldn't be loaded" };
  const alert = alerts.find((a) => (a.notificationKey ?? a.qitemId) === input.notificationKey);
  if (alert && (alert.destinationSession ?? "").split("@")[0] === input.entityId) return { kind: "post", alert };
  // Not a current alert for this person any more: say why, from the row as it is now.
  const row = input.queueRepo.getById(input.qitemId);
  const latest = row ? input.queueRepo.transitionLog.latestOwnerNotificationForQitem(input.qitemId) : null;
  const reason: ReleaseDisposition = !row || !isBlockerLive(row.state) ? "row-not-active"
    : latest && `${input.qitemId}:${latest.transitionId}` !== input.notificationKey ? "superseded"
      : alert ? "recipient-changed"
        : "below-posting-threshold";
  return { kind: "disposition", reason };
}

/** The current human alerts, or null when the registry can't be loaded: "unknown", never "none". */
async function currentAlerts(queueRepo: QueueRepository, home: string, registry: RunQuietReleaseInput["registry"]): Promise<QueueItem[] | null> {
  const reg = registry.loadHumanRegistry(home);
  if (!reg.ok) return null;
  return makeQueuePorts(queueRepo, { loadHumanRegistry: () => reg } as never).listHumanAlerts({ minimumLevel: loadConfig(home).minimumLevelThatPosts });
}

/** The gateway's half: re-check a release at post time. `post`: post it. `declined`: not posted, and the row says why.
 *  `retry`: it couldn't be checked; nothing is written, and the window's release job (still active, since this ask has
 *  neither a receipt nor a disposition) dispatches it again at its next evaluation. */
export async function confirmReleaseAtPost(input: {
  queueRepo: QueueRepository;
  jobsRepo: WatchdogJobsRepository;
  home: string;
  registry: RunQuietReleaseInput["registry"];
  entityId: string;
  qitemId: string;
  notificationKey: string;
  now?: Date;
}): Promise<"post" | "declined" | "retry"> {
  const verdict = await releaseVerdict({ ...input, now: input.now ?? new Date() });
  if (verdict.kind === "post") return "post";
  if (verdict.kind === "unavailable") return "retry";
  const key = input.notificationKey;
  if (verdict.kind === "quiet") {
    // Quiet came back on before this release posted: it stays held, and its window's job releases it next time.
    noteWithReleaseJob(input.queueRepo, input.jobsRepo, verdict.windowId, input.entityId, input.qitemId,
      () => `${RETURNED_PREFIX} window=${verdict.windowId} notification_key=${key} reason=quiet-on`);
    return "declined";
  }
  const notes = input.queueRepo.listTransitions(input.qitemId).map((t) => t.transitionNote ?? "");
  if (!notes.some((n) => hasToken(n, DISPOSITION_PREFIX, key))) {
    const windowId = notes.map(parseQuietHoldNote).find((h) => h?.notificationKey === key)?.windowId ?? "unknown";
    input.queueRepo.update({ qitemId: input.qitemId, actorSession: "daemon@kernel",
      transitionNote: `${DISPOSITION_PREFIX} window=${windowId} notification_key=${key} reason=${verdict.reason}` });
  }
  return "declined";
}

export interface RunQuietReleaseInput {
  queueRepo: QueueRepository;
  jobsRepo: WatchdogJobsRepository;
  home: string;
  registry: { loadHumanRegistry: (home: string) => { ok: boolean; entities?: Array<{ entityId: string }> } };
  dispatch: (op: string, entityBindingRef: string, payload: unknown, opts?: { decisionId?: string }) => { ok: boolean; error?: string };
  jobId: string;
  now?: Date;
}

/** One evaluation of a window's release job. `quiet`: nothing done. `pending`: posts dispatched, receipts awaited.
 *  `released`: every held ask has its receipt or a disposition, and the job is retired. */
export async function runQuietRelease(input: RunQuietReleaseInput): Promise<{ state: "quiet" | "pending" | "released"; released: number; dispositions: number }> {
  const job = input.jobsRepo.getById(input.jobId);
  const grab = (k: string) => job?.specYaml.match(new RegExp(`${k}:\\s*"([^"\\n]+)"`))?.[1];
  const windowId = grab("windowId");
  const entityId = grab("entityId");
  if (!job || job.state !== "active" || !windowId || !entityId) return { state: "released", released: 0, dispositions: 0 };
  const now = input.now ?? new Date();
  try {
    if (new HumanQuietStore(input.queueRepo.db).quietStateFor(entityId, now).active) return { state: "quiet", released: 0, dispositions: 0 };
  } catch {
    return { state: "pending", released: 0, dispositions: 0 }; // can't tell whether quiet is on: release nothing, try again
  }

  // Every ask held under this window, whichever occurrence or revision held it.
  const held = new Map<string, string>(heldKeys(input.queueRepo, windowId)); // notification key → qitem id

  // Unknown (null) when the registry can't be loaded: every held ask then reads as unavailable and stays open.
  const alerts = await currentAlerts(input.queueRepo, input.home, input.registry);
  let released = 0;
  let dispositions = 0;
  let open = 0;
  for (const [key, qitemId] of held) {
    const notes = input.queueRepo.listTransitions(qitemId).map((t) => t.transitionNote ?? "");
    if (resolved(input.queueRepo, qitemId, key, notes)) continue;
    const verdict = alerts === null
      ? { kind: "unavailable" as const, detail: "the human registry couldn't be loaded" }
      : await releaseVerdict({ queueRepo: input.queueRepo, home: input.home, registry: input.registry, entityId, qitemId,
        notificationKey: key, now, alerts });
    if (verdict.kind === "quiet" || verdict.kind === "unavailable") { open++; continue; }
    if (verdict.kind === "post") {
      open++;
      const res = input.dispatch(OUTBOUND_OP, verdict.alert.destinationSession!, { ...toPayload(verdict.alert), quietRelease: true }, { decisionId: `quiet-release:${key}` });
      // One dispatched note per release: a release turned back by quiet and dispatched again records it again, so the
      // row shows transport owning the wait; repeat passes over the same release write nothing.
      const lastStep = [...notes].reverse().find((n) => hasToken(n, DISPATCHED_PREFIX, key) || hasToken(n, RETURNED_PREFIX, key));
      if (res.ok && !lastStep?.startsWith(`${DISPATCHED_PREFIX} `)) {
        released++;
        input.queueRepo.update({ qitemId, actorSession: "daemon@kernel", transitionNote: `${DISPATCHED_PREFIX} window=${windowId} notification_key=${key}` });
      }
      continue;
    }
    input.queueRepo.update({ qitemId, actorSession: "daemon@kernel",
      transitionNote: `${DISPOSITION_PREFIX} window=${windowId} notification_key=${key} reason=${verdict.reason}` });
    dispositions++;
  }
  // Before retiring, read the held set again with no await in between: an ask held while this pass was awaiting the
  // alert list belongs to this window's job, which must not retire under it.
  if (open === 0 && heldKeys(input.queueRepo, windowId).some(([key, qitemId]) => !resolved(input.queueRepo, qitemId, key))) {
    return { state: "pending", released, dispositions };
  }
  if (open === 0) {
    input.jobsRepo.markTerminal(input.jobId, "quiet release complete: every held ask posted or given a disposition");
    return { state: "released", released, dispositions };
  }
  return { state: "pending", released, dispositions };
}

function heldKeys(queueRepo: QueueRepository, windowId: string): Array<[string, string]> {
  const rows = queueRepo.db.prepare(
    "SELECT qitem_id AS qitemId, transition_note AS note FROM queue_transitions WHERE transition_note LIKE ? ORDER BY transition_id",
  ).all(`${HOLD_PREFIX} window=${windowId} %`) as Array<{ qitemId: string; note: string }>;
  const out: Array<[string, string]> = [];
  for (const r of rows) {
    const hold = parseQuietHoldNote(r.note);
    if (hold && hold.windowId === windowId) out.push([hold.notificationKey, r.qitemId]);
  }
  return out;
}

/** Posted, or given a disposition: nothing more to release for this key. */
function resolved(queueRepo: QueueRepository, qitemId: string, key: string, notes?: string[]): boolean {
  const all = notes ?? queueRepo.listTransitions(qitemId).map((t) => t.transitionNote ?? "");
  return all.some((n) => hasToken(n, "slack-owner-notification-posted", key) || hasToken(n, DISPOSITION_PREFIX, key));
}

/** Watchdog-engine policy wrapper: the scheduler's cadence drives evaluation; the current quiet state owns the timing. */
export function makeQuietReleasePolicy(deps: Omit<RunQuietReleaseInput, "jobId" | "now">): Policy {
  return {
    name: QUIET_RELEASE_POLICY,
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const r = await runQuietRelease({ ...deps, jobId: job.jobId });
      if (r.state === "released") return { action: "terminal", reason: "quiet release complete" };
      return { action: "skip", reason: r.state === "quiet" ? "quiet_hours_still_on" : `released ${r.released}; awaiting receipts` };
    },
  } as Policy;
}
