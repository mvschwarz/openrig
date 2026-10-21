// The facts for a person's "back" account: what one ended mode application did, made only from the records. The operator
// composes the words from these; nothing here is remembered, inferred or written. Read-only throughout: classifying a
// held ask uses slice 08's release verdict, which reads and never releases, posts or marks.
import { HumanModeService, type ModeApplication, type ModeEffect } from "./human-operating-modes.js";
import { isBlockerLive, type QueueRepository } from "../queue-repository.js";
import { parseSessionName } from "../session-name.js";
import { DISPOSITION_PREFIX, hasToken, parseQuietHoldNote, releaseVerdict, type RunQuietReleaseInput } from "../policies/quiet-release.js";

const POSTED_RECEIPT = "slack-owner-notification-posted";

export interface WaitingAsk {
  qitemId: string;
  summary: string | null;
  state: string;
  /** valid: still for them. held: quiet hours are still on (it posts when they end). stale: slice 08's release reason.
   *  unclassified: what it depends on couldn't be read, so it's not called valid or stale. */
  standing: "valid" | "held" | "stale" | "unclassified";
  reason: string | null;
}

export interface ModeAccount {
  mode: { applicationId: string; modeName: string; settings: ModeApplication["settings"]; startedAt: string; startedBy: string;
    scheduledEnd: string | null; endedAt: string; endedBy: string | null; endReason: string };
  effects: ModeEffect[];
  unresolved: ReturnType<HumanModeService["unresolved"]>;
  now: { applicationId: string; modeName: string } | null;
  decisions: Array<{ qitemId: string; summary: string | null; askedBy: string; decision: unknown }>;
  waiting: WaitingAsk[];
  /** What the account can't say, because no record supports it: said plainly rather than made up. */
  notTracked: string[];
}

export const NOT_TRACKED = [
  "work done while the mode was on: no record ties work to a person",
  "work that stalled or failed while the mode was on: no record ties it to a person (the mode's own failed or pending effects are listed)",
];

export type AccountResult = { status: "ok"; account: ModeAccount } | { status: "not-found" } | { status: "still-on"; application: ModeApplication };

export async function modeAccount(input: {
  modes: HumanModeService;
  queueRepo: QueueRepository;
  home: string;
  registry: RunQuietReleaseInput["registry"];
  entityId: string;
  applicationId: string;
  now: Date;
}): Promise<AccountResult> {
  const app = input.modes.get(input.applicationId);
  if (!app || app.entityId !== input.entityId) return { status: "not-found" };
  if (!app.endedAt) return { status: "still-on", application: app };
  const current = input.modes.current(input.entityId);
  return { status: "ok", account: {
    mode: { applicationId: app.applicationId, modeName: app.modeName, settings: app.settings, startedAt: app.startedAt, startedBy: app.startedBy,
      scheduledEnd: app.scheduledEnd, endedAt: app.endedAt, endedBy: app.endedBy, endReason: app.endReason! },
    effects: app.effects,
    unresolved: input.modes.unresolved(input.entityId),
    now: current ? { applicationId: current.applicationId, modeName: current.modeName } : null,
    decisions: input.queueRepo.delegatedDecisionsFor(app.applicationId)
      .map((item) => ({ qitemId: item.qitemId, summary: item.summary ?? null, askedBy: item.sourceSession, decision: item.delegatedDecision })),
    waiting: await waitingFor(input, app),
    notTracked: NOT_TRACKED,
  } };
}

/** Asks to the person still open now, plus asks held for their quiet hours while the mode was on that slice 08's release
 *  set aside as stale. A held ask is classified as the release classifies it; an ask that was never held is still for them. */
async function waitingFor(input: Parameters<typeof modeAccount>[0], app: ModeApplication): Promise<WaitingAsk[]> {
  const db = input.queueRepo.db;
  // The person's own address, or the `<entityId>@host` custody label a row can be blocked on: a seat that happens to share
  // their name isn't them.
  const mine = (session: string | null | undefined) => {
    const parsed = session ? parseSessionName(session) : null;
    return (parsed?.kind === "external" && parsed.local === input.entityId)
      || (parsed?.kind === "canonical" && parsed.member === input.entityId && parsed.rig === "host");
  };
  const open = (db.prepare("SELECT qitem_id, destination_session, blocked_on FROM queue_items WHERE state IN ('pending', 'in-progress', 'blocked')")
    .all() as Array<{ qitem_id: string; destination_session: string; blocked_on: string | null }>)
    .filter((r) => mine(r.destination_session) || mine(r.blocked_on)).map((r) => r.qitem_id);
  const heldDuring = (db.prepare("SELECT DISTINCT qitem_id FROM queue_transitions WHERE transition_note LIKE 'delivery-decision: quiet-hold %' AND ts >= ? AND ts <= ?")
    .all(app.startedAt, app.endedAt) as Array<{ qitem_id: string }>).map((r) => r.qitem_id);
  const out: WaitingAsk[] = [];
  for (const qitemId of [...new Set([...open, ...heldDuring])]) {
    const item = input.queueRepo.getById(qitemId);
    if (!item) continue;
    const ask = { qitemId, summary: item.summary ?? null, state: item.state };
    const notes = input.queueRepo.listTransitions(qitemId).map((t) => t.transitionNote ?? "");
    const hold = [...notes].reverse().map(parseQuietHoldNote).find((h) => h !== null);
    if (!hold) {
      // Never held: an open ask to them is still theirs; a closed one isn't waiting.
      if (isBlockerLive(item.state) && (mine(item.destinationSession) || mine(item.blockedOn))) out.push({ ...ask, standing: "valid", reason: null });
      continue;
    }
    const disposed = notes.find((n) => hasToken(n, DISPOSITION_PREFIX, hold.notificationKey));
    if (disposed) { out.push({ ...ask, standing: "stale", reason: /reason=(\S+)/.exec(disposed)?.[1] ?? null }); continue; }
    if (notes.some((n) => hasToken(n, POSTED_RECEIPT, hold.notificationKey))) {
      // Released and posted: still theirs while it's open; closed since, it isn't waiting.
      if (isBlockerLive(item.state)) out.push({ ...ask, standing: "valid", reason: null });
      continue;
    }
    if (!isBlockerLive(item.state)) { out.push({ ...ask, standing: "stale", reason: "row-not-active" }); continue; }
    const verdict = await releaseVerdict({ queueRepo: input.queueRepo, home: input.home, registry: input.registry, entityId: input.entityId,
      qitemId, notificationKey: hold.notificationKey, now: input.now });
    if (verdict.kind === "post") out.push({ ...ask, standing: "valid", reason: null });
    else if (verdict.kind === "quiet") out.push({ ...ask, standing: "held", reason: "quiet hours are still on" });
    else if (verdict.kind === "disposition") out.push({ ...ask, standing: "stale", reason: verdict.reason });
    else out.push({ ...ask, standing: "unclassified", reason: verdict.detail });
  }
  return out;
}
