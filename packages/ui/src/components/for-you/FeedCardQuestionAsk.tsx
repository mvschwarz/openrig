import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";

import type { QueueItemDetail } from "../../hooks/useSlices.js";
import { retainAttentionItemInSession } from "../../hooks/useAttentionItems.js";
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
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return `op-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function normalizeHumanQuestions(raw: unknown): HumanQuestionItem[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: HumanQuestionItem[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.question !== "string" ||
      !Array.isArray(entry.options) ||
      entry.options.length === 0
    ) {
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

const DONE_STATES = new Set(["done", "closed", "completed"]);
const TERMINAL_STATES = new Set([
  "done",
  "closed",
  "completed",
  "canceled",
  "cancelled",
  "denied",
  "expired",
  "handed-off",
  "handed_off",
  "routed",
]);
const NON_ANSWER_REASONS = new Set([
  "denied",
  "canceled",
  "cancelled",
  "expired",
  "handed_off_to",
  "routed",
]);
const STATE_LABELS: Record<string, string> = {
  denied: "denied",
  canceled: "dropped",
  cancelled: "dropped",
  handed_off_to: "handed off",
  "handed-off": "handed off",
  routed: "routed",
  expired: "expired",
};

interface SessionAskSnapshot {
  answers: HumanAnswersRecord;
  revision?: string;
  queueItemRevisionAtSave?: string | null;
  lastOutcome?: MissionControlActionResult["answer"] | null;
  settled?: {
    refreshedItem: QueueItemDetail | null;
    fallbackState?: string | null;
    error?: { code?: string; originCode?: string; message: string; source: "option" | "words" | "resend" } | null;
  } | null;
}

const sessionAskSnapshots = new Map<string, SessionAskSnapshot>();
const askSessionKey = (qitemId: string, hostId?: string) =>
  `${hostId && hostId !== "local" ? hostId : "local"}:${qitemId}`;

export function clearQuestionAskSessionSnapshots(): void {
  sessionAskSnapshots.clear();
}

function settledElsewhereHeadline(
  item: QueueItemDetail | null | undefined,
  questions: readonly HumanQuestionItem[],
  fallbackState?: string | null,
): string {
  const pairs = formatRecordedAnswers(questions, normalizeHumanAnswers(item?.humanAnswers));
  const state = (item?.state ?? item?.closingTransition?.state ?? item?.closingTransition?.toState ?? fallbackState ?? "closed").toLowerCase();
  const reason = item?.closureReason ?? item?.closingTransition?.closureReason ?? item?.closingTransition?.reason ?? null;
  const isAnswered = DONE_STATES.has(state) && (!reason || !NON_ANSWER_REASONS.has(reason));
  if (isAnswered && pairs.length > 0) {
    return `Already answered. Recorded: ${pairs.map((p) => `${p.question}: ${p.answerText}`).join("; ")}.`;
  }
  if (isAnswered && reason === "direct_human_reply") return "Already answered.";
  const label = (reason && STATE_LABELS[reason]) ?? STATE_LABELS[state] ?? state;
  const actor = item?.closingTransition?.actorSession;
  const target = item?.handedOffTo ?? item?.closureTarget ?? item?.closingTransition?.closureTarget;
  const parts = [
    actor ? `by ${actor}` : null,
    target && target !== "no-follow-on" ? (label === "handed off" || label === "routed" ? `to ${target}` : `(${target})`) : null,
  ].filter(Boolean);
  return `This request is ${label} now${parts.length ? ` ${parts.join(" ")}` : ""}.`;
}

export interface FeedCardQuestionAskProps {
  cardId: string;
  qitemId: string;
  actorSession: string;
  recipientSession?: string;
  askerSession?: string;
  hostId?: string;
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
  hostId,
  questions,
  initialAnswers,
  queueItem,
}: FeedCardQuestionAskProps) {
  const queryClient = useQueryClient();
  const mutation = useMissionControlAction();
  const sessionKey = askSessionKey(qitemId, hostId);
  const cached = sessionAskSnapshots.get(sessionKey);

  const [localAnswers, setLocalAnswers] = useState<HumanAnswersRecord>(() => cached?.answers ?? {});
  const [localRevision, setLocalRevision] = useState<string | undefined>(() => {
    const propRev = queueItem?.decisionRevision ?? undefined;
    if (cached?.revision) {
      return propRev && propRev !== cached.queueItemRevisionAtSave ? propRev : cached.revision;
    }
    return propRev;
  });
  const [ownWordsOpen, setOwnWordsOpen] = useState(false);
  const [ownWordsText, setOwnWordsText] = useState("");
  const [lastOutcome, setLastOutcome] = useState<MissionControlActionResult["answer"] | null>(
    () => cached?.lastOutcome ?? null,
  );
  const [actionError, setActionError] = useState<{
    code?: string;
    originCode?: string;
    message: string;
    source: "option" | "words" | "resend";
  } | null>(() => cached?.settled?.error ?? null);
  const [settledState, setSettledState] = useState<{
    refreshing: boolean;
    refreshedItem: QueueItemDetail | null;
    fallbackState?: string | null;
  } | null>(() =>
    cached?.settled
      ? { refreshing: false, refreshedItem: cached.settled.refreshedItem, fallbackState: cached.settled.fallbackState }
      : null,
  );

  const saveSnapshot = (patch: Partial<SessionAskSnapshot>) => {
    const prev = sessionAskSnapshots.get(sessionKey) ?? { answers: localAnswers, revision: localRevision };
    sessionAskSnapshots.set(sessionKey, {
      ...prev,
      queueItemRevisionAtSave: queueItem?.decisionRevision ?? null,
      ...patch,
    });
  };

  const operationIdsRef = useRef<Map<string, string>>(new Map());
  const getOperationId = (sig: string) => {
    const existing = operationIdsRef.current.get(sig);
    if (existing) return existing;
    const next = generateOperationId();
    operationIdsRef.current.set(sig, next);
    return next;
  };

  const isRemote = Boolean(hostId && hostId !== "local");
  const mergedAnswers: HumanAnswersRecord = {
    ...initialAnswers,
    ...normalizeHumanAnswers(queueItem?.humanAnswers),
    ...localAnswers,
  };
  const effectiveRevision = !isRemote ? (localRevision ?? (queueItem?.decisionRevision ?? undefined)) : undefined;
  const totalQuestions = questions.length;
  const answeredCount = questions.filter((q) => ownAnswer(mergedAnswers, q.id) !== undefined).length;
  const allAnswered = totalQuestions > 0 && answeredCount === totalQuestions;
  const askerLabel = askerSession ?? "the asker";
  const requestActorSession =
    recipientSession && isHumanSeatSessionRef(recipientSession) ? recipientSession : actorSession;
  const identityText = isRemote
    ? `Answering as ${requestActorSession} from host ${hostId}`
    : `Answering as ${actorSession}${
        recipientSession && recipientSession !== actorSession ? ` on ${recipientSession}'s ask` : ""
      }`;

  async function refreshQueueRow(
    err: Error & { code?: string; details?: unknown },
    originCode: string,
    errSummary?: { code?: string; originCode?: string; message: string; source: "option" | "words" | "resend" } | null,
  ) {
    const details = isRecord(err.details) ? err.details : undefined;
    const fallbackState = typeof details?.state === "string" ? details.state : null;
    const isTerminalOrigin = originCode === "qitem_already_terminal" || originCode === "decision_revision_changed";
    if (isTerminalOrigin) {
      setSettledState({ refreshing: true, refreshedItem: queueItem ?? null, fallbackState });
    }
    void queryClient.invalidateQueries({ queryKey: ["attention-items"] });
    void queryClient.invalidateQueries({ queryKey: ["mission-control", "audit"] });

    let refreshed: QueueItemDetail | null = null;
    if (!isRemote) {
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
        // Fall back to cached queueItem if direct fetch fails.
      }
    }

    const nextRev =
      refreshed?.decisionRevision ?? (typeof details?.currentRevision === "string" ? details.currentRevision : undefined);
    if (nextRev) {
      setLocalRevision(nextRev);
      saveSnapshot({ revision: nextRev });
    }
    const nextAnswers = refreshed?.humanAnswers ?? details?.humanAnswers;
    if (nextAnswers) {
      const normalized = normalizeHumanAnswers(nextAnswers);
      setLocalAnswers(normalized);
      saveSnapshot({ answers: normalized });
    }

    if (!isTerminalOrigin) return;
    const effectiveItem = refreshed ?? queueItem ?? null;
    const effectiveState = (refreshed?.state ?? fallbackState ?? queueItem?.state ?? "pending").toLowerCase();
    if (
      !isRemote &&
      originCode === "decision_revision_changed" &&
      (effectiveState === "pending" || effectiveState === "in-progress")
    ) {
      setSettledState(null);
      saveSnapshot({ settled: null });
      return;
    }
    setSettledState({ refreshing: false, refreshedItem: effectiveItem, fallbackState });
    saveSnapshot({ settled: { refreshedItem: effectiveItem, fallbackState, error: errSummary ?? null } });
  }

  function submitAnswer(
    source: "option" | "words" | "resend",
    signature: string,
    fields: Partial<MissionControlActionInput>,
    optimisticUpdate?: (prev: HumanAnswersRecord) => HumanAnswersRecord,
    onDone?: () => void,
  ) {
    if (mutation.isPending || settledState) return;
    let operationId: string;
    try {
      retainAttentionItemInSession(qitemId, hostId);
      operationId = getOperationId(signature);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError({ message: msg, source });
      return;
    }
    setActionError(null);
    mutation.mutate(
      {
        verb: "answer",
        qitemId,
        actorSession: requestActorSession,
        ...fields,
        ...(effectiveRevision !== undefined ? { expectedRevision: effectiveRevision } : {}),
        ...(!isRemote ? { authority: "primary-user" } : {}),
        auditNotes: { operationId },
        ...(isRemote && hostId ? { hostId } : {}),
      },
      {
        onSuccess: (result: MissionControlActionResult) => {
          operationIdsRef.current.delete(signature);
          setActionError(null);
          if (result.decisionRevision) {
            setLocalRevision(result.decisionRevision);
            if (!isRemote && queueItem) {
              queryClient.setQueryData<QueueItemDetail | null>(["queue", "item", qitemId], (old) =>
                old ? { ...old, decisionRevision: result.decisionRevision } : old,
              );
            }
          }
          const closed = isRecord(result.closedQitem) ? result.closedQitem : null;
          let updatedAnswers = mergedAnswers;
          if (closed?.humanAnswers) {
            updatedAnswers = normalizeHumanAnswers(closed.humanAnswers);
            setLocalAnswers(updatedAnswers);
          } else if (optimisticUpdate) {
            updatedAnswers = optimisticUpdate(localAnswers);
            setLocalAnswers(updatedAnswers);
          }
          const closedState = typeof closed?.state === "string" ? closed.state.toLowerCase() : undefined;
          const inferredOutcome: MissionControlActionResult["answer"] =
            result.answer ??
            (closedState && !TERMINAL_STATES.has(closedState)
              ? {
                  outcome: "recorded",
                  unanswered: questions
                    .filter((q) => ownAnswer({ ...mergedAnswers, ...updatedAnswers }, q.id) === undefined)
                    .map((q) => q.question),
                }
              : { outcome: "answered", unanswered: [] });
          setLastOutcome(inferredOutcome);
          saveSnapshot({
            answers: updatedAnswers,
            revision: result.decisionRevision ?? localRevision,
            lastOutcome: inferredOutcome,
          });
          onDone?.();
        },
        onError: (err: unknown) => {
          const typedErr = (err instanceof Error ? err : new Error(String(err))) as Error & {
            code?: string;
            details?: unknown;
          };
          const details = isRecord(typedErr.details) ? typedErr.details : undefined;
          const originCode =
            typedErr.code === "remote_action_failed" && typeof details?.detail === "string" && details.detail
              ? details.detail
              : typedErr.code;
          const errSummary = { code: originCode, originCode, message: typedErr.message, source };
          setActionError(errSummary);
          if (originCode === "answer_not_closed" && source === "option" && optimisticUpdate) {
            const next = optimisticUpdate(localAnswers);
            setLocalAnswers(next);
            saveSnapshot({ answers: next });
          }
          if (
            originCode === "qitem_already_terminal" ||
            originCode === "decision_revision_changed" ||
            (originCode === "answer_not_closed" && source !== "words")
          ) {
            void refreshQueueRow(typedErr, originCode, errSummary);
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
      </div>
    ) : null;

  if (lastOutcome?.outcome === "answered") {
    const pairs = formatRecordedAnswers(questions, mergedAnswers);
    return (
      <div data-testid={`feed-card-answer-receipt-${cardId}`} className="w-full space-y-2 border border-outline-variant bg-surface-lowest/55 p-3">
        {identityHeader}
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" strokeWidth={1.8} />
          <span>Answered and sent to {askerLabel}.</span>
        </div>
        {lastOutcome.message ? (
          <p className="font-body text-[12px] leading-relaxed text-on-surface break-words">{lastOutcome.message}</p>
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

  const queueStateLower = queueItem?.state?.toLowerCase();
  const isQueueTerminal = Boolean(!isRemote && queueStateLower && TERMINAL_STATES.has(queueStateLower));
  if ((settledState && !settledState.refreshing) || isQueueTerminal) {
    const settledHeadline = isRemote
      ? "This request is no longer waiting."
      : settledElsewhereHeadline(settledState?.refreshedItem ?? queueItem, questions, settledState?.fallbackState);
    return (
      <div data-testid={`feed-card-answer-settled-${cardId}`} className="w-full space-y-2 border border-outline-variant bg-surface-lowest/55 p-3">
        {identityHeader}
        <p data-testid={`feed-card-answer-settled-headline-${cardId}`} className="font-body text-[12px] font-medium leading-relaxed text-on-surface break-words">
          {settledHeadline}
        </p>
        {renderErrorAlert()}
      </div>
    );
  }

  const controlsDisabled = mutation.isPending || Boolean(settledState?.refreshing);
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
            : totalQuestions === 1
              ? `Your answer goes to ${askerLabel} when answered.`
              : `Your answers go to ${askerLabel} when all ${totalQuestions} are answered.`;
  const errorLeadIn =
    actionError?.source === "words"
      ? "Nothing was sent. Your text is still here."
      : actionError?.originCode === "answer_not_closed" || allAnswered
        ? "Your choices are recorded."
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
                        "w-full sm:w-auto min-h-[44px] px-3 py-2 border font-mono text-[10px] uppercase tracking-wider text-left sm:text-center break-words whitespace-normal transition-colors disabled:opacity-50",
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
        {allAnswered ? (
          <button
            type="button"
            data-testid={`feed-card-send-answers-${cardId}`}
            disabled={controlsDisabled}
            onClick={() => submitAnswer("resend", `resend:${effectiveRevision ?? "none"}`, {})}
            className="w-full sm:w-auto min-h-[44px] px-3 py-2 border border-primary bg-primary text-on-primary font-mono text-[10px] uppercase tracking-wider break-words whitespace-normal hover:opacity-90 disabled:opacity-50"
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
                className="w-full min-[360px]:w-auto min-h-[44px] px-3 py-1 font-mono text-[10px] uppercase border border-outline text-on-surface-variant hover:text-on-surface disabled:opacity-50"
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
                className="w-full min-[360px]:w-auto min-h-[44px] px-3 py-1 font-mono text-[10px] uppercase bg-primary text-on-primary hover:opacity-90 disabled:opacity-50"
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
              className="w-full sm:w-auto min-h-[44px] border border-outline px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-on-surface hover:bg-surface-variant break-words whitespace-normal disabled:opacity-50"
            >
              ✎ Answer in your own words
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}
