import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";

import type { QueueItemDetail } from "../../hooks/useSlices.js";
import {
  MAX_RETAINED_ATTENTION_ITEMS,
  onRetainedAttentionEvict,
  retainAttentionItemInSession,
  type AttentionData,
  type AttentionQueueItem,
} from "../../hooks/useAttentionItems.js";
import {
  useMissionControlAction,
  type MissionControlActionInput,
  type MissionControlActionResult,
} from "../mission-control/hooks/useMissionControlAction.js";
import { isHumanSeatSessionRef } from "../../lib/session-name.js";
import { cn } from "../../lib/utils.js";

export interface HumanQuestionOptionItem {
  id: string;
  label: string;
  recommended?: boolean;
}
export interface HumanQuestionItem {
  id: string;
  question: string;
  options: HumanQuestionOptionItem[];
}
export interface TypedHumanReplyItem {
  kind: "typed-reply";
  text: string;
}
export type HumanAnswerValue = string | TypedHumanReplyItem;
export type HumanAnswersRecord = Record<string, HumanAnswerValue>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const ownAnswer = (answers: HumanAnswersRecord | null | undefined, id: string) =>
  answers && Object.prototype.hasOwnProperty.call(answers, id) ? answers[id] : undefined;

function generateOperationId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function normalizeHumanQuestions(raw: unknown): HumanQuestionItem[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: HumanQuestionItem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.question !== "string" || !Array.isArray(entry.options) || entry.options.length === 0) {
      return [];
    }
    const options: HumanQuestionOptionItem[] = [];
    for (const opt of entry.options) {
      if (!isRecord(opt) || typeof opt.id !== "string" || typeof opt.label !== "string") return [];
      options.push({ id: opt.id, label: opt.label, ...(opt.recommended === true ? { recommended: true } : {}) });
    }
    out.push({ id: entry.id, question: entry.question, options });
  }
  return out;
}

export function normalizeHumanAnswers(raw: unknown): HumanAnswersRecord {
  if (!isRecord(raw)) return {};
  const out: HumanAnswersRecord = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === "string") out[key] = val;
    else if (isRecord(val) && val.kind === "typed-reply" && typeof val.text === "string") {
      out[key] = { kind: "typed-reply", text: val.text };
    }
  }
  return out;
}

export function formatRecordedAnswers(
  questions: readonly HumanQuestionItem[],
  answers: HumanAnswersRecord,
): Array<{ questionId: string; question: string; answerText: string }> {
  return questions.flatMap((q) => {
    const val = ownAnswer(answers, q.id);
    if (val === undefined) return [];
    const answerText = typeof val === "string" ? (q.options.find((o) => o.id === val)?.label ?? val) : val.text;
    return [{ questionId: q.id, question: q.question, answerText }];
  });
}

const normToken = (s?: string | null) =>
  (s ?? "").toLowerCase().replace("cancelled", "canceled").replace("handed_off", "handed-off");
const TERMINAL_STATES = new Set(["done", "closed", "completed", "canceled", "denied", "expired", "handed-off", "routed"]);
const STATE_LABELS: Record<string, string> = {
  denied: "denied",
  canceled: "dropped",
  "handed-off-to": "handed off",
  "handed-off": "handed off",
  routed: "routed",
  expired: "expired",
};

const BTN_BASE_CLASS =
  "min-h-[44px] px-3 py-2 border font-mono text-[10px] uppercase tracking-wider break-words whitespace-normal disabled:opacity-50";
const ACTION_BTN_CLASS =
  "w-full min-[360px]:w-auto min-h-[44px] px-3 py-1 font-mono text-[10px] uppercase disabled:opacity-50";

interface SavedOutcome {
  outcome: "recorded" | "answered";
  unanswered: string[];
  message?: string;
  notClosed?: boolean;
  code?: string;
}

interface ActionErrorSummary {
  code?: string;
  message: string;
  source: "option" | "words" | "resend";
  unknown?: boolean;
}

interface SessionAskSnapshot {
  answers: HumanAnswersRecord;
  revision?: string;
  queueItemRevisionAtSave?: string | null;
  lastOutcome?: SavedOutcome | null;
  settled?: {
    refreshedItem: QueueItemDetail | null;
    fallbackState?: string | null;
    error?: ActionErrorSummary | null;
  } | null;
}

const sessionAskSnapshots = new Map<string, SessionAskSnapshot>();
onRetainedAttentionEvict((evictedId) => {
  if (evictedId === undefined) sessionAskSnapshots.clear();
  else sessionAskSnapshots.delete(evictedId);
});
export function clearQuestionAskSessionSnapshots(): void {
  sessionAskSnapshots.clear();
}
export function hasQuestionAskSessionSnapshot(qitemId: string): boolean {
  return sessionAskSnapshots.has(qitemId);
}

function settledElsewhereHeadline(
  item: QueueItemDetail | null | undefined,
  questions: readonly HumanQuestionItem[],
  fallbackState?: string | null,
): string {
  const pairs = formatRecordedAnswers(questions, normalizeHumanAnswers(item?.humanAnswers));
  const state = normToken(item?.state ?? item?.closingTransition?.state ?? item?.closingTransition?.toState ?? fallbackState ?? "closed");
  const rawReason = item?.closureReason ?? item?.closingTransition?.closureReason ?? item?.closingTransition?.reason ?? null;
  const reason = rawReason ? normToken(rawReason).replace("_", "-") : null;
  const label = (reason && STATE_LABELS[reason]) ?? STATE_LABELS[state] ?? state;
  const actor = item?.closingTransition?.actorSession;
  const target = item?.handedOffTo ?? item?.closureTarget ?? item?.closingTransition?.closureTarget;
  const parts = [
    actor ? `by ${actor}` : null,
    target && target !== "no-follow-on" ? (label === "handed off" || label === "routed" ? `to ${target}` : `(${target})`) : null,
  ].filter(Boolean);
  const joined = pairs.map((p) => `${p.question}: ${p.answerText}`).join("; ");
  const recorded = pairs.length > 0 ? ` Recorded: ${joined}${/[.!?]$/.test(joined) ? "" : "."}` : "";
  return `This request is ${label} now${parts.length ? ` ${parts.join(" ")}` : ""}.${recorded}`;
}

export interface FeedCardQuestionAskProps {
  cardId: string;
  qitemId: string;
  actorSession: string;
  recipientSession?: string;
  askerSession?: string;
  questions: HumanQuestionItem[];
  initialAnswers: HumanAnswersRecord;
  queueItem?: QueueItemDetail;
}

export function FeedCardQuestionAsk({
  cardId,
  qitemId,
  actorSession,
  recipientSession,
  askerSession,
  questions,
  initialAnswers,
  queueItem,
}: FeedCardQuestionAskProps) {
  const queryClient = useQueryClient();
  const mutation = useMissionControlAction();

  const propRev = queueItem?.decisionRevision ?? undefined;
  const propStateLower = normToken(queueItem?.state);
  const propIsTerminal = Boolean(propStateLower && TERMINAL_STATES.has(propStateLower));
  const rawCached = sessionAskSnapshots.get(qitemId);
  const cachedSettledTerminal = Boolean(
    rawCached?.settled?.refreshedItem?.state && TERMINAL_STATES.has(normToken(rawCached.settled.refreshedItem.state)),
  );
  const isCachedStale = Boolean(
    rawCached &&
      ((propRev && propRev !== rawCached.revision && propRev !== rawCached.queueItemRevisionAtSave) ||
        (rawCached.settled &&
          propStateLower &&
          !propIsTerminal &&
          (cachedSettledTerminal || !propRev || (propRev !== rawCached.revision && propRev !== rawCached.queueItemRevisionAtSave)))),
  );
  if (isCachedStale) sessionAskSnapshots.delete(qitemId);
  const cached = isCachedStale ? undefined : rawCached;

  const [localAnswers, setLocalAnswers] = useState<HumanAnswersRecord>(() => cached?.answers ?? {});
  const [localRevision, setLocalRevision] = useState<string | undefined>(() =>
    cached?.revision ? (propRev && propRev !== cached.queueItemRevisionAtSave ? propRev : cached.revision) : propRev,
  );
  const [ownWordsOpen, setOwnWordsOpen] = useState(false);
  const [ownWordsText, setOwnWordsText] = useState("");
  const [lastOutcome, setLastOutcome] = useState<SavedOutcome | null>(() => cached?.lastOutcome ?? null);
  const [actionError, setActionError] = useState<ActionErrorSummary | null>(() => cached?.settled?.error ?? null);
  const [revisionLoadFailed, setRevisionLoadFailed] = useState(false);
  const [settledState, setSettledState] = useState<{
    refreshing: boolean;
    refreshedItem: QueueItemDetail | null;
    fallbackState?: string | null;
  } | null>(() => (cached?.settled ? { refreshing: false, refreshedItem: cached.settled.refreshedItem, fallbackState: cached.settled.fallbackState } : null));

  const prevPropRevRef = useRef(propRev);
  const prevPropStateRef = useRef(propStateLower);
  useEffect(() => {
    if (propRev === prevPropRevRef.current && propStateLower === prevPropStateRef.current) return;
    const prevWasTerminal = Boolean(prevPropStateRef.current && TERMINAL_STATES.has(prevPropStateRef.current));
    prevPropRevRef.current = propRev;
    prevPropStateRef.current = propStateLower;

    const currentSnap = sessionAskSnapshots.get(qitemId);
    const matchesSaved = Boolean(
      currentSnap && propRev && (propRev === currentSnap.revision || propRev === currentSnap.queueItemRevisionAtSave),
    );
    const reopenedFromSettled = Boolean(
      (settledState || currentSnap?.settled) && propStateLower && !propIsTerminal && (prevWasTerminal || !matchesSaved),
    );

    if (reopenedFromSettled || (propRev && !matchesSaved && propRev !== localRevision)) {
      sessionAskSnapshots.delete(qitemId);
      setLocalRevision(propRev);
      setLocalAnswers({});
      setLastOutcome(null);
      setSettledState(null);
      setActionError(null);
    } else if (propRev && !localRevision) {
      setLocalRevision(propRev);
    }
  }, [propRev, propStateLower, propIsTerminal, qitemId, localRevision, settledState]);

  const saveSnapshot = (patch: Partial<SessionAskSnapshot>) => {
    const prev = sessionAskSnapshots.get(qitemId) ?? { answers: localAnswers, revision: localRevision };
    sessionAskSnapshots.delete(qitemId);
    if (sessionAskSnapshots.size >= MAX_RETAINED_ATTENTION_ITEMS) {
      const oldestKey = sessionAskSnapshots.keys().next().value;
      if (oldestKey !== undefined) sessionAskSnapshots.delete(oldestKey);
    }
    sessionAskSnapshots.set(qitemId, { ...prev, queueItemRevisionAtSave: queueItem?.decisionRevision ?? null, ...patch });
  };

  const findAttentionItemToRetain = (): AttentionQueueItem | null => {
    for (const [, data] of queryClient.getQueriesData<AttentionData>({ queryKey: ["attention-items"] })) {
      const found = data?.items?.find((i) => i.qitemId === qitemId && (!i.hostId || i.hostId === "local"));
      if (found) return found;
    }
    return queueItem
      ? ({ ...queueItem, blockedOn: queueItem.blockedOn ?? null, handedOffTo: queueItem.handedOffTo ?? null, handedOffFrom: queueItem.handedOffFrom ?? null } as AttentionQueueItem)
      : null;
  };

  const operationIdsRef = useRef<Map<string, string>>(new Map());
  const getOperationId = (sig: string) => {
    const existing = operationIdsRef.current.get(sig);
    if (existing) return existing;
    const next = generateOperationId();
    operationIdsRef.current.set(sig, next);
    return next;
  };

  const mergedAnswers: HumanAnswersRecord = { ...initialAnswers, ...normalizeHumanAnswers(queueItem?.humanAnswers), ...localAnswers };
  const effectiveRevision = localRevision ?? propRev;
  const hasRevision = typeof effectiveRevision === "string" && effectiveRevision.length > 0;
  const totalQuestions = questions.length;
  const answeredCount = questions.filter((q) => ownAnswer(mergedAnswers, q.id) !== undefined).length;
  const allAnswered = totalQuestions > 0 && answeredCount === totalQuestions;
  const askerLabel = askerSession ?? "the asker";
  const requestActorSession = recipientSession && isHumanSeatSessionRef(recipientSession) ? recipientSession : actorSession;
  const identityText = `Answering as human@host (unattributed)${recipientSession && recipientSession !== "human@host" ? ` on ${recipientSession}'s ask` : ""}`;

  async function refreshQueueRow(opts?: {
    code?: string;
    details?: Record<string, unknown>;
    errSummary?: ActionErrorSummary | null;
    fromUnknown?: boolean;
    fromLoadRetry?: boolean;
  }) {
    const fallbackState = typeof opts?.details?.state === "string" ? opts.details.state : null;
    const isTerminalOrigin = opts?.code === "qitem_already_terminal" || opts?.code === "decision_revision_changed";
    if (isTerminalOrigin || opts?.fromUnknown || opts?.fromLoadRetry) {
      setSettledState((prev) => ({ refreshing: true, refreshedItem: prev?.refreshedItem ?? queueItem ?? null, fallbackState }));
    }
    void queryClient.invalidateQueries({ queryKey: ["attention-items"] });
    void queryClient.invalidateQueries({ queryKey: ["mission-control", "audit"] });

    let refreshed: QueueItemDetail | null = null;
    try {
      refreshed = await queryClient.fetchQuery({
        queryKey: ["queue", "item", qitemId],
        queryFn: async () => {
          const res = await fetch(`/api/queue/${encodeURIComponent(qitemId)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as QueueItemDetail;
        },
        staleTime: 0,
      });
    } catch {
      refreshed = null;
    }

    if (opts?.fromLoadRetry) {
      setRevisionLoadFailed(!refreshed?.decisionRevision);
    }

    if (opts?.fromUnknown) {
      if (!refreshed) {
        setSettledState(null);
        setActionError((prev) =>
          prev ? { ...prev, message: "Could not refresh request state. Check connection and try again." } : prev,
        );
        return;
      }
      setActionError(null);
    }

    const nextRev = refreshed?.decisionRevision ?? (typeof opts?.details?.currentRevision === "string" ? opts.details.currentRevision : undefined);
    if (nextRev) {
      setRevisionLoadFailed(false);
      setLocalRevision(nextRev);
      saveSnapshot({ revision: nextRev });
    }
    const nextAnswers = refreshed?.humanAnswers ?? opts?.details?.humanAnswers;
    if (nextAnswers) {
      const normalized = normalizeHumanAnswers(nextAnswers);
      setLocalAnswers(normalized);
      saveSnapshot({ answers: normalized });
    }

    if (!isTerminalOrigin && !opts?.fromUnknown && !opts?.fromLoadRetry) return;
    const effectiveItem = refreshed ?? queueItem ?? null;
    const effectiveState = normToken(refreshed?.state ?? fallbackState ?? queueItem?.state ?? "pending");
    if (opts?.code !== "qitem_already_terminal" && !TERMINAL_STATES.has(effectiveState)) {
      setSettledState(null);
      saveSnapshot({ revision: nextRev ?? localRevision, settled: null });
      return;
    }
    setSettledState({ refreshing: false, refreshedItem: effectiveItem, fallbackState });
    saveSnapshot({ revision: nextRev ?? localRevision, settled: { refreshedItem: effectiveItem, fallbackState, error: opts?.errSummary ?? null } });
  }

  function submitAnswer(
    source: "option" | "words" | "resend",
    signature: string,
    fields: Partial<MissionControlActionInput>,
    optimisticUpdate?: (prev: HumanAnswersRecord) => HumanAnswersRecord,
    onDone?: () => void,
  ) {
    if (mutation.isPending || settledState || !hasRevision) return;
    let operationId: string;
    try {
      retainAttentionItemInSession(qitemId, findAttentionItemToRetain());
      operationId = getOperationId(signature);
    } catch (err) {
      setActionError({ message: err instanceof Error ? err.message : String(err), source, unknown: false });
      return;
    }
    setActionError(null);
    const applyOptimistic = () => {
      if (!optimisticUpdate) return mergedAnswers;
      const next = optimisticUpdate(localAnswers);
      setLocalAnswers(next);
      return next;
    };

    mutation.mutate(
      {
        verb: "answer",
        qitemId,
        actorSession: requestActorSession,
        ...fields,
        expectedRevision: effectiveRevision,
        authority: "primary-user",
        auditNotes: { operationId },
      },
      {
        onSuccess: (result: MissionControlActionResult) => {
          operationIdsRef.current.delete(signature);
          setActionError(null);
          const closed = isRecord(result.closedQitem) ? result.closedQitem : null;
          const closedStateRaw = typeof closed?.state === "string" ? closed.state : undefined;
          const closedState = closedStateRaw ? normToken(closedStateRaw) : undefined;
          const closedReason = typeof closed?.closureReason === "string" ? closed.closureReason : null;
          const closedTarget = typeof closed?.closureTarget === "string" ? closed.closureTarget : undefined;
          const nextRev =
            result.decisionRevision ??
            (typeof closed?.decisionRevision === "string" ? closed.decisionRevision : undefined) ??
            localRevision;
          if (nextRev) setLocalRevision(nextRev);
          if (queueItem || queryClient.getQueryData(["queue", "item", qitemId])) {
            queryClient.setQueryData<QueueItemDetail | null>(["queue", "item", qitemId], (old) =>
              old
                ? {
                    ...old,
                    ...(nextRev ? { decisionRevision: nextRev } : {}),
                    ...(closedStateRaw ? { state: closedStateRaw } : {}),
                    ...(closedReason !== null ? { closureReason: closedReason } : {}),
                    ...(closedTarget !== undefined ? { closureTarget: closedTarget } : {}),
                    ...(closed?.humanAnswers ? { humanAnswers: closed.humanAnswers as Record<string, unknown> } : {}),
                  }
                : old,
            );
          }
          let updatedAnswers = mergedAnswers;
          if (closed?.humanAnswers) {
            updatedAnswers = normalizeHumanAnswers(closed.humanAnswers);
            setLocalAnswers(updatedAnswers);
          } else {
            updatedAnswers = applyOptimistic();
          }
          if (result.answer?.outcome !== "answered" && closedState && TERMINAL_STATES.has(closedState)) {
            const closedDetail = closed as unknown as QueueItemDetail;
            setLastOutcome(null);
            setSettledState({ refreshing: false, refreshedItem: closedDetail, fallbackState: closedState });
            saveSnapshot({
              answers: updatedAnswers,
              revision: nextRev,
              lastOutcome: null,
              settled: { refreshedItem: closedDetail, fallbackState: closedState, error: null },
            });
            return;
          }
          const inferredOutcome: SavedOutcome =
            result.answer ?? {
              outcome: "recorded",
              unanswered: questions
                .filter((q) => ownAnswer({ ...mergedAnswers, ...updatedAnswers }, q.id) === undefined)
                .map((q) => q.question),
            };
          setLastOutcome(inferredOutcome);
          saveSnapshot({
            answers: updatedAnswers,
            revision: nextRev,
            lastOutcome: inferredOutcome,
          });
          onDone?.();
        },
        onError: (err: unknown) => {
          const typedErr = (err instanceof Error ? err : new Error(String(err))) as Error & {
            code?: string;
            status?: number;
            details?: unknown;
          };
          const details = isRecord(typedErr.details) ? typedErr.details : undefined;
          const code = typedErr.code;

          if (code === "answer_not_closed") {
            if (typeof details?.replyQitemId === "string") {
              const updatedAnswers = applyOptimistic();
              const returnedOutcome: SavedOutcome = { outcome: "answered", unanswered: [], message: typedErr.message, notClosed: true, code };
              setActionError(null);
              setLastOutcome(returnedOutcome);
              saveSnapshot({ answers: updatedAnswers, revision: localRevision, lastOutcome: returnedOutcome });
              onDone?.();
              void refreshQueueRow({ code, details });
              return;
            }
            if (source !== "words") {
              const updatedAnswers = applyOptimistic();
              const recordedOutcome: SavedOutcome = { outcome: "recorded", unanswered: [] };
              setLastOutcome(recordedOutcome);
              saveSnapshot({ answers: updatedAnswers, lastOutcome: recordedOutcome });
            }
          }

          const unknown = !code || (typeof typedErr.status === "number" && typedErr.status >= 500);
          const errSummary: ActionErrorSummary = { code, message: typedErr.message, source, unknown };
          setActionError(errSummary);
          if (code === "qitem_already_terminal" || code === "decision_revision_changed" || (code === "answer_not_closed" && source !== "words")) {
            void refreshQueueRow({ code, details, errSummary });
          }
        },
      },
    );
  }

  const identityHeader = (
    <div data-testid={`feed-card-answer-identity-${cardId}`} className="font-mono text-[10px] text-on-surface-variant break-words">
      {identityText}
    </div>
  );

  const renderErrorAlert = (leadIn?: string) =>
    actionError ? (
      <div
        data-testid={`feed-card-answer-error-${cardId}`}
        role="alert"
        className="space-y-1 border border-error bg-error-container px-2.5 py-2 text-on-error-container"
      >
        {leadIn ? <p className="font-mono text-[10px] uppercase tracking-wider text-on-error-container">{leadIn}</p> : null}
        <p data-testid={`feed-card-answer-error-message-${cardId}`} className="font-body text-[11px] leading-relaxed break-words whitespace-pre-wrap">
          {actionError.message}
        </p>
        {actionError.code ? (
          <div data-testid={`feed-card-answer-error-code-${cardId}`} className="font-mono text-[10px] text-on-error-container/80 break-words">
            {actionError.code}
          </div>
        ) : null}
        {actionError.unknown ? (
          <button
            type="button"
            data-testid={`feed-card-answer-refresh-${cardId}`}
            onClick={() => void refreshQueueRow({ fromUnknown: true })}
            className="mt-1 min-h-[36px] border border-on-error-container px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-on-error-container hover:opacity-80"
          >
            Refresh request state
          </button>
        ) : null}
      </div>
    ) : null;

  if (lastOutcome?.outcome === "answered") {
    const pairs = formatRecordedAnswers(questions, mergedAnswers);
    return (
      <div data-testid={`feed-card-answer-receipt-${cardId}`} className="w-full space-y-2 border border-outline-variant bg-surface-lowest/55 p-3">
        {identityHeader}
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" strokeWidth={1.8} />
          <span>
            {lastOutcome.notClosed ? `Answered and returned to ${askerLabel}; this ask didn't close.` : `Answered and sent to ${askerLabel}.`}
          </span>
        </div>
        {lastOutcome.message ? (
          <p data-testid={`feed-card-answer-receipt-message-${cardId}`} className="font-body text-[12px] leading-relaxed text-on-surface break-words">
            {lastOutcome.message}
          </p>
        ) : null}
        {lastOutcome.code ? (
          <div data-testid={`feed-card-answer-error-code-${cardId}`} className="font-mono text-[10px] text-on-surface-variant break-words">
            {lastOutcome.code}
          </div>
        ) : null}
        {pairs.length > 0 ? (
          <dl className="space-y-1 pt-1 font-body text-[12px] text-on-surface">
            {pairs.map((p) => (
              <div key={p.questionId} className="break-words">
                <dt className="inline font-semibold">{p.question}: </dt>
                <dd className="inline">{p.answerText}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    );
  }

  if ((settledState && !settledState.refreshing) || propIsTerminal) {
    return (
      <div data-testid={`feed-card-answer-settled-${cardId}`} className="w-full space-y-2 border border-outline-variant bg-surface-lowest/55 p-3">
        {identityHeader}
        <p data-testid={`feed-card-answer-settled-headline-${cardId}`} className="font-body text-[12px] font-medium leading-relaxed text-on-surface break-words">
          {settledElsewhereHeadline(settledState?.refreshedItem ?? queueItem, questions, settledState?.fallbackState)}
        </p>
        {renderErrorAlert()}
      </div>
    );
  }

  const queryState = queryClient.getQueryState<QueueItemDetail | null>(["queue", "item", qitemId]);
  const revisionUnavailable =
    !hasRevision &&
    !settledState?.refreshing &&
    (revisionLoadFailed ||
      (queueItem !== undefined && !queueItem.decisionRevision) ||
      queryState?.status === "error" ||
      (queryState?.status === "success" && !queryState.data?.decisionRevision));
  const controlsDisabled = mutation.isPending || Boolean(settledState?.refreshing) || !hasRevision;
  const statusLine = settledState?.refreshing
    ? "Refreshing request state..."
    : mutation.isPending
      ? "Sending..."
      : allAnswered
        ? "All answered and recorded. Not sent yet."
        : lastOutcome?.outcome === "recorded"
          ? `Recorded. ${answeredCount} of ${totalQuestions} answered. Not sent yet.`
          : answeredCount > 0
            ? `${answeredCount} of ${totalQuestions} answered. Not sent yet.`
            : revisionUnavailable
              ? "Could not load request state. Answer in the TUI (rig tui) or retry."
              : !hasRevision
                ? "Loading request state..."
                : totalQuestions === 1
                  ? `Your answer goes to ${askerLabel} when answered.`
                  : `Your answers go to ${askerLabel} when all ${totalQuestions} are answered.`;
  const errorLeadIn = actionError?.unknown
    ? "Outcome unknown — couldn't confirm whether your answer went through."
    : actionError?.code === "answer_not_closed" && actionError?.source !== "words"
      ? "Your choices are recorded."
      : actionError?.source === "words"
        ? "Not recorded or sent. Your text is still here."
        : "Answer not recorded.";

  return (
    <div data-testid={`feed-card-questions-${cardId}`} className="w-full space-y-3">
      {identityHeader}
      <div className="space-y-3">
        {questions.map((q, index) => {
          const chosen = ownAnswer(mergedAnswers, q.id);
          return (
            <div key={q.id} data-testid={`feed-card-question-${q.id}`} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p id={`feed-card-question-label-${cardId}-${q.id}`} className="font-body text-[12px] font-medium leading-relaxed text-on-surface break-words min-w-0">
                  {index + 1}. {q.question}
                </p>
                {chosen !== undefined ? (
                  <span data-testid={`feed-card-question-answered-${q.id}`} className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant shrink-0">
                    answered
                  </span>
                ) : null}
              </div>
              <div role="group" aria-labelledby={`feed-card-question-label-${cardId}-${q.id}`} className="grid grid-cols-1 sm:flex sm:flex-wrap gap-1.5">
                {q.options.map((opt) => {
                  const isSelected = chosen === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      data-testid={`feed-card-option-${q.id}-${opt.id}`}
                      data-selected={isSelected}
                      aria-pressed={isSelected}
                      disabled={controlsDisabled}
                      onClick={() =>
                        submitAnswer(
                          "option",
                          `opt:${q.id}:${opt.id}:${effectiveRevision ?? "none"}`,
                          { questionId: q.id, optionId: opt.id },
                          (prev) => ({ ...prev, [q.id]: opt.id }),
                        )
                      }
                      className={cn(
                        BTN_BASE_CLASS,
                        "w-full sm:w-auto text-left sm:text-center transition-colors",
                        isSelected
                          ? "bg-primary text-on-primary border-primary"
                          : "bg-surface-lowest border-outline hover:bg-surface-high text-on-surface",
                      )}
                    >
                      {isSelected ? "■ " : ""}
                      {opt.label}
                      {opt.recommended ? " · RECOMMENDED" : ""}
                    </button>
                  );
                })}
              </div>
              {typeof chosen === "object" && chosen.kind === "typed-reply" ? (
                <p className="font-mono text-[10px] text-on-surface-variant break-words">
                  Answered in your own words: {chosen.text}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="space-y-2">
        <p role="status" aria-live="polite" data-testid={`feed-card-answer-status-${cardId}`} className="font-mono text-[10px] text-on-surface-variant break-words">
          {statusLine}
        </p>
        {revisionUnavailable ? (
          <button
            type="button"
            data-testid={`feed-card-ask-retry-load-${cardId}`}
            onClick={() => void refreshQueueRow({ fromLoadRetry: true })}
            className={cn(BTN_BASE_CLASS, "w-full sm:w-auto border-outline bg-surface-lowest text-on-surface hover:bg-surface-high")}
          >
            Retry loading request state
          </button>
        ) : null}
        {lastOutcome?.message ? (
          <p data-testid={`feed-card-answer-outcome-message-${cardId}`} className="font-body text-[11px] leading-relaxed text-on-surface break-words">
            {lastOutcome.message}
          </p>
        ) : null}
        {allAnswered ? (
          <button
            type="button"
            data-testid={`feed-card-send-answers-${cardId}`}
            disabled={controlsDisabled}
            onClick={() => submitAnswer("resend", `resend:${effectiveRevision ?? "none"}`, {})}
            className={cn(BTN_BASE_CLASS, "w-full sm:w-auto border-primary bg-primary text-on-primary hover:opacity-90")}
          >
            Send answers to {askerLabel}
          </button>
        ) : null}
      </div>

      {renderErrorAlert(errorLeadIn)}

      {!allAnswered ? (
        ownWordsOpen ? (
          <div data-testid={`feed-card-own-words-box-${cardId}`} className="space-y-2 border border-outline-variant bg-surface-lowest p-2.5">
            <textarea
              data-testid={`feed-card-own-words-input-${cardId}`}
              aria-label="Answer in your own words"
              rows={3}
              value={ownWordsText}
              disabled={controlsDisabled}
              onChange={(e) => setOwnWordsText(e.target.value)}
              placeholder="Answer in your own words..."
              className="w-full px-2 py-1.5 bg-surface-container-lowest border border-outline font-body text-[12px] text-on-surface focus:outline-none focus:border-primary disabled:opacity-50"
            />
            <p className="font-mono text-[10px] text-on-surface-variant break-words">
              Sends now and closes this request. Questions you haven&apos;t answered stay unanswered.
            </p>
            <div className="flex flex-col min-[360px]:flex-row min-[360px]:justify-end gap-1.5">
              <button
                type="button"
                data-testid={`feed-card-own-words-cancel-${cardId}`}
                disabled={controlsDisabled}
                onClick={() => setOwnWordsOpen(false)}
                className={cn(ACTION_BTN_CLASS, "border border-outline text-on-surface-variant hover:text-on-surface")}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid={`feed-card-own-words-send-${cardId}`}
                disabled={controlsDisabled || ownWordsText.trim().length === 0}
                onClick={() => {
                  const trimmed = ownWordsText.trim();
                  if (!trimmed) return;
                  const firstOpen = questions.find((q) => ownAnswer(mergedAnswers, q.id) === undefined);
                  submitAnswer(
                    "words",
                    `words:${trimmed}:${effectiveRevision ?? "none"}`,
                    { decision: trimmed },
                    (prev) => (firstOpen ? { ...prev, [firstOpen.id]: { kind: "typed-reply", text: trimmed } } : prev),
                    () => {
                      setOwnWordsOpen(false);
                      setOwnWordsText("");
                    },
                  );
                }}
                className={cn(ACTION_BTN_CLASS, "bg-primary text-on-primary hover:opacity-90")}
              >
                {mutation.isPending ? "Sending..." : "Send"}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button
              type="button"
              data-testid={`feed-card-own-words-toggle-${cardId}`}
              disabled={controlsDisabled}
              onClick={() => setOwnWordsOpen(true)}
              className={cn(BTN_BASE_CLASS, "w-full sm:w-auto py-1.5 border-outline text-on-surface hover:bg-surface-variant")}
            >
              ✎ Answer in your own words
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}
