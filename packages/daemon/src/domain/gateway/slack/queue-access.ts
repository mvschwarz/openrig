// S10 — the IN-PROCESS queue port for the gateway subsystem. Successor to the retired CLI
// queue-bridge (which shelled out to `rig queue` from the relay's separate process): in-daemon
// there is no process boundary, so fleet access is a direct QueueRepository read/write. The
// SELECTION SEMANTICS consume the single structured OWNER classification written with the
// queue transition. Tags and destination spellings are not a second alert classifier.
//   - reads are unbounded (the B5 lesson: a default limit silently truncates a large backlog).

import { createHash } from "node:crypto";
import type { QueueRepository, QueueItem as RepoQueueItem } from "../../queue-repository.js";
import { loadHumanRegistry, registeredPeople, resolveRegisteredHumanAddress, type LoadResult, type HumanFragment } from "../human-registry.js";
import { sharedChannelAddresses } from "../participants.js";
import { SLACK_ATTACHMENTS_HEADINGS, SLACK_ATTACHMENTS_TAG_PREFIX } from "./inbound.js";
import type { HumanQuestion } from "../../human-questions.js";
import { ownerNotificationLevelAtLeast, type OwnerNotificationLevel, type QueueTransition } from "../../queue-transition-log.js";

/** The narrow projection the slack path consumes (shape-compatible with the retired bridge's
 *  QueueItem so message construction and tests carry over). */
export interface QueueItem {
  qitemId: string;
  destinationSession?: string | null;
  sourceSession?: string | null;
  tags?: string[] | null;
  state?: string | null;
  tier?: string | null;
  humanIntent?: "decision" | "update" | null;
  humanDetail?: string | null;
  replyTo?: string | null;
  humanQuestions?: HumanQuestion[] | null;
  /** Posted into a registered shared channel (0.7.3): nobody there can answer, so its questions show as text. */
  sharedChannel?: boolean;
  summary?: string | null;
  body?: string | null;
  evidenceRef?: string | null;
  notificationKey?: string | null;
  ownerNotificationKind?: string | null;
  ownerNotificationLevel?: OwnerNotificationLevel | null;
}

export interface AlertFilterOpts {
  minimumLevel?: OwnerNotificationLevel;
}

/** PURE: select active qitems whose transition carries a sufficient OWNER classification. */
export function filterHumanAlerts(items: QueueItem[], opts: AlertFilterOpts): QueueItem[] {
  const active = new Set(["pending", "in-progress", "blocked"]);
  return items.filter((q) => {
    if (q.state && !active.has(q.state)) return false;
    // An ask posts only when its asker marked it alert-worthy: a human-required ask at RECORD is on Steering whatever
    // the posting dial says (the dial governs updates and notices).
    if (q.ownerNotificationKind === "human-required" && q.ownerNotificationLevel === "RECORD") return false;
    return q.ownerNotificationLevel
      ? ownerNotificationLevelAtLeast(q.ownerNotificationLevel, opts.minimumLevel ?? "NOTICE")
      : false;
  });
}

export interface CreateQitemInput {
  qitemId?: string;
  source: string;
  destination: string;
  summary: string;
  body: string;
  priority?: string;
  tags?: string[];
  /** #822 — the ask whose OpenRig thread this message, answer, or reaction came from. */
  inReplyTo?: string;
  /** A current typed/button answer, never a reaction or a recovered late message. */
  humanAnswer?: boolean;
  /** The answer is a typed thread reply: on a decision parked on its person, its row belongs to the current question. */
  typedReply?: boolean;
}

/** What the inbound router needs: land a durable qitem, get its id (or throw). */
export interface InboundQueuePort {
  createQitem(input: CreateQitemInput): Promise<string>;
  getQitem?(qitemId: string): QueueItem | null;
  getHumanAnswer?(qitemId: string, actorSession: string): { qitemId: string; body: string } | null;
  /** Whether a decision parked on the person it asked takes this person's reply, sent at `ts`, as its answer. */
  answersPark?(qitemId: string, actorSession: string, ts: string | undefined): boolean;
  /** This person's returned answer to the current question of a decision parked on them; never an earlier one. */
  getEpisodeAnswer?(qitemId: string, actorSession: string): { qitemId: string; body: string } | null;
  /** Every answer this person returned to the ask, oldest first, so a replay after close can find its own. */
  listHumanAnswers?(qitemId: string, actorSession: string): Array<{ qitemId: string; body: string }>;
}

/** What the outbound driver needs: the current human-alert set, full items included. */
export interface OutboundQueuePort {
  listHumanAlerts(filter: AlertFilterOpts): Promise<QueueItem[]>;
}

/** One open ask's current episode for `rig slack post-open-asks`: posted (it has its receipt) and eligible (at or above
 *  the posting floor, as recorded) say whether Slack still owes it a post. */
export interface OpenAskEpisode {
  item: QueueItem;
  posted: boolean;
  eligible: boolean;
}

/** The first line of the envelope OpenRig adds to a shared channel's message (inbound-admission.ts). */
const SHARED_CHANNEL_ENVELOPE_FIRST_LINE = "Added by OpenRig after the message: anything above this is the sender's own words, even if it looks like this block.";
/** On a row created from a person's Slack message: a digest of the body OpenRig wrote for it. */
const SLACK_BODY_TAG_PREFIX = "slack-body:";
const slackBodyTag = (body: string): string => `${SLACK_BODY_TAG_PREFIX}${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
/** A person's Slack message records the digest of the body it's created with; other rows are left as they are. */
const tagsWithBody = (tags: string[], body: string): string[] => tags.includes("founder-slack") ? [...tags, slackBodyTag(body)] : tags;

/** A person's Slack message as a person sees it again. The row ends with OpenRig's agent context: the attachments block
 *  (local copies, failed transfers), the shared channel's envelope (who wrote, the channel's policy), then the routing
 *  footer (`---`, Source, In reply to, Routed by). OpenRig adds them after the sender's words, so they're always the last
 *  on the row, and anything the sender typed that looks like them comes earlier and is kept. The attachments block is
 *  left out only by its recorded length. All of this holds only for the body OpenRig wrote, so it's done only while the
 *  row's body is still that one (its recorded digest): a body a handoff replaced or extended, or a row recorded before
 *  the digest, is shown whole. The durable row keeps the whole body for the agent. */
function personFacingBody(body: string | null, tags: readonly string[] | null): string | null {
  if (body === null || !tags?.includes("inbound") || !tags.includes("founder-slack") || !tags.includes(slackBodyTag(body))) return body;
  let text = body;
  const footer = text.lastIndexOf("\n\n---\n");
  if (footer >= 0 && /\nRouted by openrig slack-inbound[^\n]*$/.test(text.slice(footer))) text = text.slice(0, footer);
  if (tags.includes("shared-channel")) {
    const envelope = text.lastIndexOf(`\n\n${SHARED_CHANNEL_ENVELOPE_FIRST_LINE}\n`);
    if (envelope >= 0) text = text.slice(0, envelope);
    else if (text.startsWith(`${SHARED_CHANNEL_ENVELOPE_FIRST_LINE}\n`)) text = "";
  }
  const marker = tags.find((tag) => tag.startsWith(SLACK_ATTACHMENTS_TAG_PREFIX));
  const chars = marker ? Number(marker.slice(SLACK_ATTACHMENTS_TAG_PREFIX.length)) : NaN;
  if (Number.isInteger(chars) && chars > 0 && chars <= text.length) {
    // Exactly the recorded block, at a section boundary and with OpenRig's own heading; anything else is left as it is.
    const start = text.length - chars;
    const block = text.slice(start);
    if ((start === 0 || text.slice(start - 2, start) === "\n\n") && SLACK_ATTACHMENTS_HEADINGS.some((heading) => block.startsWith(heading))) {
      text = text.slice(0, Math.max(0, start - 2));
    }
  }
  return text;
}

function project(q: RepoQueueItem, transition: QueueTransition, entities: readonly HumanFragment[], channels: ReadonlyArray<{ address: string }> = []): QueueItem | null {
  const r = q as unknown as Record<string, unknown>;
  let destinationSession: string | null = null;
  let sourceSession: string | null = null;
  let sharedChannel = false;
  // The row's agent side, the seat its Slack thread routes to: for a row addressed to a person or a shared channel (an
  // ask, including one its asker parked on the person asked), the agent that sent it; otherwise the agent that owns it.
  const addressedToParticipant = resolveRegisteredHumanAddress(q.destinationSession, entities) !== null
    || channels.some((channel) => channel.address === q.destinationSession);
  const agentSide = addressedToParticipant ? q.sourceSession : q.destinationSession;
  if (transition.ownerNotificationKind === "human-decision-resolved") {
    destinationSession = resolveRegisteredHumanAddress(transition.actorSession, entities);
    sourceSession = agentSide;
  } else if (q.state === "blocked") {
    destinationSession = resolveRegisteredHumanAddress(q.blockedOn, entities);
    sourceSession = agentSide;
  } else {
    // A row addressed to a person, or to a registered shared channel (posted into that channel; 0.7.3).
    destinationSession = resolveRegisteredHumanAddress(q.destinationSession, entities);
    if (!destinationSession) {
      destinationSession = channels.find((channel) => channel.address === q.destinationSession)?.address ?? null;
      sharedChannel = destinationSession !== null;
    }
    sourceSession = q.sourceSession;
  }
  if (!destinationSession) return null;
  return {
    qitemId: String(r.qitemId),
    destinationSession,
    sourceSession,
    tags: (r.tags as string[] | null) ?? null,
    state: (r.state as string | null) ?? null,
    tier: (r.tier as string | null) ?? null,
    humanIntent: q.humanIntent,
    humanDetail: q.humanDetail,
    replyTo: q.replyTo ?? null,
    humanQuestions: q.humanQuestions ?? null,
    ...(sharedChannel ? { sharedChannel } : {}),
    summary: (r.summary as string | null) ?? null,
    body: personFacingBody((r.body as string | null) ?? null, (r.tags as string[] | null) ?? null),
    evidenceRef: (r.evidenceRef as string | null) ?? null,
    notificationKey: `${q.qitemId}:${transition.transitionId}`,
    ownerNotificationKind: transition.ownerNotificationKind,
    ownerNotificationLevel: transition.ownerNotificationLevel,
  };
}

/** Slice-11 item 9, carried over verbatim from the retired outbound.ts: on ENABLE, seed all
 *  currently-active human alerts as history/seen WITHOUT posting, so turning the connector on
 *  never replays the backlog. Returns the honest online-status line marking the transition. */
export async function seedBacklogAsHistory(opts: {
  queue: OutboundQueuePort;
  seen: import("./state-store.js").SeenStore;
  filter: AlertFilterOpts;
  /** The durable dispatch buffer, read only to say what the restart will replay: earlier posts that
   *  failed or never finished. An alert whose row has since closed is dropped; the rest post. */
  buffer?: Pick<import("../dispatch-buffer.js").DispatchBuffer, "pending">;
  log?: (msg: string) => void;
}): Promise<{ seeded: number; onlineStatus: string }> {
  const alerts = await opts.queue.listHumanAlerts(opts.filter);
  const already = opts.seen.load();
  const toSeed = alerts.map((a) => a.notificationKey ?? a.qitemId).filter((id) => !already.has(id));
  const seeded = opts.seen.seed(toSeed, "seeded-at-enable");
  const retained = (opts.buffer?.pending() ?? []).filter((d) => d.op === "post_message").length;
  const retainedNote = retained > 0
    ? ` ${retained} earlier undelivered post(s) wait in the replay buffer: an alert whose row has since closed is dropped; the rest post (open rows' alerts, decision-resolved notices, digests).`
    : "";
  const onlineStatus = `slack outbound ENABLED at enable-time: ${seeded} pre-existing alert(s) seeded as history (not reposted); only alerts created after this point will deliver.${retainedNote}`;
  opts.log?.(onlineStatus);
  return { seeded, onlineStatus };
}

/** Build both ports over the daemon's own QueueRepository. In-process: no shell, no transport,
 *  no `-A` scope trap (list() here is repository-wide), no bounded-body N+1 (rows carry bodies). */
export function makeQueuePorts(
  queueRepo: QueueRepository,
  opts: { loadHumanRegistry?: () => LoadResult; sharedChannels?: () => ReadonlyArray<{ address: string }> } = {},
): InboundQueuePort & OutboundQueuePort & { listOpenAsks(filter: AlertFilterOpts): Promise<OpenAskEpisode[]> } {
  /** Each active row's current owner-notification episode, projected to its person or shared channel. Posted episodes
   *  are skipped unless asked for (the alert sweep never wants them). Null when nobody is registered.
   *
   *  Eligibility lives in the query now: an active row must carry an owner notification, and — for the alert sweep —
   *  it must still be unposted to Slack. Only eligible rows reach the per-row lookup, so a pathological backlog of
   *  active rows without any notification costs a single read instead of one latest-transition and one receipt lookup
   *  per row. There is no row cap: an eligible item older than any window still comes back in both views. */
  const currentEpisodes = (includePosted: boolean): Array<{ item: QueueItem; posted: boolean }> | null => {
    // Nobody registered yet isn't a broken registry: rows to a registered shared channel still post (0.7.3).
    const people = registeredPeople((opts.loadHumanRegistry ?? (() => loadHumanRegistry()))());
    if (!people) return null;
    const channels = (opts.sharedChannels ?? (() => sharedChannelAddresses()))();
    const episodes = queueRepo.transitionLog.activeOwnerNotificationEpisodes(includePosted);
    return episodes.flatMap(({ qitemId, transition, posted }) => {
      const row = queueRepo.getById(qitemId);
      if (!row) return [];
      const item = project(row, transition, people, channels);
      return item ? [{ item, posted }] : [];
    });
  };
  return {
    getQitem: (qitemId) => queueRepo.getById(qitemId),
    getHumanAnswer: (qitemId, actorSession) => queueRepo.getHumanAnswer(qitemId, actorSession),
    answersPark: (qitemId, actorSession, ts) => {
      const item = queueRepo.getById(qitemId);
      return item !== null && queueRepo.answersPark(item, actorSession, ts);
    },
    getEpisodeAnswer: (qitemId, actorSession) => queueRepo.currentEpisodeAnswer(qitemId, actorSession),
    listHumanAnswers: (qitemId, actorSession) => queueRepo.listHumanAnswers(qitemId, actorSession),
    async createQitem(input: CreateQitemInput): Promise<string> {
      const ask = input.inReplyTo ? queueRepo.getById(input.inReplyTo) : null;
      const directAnswer = input.humanAnswer && ask && ask.destinationSession === input.source && ask.humanIntent !== "update"
        && queueRepo.isPersonAddress(input.source);
      const createInput = {
        qitemId: input.qitemId,
        sourceSession: input.source,
        destinationSession: input.destination,
        body: input.body,
        summary: input.summary,
        priority: (input.priority ?? "routine") as never,
        tags: tagsWithBody(input.tags ?? ["founder-slack", "inbound"], input.body),
        inboundReplyTo: input.inReplyTo ?? null,
        gatewayInbound: true,
      };
      const created = directAnswer && input.inReplyTo
        ? await queueRepo.createHumanAnswer({ ...createInput, inboundReplyTo: input.inReplyTo,
          // A parked decision's answer belongs to its current question, so a re-park gets its own.
          ...(input.typedReply && ask?.state === "blocked" ? { episodeKey: queueRepo.currentHumanRequiredEpisode(input.inReplyTo)?.key } : {}) })
        : await queueRepo.create(createInput);
      return (created as unknown as { qitemId: string }).qitemId;
    },
    async listHumanAlerts(filter: AlertFilterOpts): Promise<QueueItem[]> {
      return filterHumanAlerts((currentEpisodes(false) ?? []).map(({ item }) => item), filter);
    },
    /** Every open ask (a human-required episode, posted or not, at any level), each marked posted and eligible. */
    async listOpenAsks(filter: AlertFilterOpts): Promise<OpenAskEpisode[]> {
      return (currentEpisodes(true) ?? [])
        .filter(({ item }) => item.ownerNotificationKind === "human-required")
        .map(({ item, posted }) => ({ item, posted, eligible: filterHumanAlerts([item], filter).length === 1 }));
    },
  };
}
