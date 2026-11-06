/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { FeedCard } from "../src/components/for-you/FeedCard.js";
import { clearQuestionAskSessionSnapshots } from "../src/components/for-you/FeedCardQuestionAsk.js";
import {
  clearRetainedAttentionItems,
  retainAttentionItemInSession,
  useAttentionItems,
  type AttentionQueueItem,
} from "../src/hooks/useAttentionItems.js";
import type { FeedCard as FeedCardModel } from "../src/lib/feed-classifier.js";
import { useQueueItemMap, type QueueItemDetail } from "../src/hooks/useSlices.js";
import { attentionItemToFeedCard } from "../src/lib/attention-feed.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({
  ProgressiveTerminal: () => <div data-testid="shared-progressive-terminal" />,
}));

vi.mock("../src/components/for-you/FeedCardTerminalDrill.js", () => ({
  FeedCardTerminalDrill: () => <button type="button" data-testid="terminal-drill-stub" />,
}));

vi.mock("../src/components/for-you/AuthorAgentTag.js", () => ({
  AuthorAgentTag: ({ authorSession }: { authorSession: string }) => <span>{authorSession}</span>,
}));

vi.mock("../src/components/drawer-triggers/QueueItemTrigger.js", () => ({
  QueueItemTrigger: ({ children, testId }: { children: ReactNode; testId?: string }) => (
    <button type="button" data-testid={testId}>{children}</button>
  ),
}));

const TWO_QUESTIONS = [
  {
    id: "channel",
    question: "Which channel ships first?",
    options: [
      { id: "stable", label: "Stable", recommended: true },
      { id: "beta", label: "Beta" },
      { id: "nightly", label: "Nightly" },
    ],
  },
  {
    id: "changelog",
    question: "Hold the changelog until docs land?",
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
  },
];

function makeQuestionCard(
  overrides?: Partial<FeedCardModel>,
  payloadOverrides?: Record<string, unknown>,
): FeedCardModel {
  return {
    id: "queue-attention-q-ask-1",
    kind: "action-required",
    title: "Pick the release channel",
    body: "Need release channel and changelog timing.",
    authorSession: "lead@demo",
    createdAt: "2026-11-06T00:00:00Z",
    receivedAt: 1,
    source: {
      seq: -1,
      type: "queue.attention.synthetic",
      createdAt: "2026-11-06T00:00:00Z",
      receivedAt: 1,
      payload: {
        qitemId: "q-ask-1",
        sourceSession: "lead@demo",
        destinationSession: "human@host",
        state: "pending",
        humanQuestions: TWO_QUESTIONS,
        humanAnswers: null,
        ...payloadOverrides,
      },
    },
    ...overrides,
  };
}

function makeQueueItem(overrides?: Partial<QueueItemDetail>): QueueItemDetail {
  return {
    qitemId: "q-ask-1",
    sourceSession: "lead@demo",
    destinationSession: "human@host",
    state: "pending",
    decisionRevision: "rev-1",
    humanQuestions: TWO_QUESTIONS,
    humanAnswers: null,
    ...overrides,
  } as unknown as QueueItemDetail;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderWithQuery(node: ReactNode, queryClient?: QueryClient) {
  const qc =
    queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearQuestionAskSessionSnapshots();
  clearRetainedAttentionItems();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("For You — answering an ask's structured questions (#2407 / #2612)", () => {
  it("shows human@host (unattributed) identity on local cards and keeps the #2415 TUI hint without answer controls on remote cards", () => {
    const localCard = makeQuestionCard({}, { destinationSession: "alex@external" });
    const localView = renderWithQuery(
      <FeedCard card={localCard} queueItem={makeQueueItem({ destinationSession: "alex@external" })} />,
    );
    expect(
      localView.getByTestId("feed-card-answer-identity-queue-attention-q-ask-1").textContent,
    ).toBe("Answering as human@host (unattributed) on alex@external's ask");

    const stableBtn = localView.getByTestId("feed-card-option-channel-stable");
    expect(stableBtn.textContent).toContain("Stable · RECOMMENDED");
    expect(stableBtn.className).toContain("min-h-[44px]");
    expect(localView.queryByTestId("mc-verb-approve")).toBeNull();
    cleanup();

    const directHumanView = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={makeQueueItem()} />);
    expect(
      directHumanView.getByTestId("feed-card-answer-identity-queue-attention-q-ask-1").textContent,
    ).toBe("Answering as human@host (unattributed)");
    cleanup();

    const remoteCard = makeQuestionCard({ hostId: "box-west" }, { destinationSession: "alex@external" });
    const remoteView = renderWithQuery(<FeedCard card={remoteCard} />);
    expect(remoteView.queryByTestId("feed-card-questions-queue-attention-q-ask-1")).toBeNull();
    expect(remoteView.queryByTestId("feed-card-option-channel-stable")).toBeNull();
    expect(remoteView.container.textContent).toContain(
      "This ask has questions. Answer in the TUI on host box-west (rig tui).",
    );
    expect(remoteView.container.textContent).not.toContain("tell lead@demo in Chat");
  });

  it("keeps controls disabled until local queueItem loads decisionRevision, and sends expectedRevision on every answer", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes("/api/queue/q-ask-1")) {
          return jsonResponse(makeQueueItem({ decisionRevision: "rev-loaded-1" }));
        }
        calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return jsonResponse({
          actionId: "a-1",
          verb: "answer",
          qitemId: "q-ask-1",
          closedQitem: { qitemId: "q-ask-1", state: "pending", humanAnswers: { channel: "stable" } },
          createdQitemId: null,
          notifyAttempted: false,
          notifyResult: null,
          auditedAt: "2026-11-06T00:01:00Z",
          decisionRevision: "rev-2",
          answer: { outcome: "recorded", unanswered: ["Hold the changelog until docs land?"] },
        });
      }),
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = renderWithQuery(<FeedCard card={makeQuestionCard()} />, qc);
    const stableBtn = view.getByTestId("feed-card-option-channel-stable");
    const ownWordsToggle = view.getByTestId("feed-card-own-words-toggle-queue-attention-q-ask-1");

    expect(stableBtn.hasAttribute("disabled")).toBe(true);
    expect(ownWordsToggle.hasAttribute("disabled")).toBe(true);
    expect(view.getByTestId("feed-card-answer-status-queue-attention-q-ask-1").textContent).toBe(
      "Loading request state...",
    );

    fireEvent.click(stableBtn);
    expect(calls).toHaveLength(0);

    // When queueItem loads without decisionRevision, offer TUI hint + retry instead of hanging on "Loading..."
    view.rerender(
      <QueryClientProvider client={qc}>
        <FeedCard card={makeQuestionCard()} queueItem={makeQueueItem({ decisionRevision: null })} />
      </QueryClientProvider>,
    );
    expect(view.getByTestId("feed-card-answer-status-queue-attention-q-ask-1").textContent).toBe(
      "Could not load request state. Answer in the TUI (rig tui) or retry.",
    );
    fireEvent.click(view.getByTestId("feed-card-ask-retry-load-queue-attention-q-ask-1"));

    await waitFor(() =>
      expect(view.getByTestId("feed-card-option-channel-stable").hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(view.getByTestId("feed-card-option-channel-stable"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.expectedRevision).toBe("rev-loaded-1");
  });

  it("records each option click (outcome=recorded) and closes on the last question (outcome=answered) with expectedRevision and operationId", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        if (calls.length === 1) {
          return jsonResponse({
            actionId: "a-1",
            verb: "answer",
            qitemId: "q-ask-1",
            closedQitem: { qitemId: "q-ask-1", state: "pending", humanAnswers: { channel: "stable" } },
            createdQitemId: null,
            notifyAttempted: false,
            notifyResult: null,
            auditedAt: "2026-11-06T00:01:00Z",
            decisionRevision: "rev-2",
            answer: { outcome: "recorded", unanswered: ["Hold the changelog until docs land?"] },
          });
        }
        return jsonResponse({
          actionId: "a-2",
          verb: "answer",
          qitemId: "q-ask-1",
          closedQitem: {
            qitemId: "q-ask-1",
            state: "done",
            humanAnswers: { channel: "stable", changelog: "no" },
          },
          createdQitemId: "q-reply-1",
          notifyAttempted: false,
          notifyResult: null,
          auditedAt: "2026-11-06T00:01:05Z",
          decisionRevision: "rev-3",
          answer: { outcome: "answered", unanswered: [], message: "Already answered; no new reply was sent." },
        });
      }),
    );

    const view = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={makeQueueItem()} />);

    fireEvent.click(view.getByTestId("feed-card-option-channel-stable"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      verb: "answer",
      qitemId: "q-ask-1",
      actorSession: "human@host",
      questionId: "channel",
      optionId: "stable",
      expectedRevision: "rev-1",
      authority: "primary-user",
    });
    expect(typeof (calls[0]!.auditNotes as Record<string, unknown>)?.operationId).toBe("string");

    await waitFor(() => {
      expect(
        view.getByTestId("feed-card-answer-status-queue-attention-q-ask-1").textContent,
      ).toBe("Recorded. 1 of 2 answered. Not sent yet.");
    });
    expect(view.getByTestId("feed-card-question-answered-channel")).toBeTruthy();
    expect(view.getByTestId("feed-card-option-channel-stable").getAttribute("data-selected")).toBe("true");

    fireEvent.click(view.getByTestId("feed-card-option-changelog-no"));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({
      verb: "answer",
      qitemId: "q-ask-1",
      actorSession: "human@host",
      questionId: "changelog",
      optionId: "no",
      expectedRevision: "rev-2",
    });

    await waitFor(() => {
      const receipt = view.getByTestId("feed-card-answer-receipt-queue-attention-q-ask-1");
      expect(receipt.textContent).toContain("Answered and sent to lead@demo.");
      expect(receipt.textContent).toContain("Already answered; no new reply was sent.");
      expect(receipt.textContent).toContain("Which channel ships first?: Stable");
      expect(receipt.textContent).toContain("Hold the changelog until docs land?: No");
    });
  });

  it("hydrates partial and complete unsent answers on reload, offering SEND ANSWERS TO <asker> when all are answered", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return jsonResponse({
          actionId: "a-resend",
          verb: "answer",
          qitemId: "q-ask-1",
          closedQitem: {
            qitemId: "q-ask-1",
            state: "done",
            humanAnswers: { channel: "beta", changelog: "yes" },
          },
          createdQitemId: "q-reply-2",
          notifyAttempted: false,
          notifyResult: null,
          auditedAt: "2026-11-06T00:02:00Z",
          decisionRevision: "rev-2",
          answer: { outcome: "answered", unanswered: [] },
        });
      }),
    );

    const card = attentionItemToFeedCard({
      qitemId: "q-ask-1",
      tsCreated: "2026-11-06T00:00:00Z",
      tsUpdated: "2026-11-06T00:01:00Z",
      sourceSession: "lead@demo",
      destinationSession: "human@host",
      state: "pending",
      priority: "normal",
      tier: null,
      tags: null,
      blockedOn: null,
      handedOffTo: null,
      handedOffFrom: null,
      body: "Pick release options",
      humanQuestions: TWO_QUESTIONS,
      humanAnswers: { channel: "beta", changelog: "yes" },
    });

    const view = renderWithQuery(
      <FeedCard card={card} queueItem={makeQueueItem({ humanAnswers: { channel: "beta", changelog: "yes" } })} />,
    );
    expect(view.getByTestId("feed-card-answer-status-queue-attention-q-ask-1").textContent).toBe(
      "All answered and recorded. Not sent yet.",
    );

    const sendBtn = view.getByTestId("feed-card-send-answers-queue-attention-q-ask-1");
    expect(sendBtn.textContent).toBe("Send answers to lead@demo");

    fireEvent.click(sendBtn);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      verb: "answer",
      qitemId: "q-ask-1",
      actorSession: "human@host",
      expectedRevision: "rev-1",
    });
    expect("questionId" in calls[0]!).toBe(false);
    expect("optionId" in calls[0]!).toBe(false);
    expect("decision" in calls[0]!).toBe(false);
  });

  it("answers in your own words (decision), and distinguishes unrecorded failure, answer_not_closed with replyQitemId, closed-without-answer, and unknown outcome with refresh", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let mode: "unrecordedFail" | "returnedNotClosed" | "closedWithoutAnswer" | "unknownNetwork" = "unrecordedFail";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes("/api/queue/q-ask-1")) {
          return jsonResponse({
            qitemId: "q-ask-1",
            state: "pending",
            decisionRevision: "rev-refreshed",
            humanQuestions: TWO_QUESTIONS,
            humanAnswers: { channel: "beta" },
          });
        }
        calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        if (mode === "unrecordedFail") {
          return jsonResponse(
            {
              error: "answer_not_closed",
              message:
                "Returning the answer to lead@demo failed (disk full), so q-ask-1 wasn't closed. Nothing was recorded; answer again once that's fixed.",
            },
            409,
          );
        }
        if (mode === "returnedNotClosed") {
          return jsonResponse(
            {
              error: "answer_not_closed",
              message:
                "The answer went back to lead@demo as q-reply-9, but qitem q-ask-1 didn't close: it changed meanwhile.",
              qitemId: "q-ask-1",
              replyQitemId: "q-reply-9",
            },
            409,
          );
        }
        if (mode === "closedWithoutAnswer") {
          return jsonResponse({
            actionId: "a-reconciled-canceled",
            verb: "answer",
            qitemId: "q-ask-1",
            reconciled: true,
            decisionRevision: "rev-canceled",
            closedQitem: {
              qitemId: "q-ask-1",
              state: "canceled",
              closureReason: "canceled",
              humanAnswers: { channel: "stable" },
            },
            createdQitemId: null,
            notifyAttempted: false,
            notifyResult: null,
            auditedAt: "2026-11-06T00:03:00Z",
          });
        }
        throw new TypeError("Failed to fetch");
      }),
    );

    const view = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={makeQueueItem()} />);

    fireEvent.click(view.getByTestId("feed-card-own-words-toggle-queue-attention-q-ask-1"));
    const input = view.getByTestId("feed-card-own-words-input-queue-attention-q-ask-1") as HTMLTextAreaElement;
    const sendBtn = view.getByTestId("feed-card-own-words-send-queue-attention-q-ask-1");

    fireEvent.change(input, { target: { value: "Ship beta first; stable waits for Friday." } });
    fireEvent.click(sendBtn);
    await waitFor(() => expect(calls).toHaveLength(1));

    await waitFor(() => {
      const errAlert = view.getByTestId("feed-card-answer-error-queue-attention-q-ask-1");
      expect(errAlert.textContent).toContain("Not recorded or sent. Your text is still here.");
      expect(view.getByTestId("feed-card-answer-error-message-queue-attention-q-ask-1").textContent).toContain(
        "Returning the answer to lead@demo failed (disk full), so q-ask-1 wasn't closed.",
      );
      expect(view.getByTestId("feed-card-answer-error-code-queue-attention-q-ask-1").textContent).toBe(
        "answer_not_closed",
      );
    });
    expect(input.value).toBe("Ship beta first; stable waits for Friday.");

    // 2. When answer_not_closed carries replyQitemId, the answer went back and the ask didn't close:
    //    show the answered-and-returned receipt with the daemon's own message (never "Not sent").
    mode = "returnedNotClosed";
    fireEvent.click(sendBtn);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect((calls[1]!.auditNotes as Record<string, unknown>).operationId).toBe(
      (calls[0]!.auditNotes as Record<string, unknown>).operationId,
    );

    await waitFor(() => {
      const receipt = view.getByTestId("feed-card-answer-receipt-queue-attention-q-ask-1");
      expect(receipt.textContent).toContain("Answered and returned to lead@demo; this ask didn't close.");
      expect(receipt.textContent).toContain(
        "The answer went back to lead@demo as q-reply-9, but qitem q-ask-1 didn't close: it changed meanwhile.",
      );
      expect(view.getByTestId("feed-card-answer-error-code-queue-attention-q-ask-1").textContent).toBe(
        "answer_not_closed",
      );
    });
    cleanup();
    clearQuestionAskSessionSnapshots();

    // 3. When a response has no 'answer' and closedQitem is in a non-answered closed state (canceled),
    //    render closed-without-an-answer ("This request is dropped now."), never "Answered and sent",
    //    and keep the settled panel intact when useQueueItemMap re-renders from the updated ["queue","item"] cache.
    mode = "closedWithoutAnswer";
    const canceledQc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    canceledQc.setQueryData(["queue", "item", "q-ask-1"], makeQueueItem());
    function ReactiveQuestionCard() {
      const map = useQueueItemMap(["q-ask-1"]);
      return <FeedCard card={makeQuestionCard()} queueItem={map.itemsById.get("q-ask-1")} />;
    }
    const canceledView = renderWithQuery(<ReactiveQuestionCard />, canceledQc);
    fireEvent.click(canceledView.getByTestId("feed-card-option-channel-stable"));
    await waitFor(() => {
      const settled = canceledView.getByTestId("feed-card-answer-settled-queue-attention-q-ask-1");
      expect(settled.textContent).toContain("This request is dropped now.");
      expect(settled.textContent).not.toContain("Answered and sent");
    });
    expect(canceledView.queryByTestId("feed-card-option-channel-stable")).toBeNull();
    cleanup();
    clearQuestionAskSessionSnapshots();

    // 4. When connection is lost (or response isn't JSON), report outcome unknown and offer a refresh button.
    mode = "unknownNetwork";
    const unknownView = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={makeQueueItem()} />);
    fireEvent.click(unknownView.getByTestId("feed-card-option-channel-stable"));
    await waitFor(() => {
      const alert = unknownView.getByTestId("feed-card-answer-error-queue-attention-q-ask-1");
      expect(alert.textContent).toContain("Outcome unknown — couldn't confirm whether your answer went through.");
      expect(alert.textContent).not.toContain("Nothing was sent");
      expect(alert.textContent).not.toContain("Answer not recorded");
    });
    const refreshBtn = unknownView.getByTestId("feed-card-answer-refresh-queue-attention-q-ask-1");
    fireEvent.click(refreshBtn);
    await waitFor(() => {
      expect(unknownView.queryByTestId("feed-card-answer-error-queue-attention-q-ask-1")).toBeNull();
      expect(unknownView.getByTestId("feed-card-option-channel-beta").getAttribute("data-selected")).toBe("true");
    });
  });

  it("refreshes the queue row on qitem_already_terminal and shows actual non-answered state (e.g. dropped) without offering to resend", async () => {
    let mode: "withState" | "noStateFailedRefetch" = "withState";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes("/api/mission-control/action")) {
          if (mode === "noStateFailedRefetch") {
            return jsonResponse(
              {
                error: "qitem_already_terminal",
                message: "qitem q-ask-1 was already answered by alex@external (q-reply-2).",
                qitemId: "q-ask-1",
                answeredBy: "alex@external",
                replyQitemId: "q-reply-2",
              },
              409,
            );
          }
          return jsonResponse(
            {
              error: "qitem_already_terminal",
              message:
                "qitem q-ask-1 is done, not waiting on an answer (it may already be answered), so nothing was recorded or sent.",
              state: "done",
            },
            409,
          );
        }
        if (u.includes("/api/queue/q-ask-1")) {
          if (mode === "noStateFailedRefetch") {
            return new Response("Service Unavailable", { status: 503 });
          }
          return jsonResponse({
            qitemId: "q-ask-1",
            state: "done",
            closureReason: "canceled",
            closureTarget: "no longer needed",
            closingTransition: { actorSession: "lead@demo", reason: "canceled", toState: "done" },
            humanQuestions: TWO_QUESTIONS,
            humanAnswers: null,
          });
        }
        return jsonResponse({});
      }),
    );

    const view = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={makeQueueItem()} />);
    fireEvent.click(view.getByTestId("feed-card-option-channel-stable"));

    await waitFor(() => {
      const settled = view.getByTestId("feed-card-answer-settled-queue-attention-q-ask-1");
      expect(settled.textContent).toContain("This request is dropped now by lead@demo (no longer needed).");
      expect(view.getByTestId("feed-card-answer-error-code-queue-attention-q-ask-1").textContent).toBe(
        "qitem_already_terminal",
      );
    });
    expect(view.queryByTestId("feed-card-option-channel-stable")).toBeNull();
    expect(view.queryByTestId("feed-card-send-answers-queue-attention-q-ask-1")).toBeNull();

    // Even when qitem_already_terminal has no details.state (answeredByAnother form) and the refetch fails,
    // the card must stay settled and never restore live answer buttons.
    cleanup();
    clearQuestionAskSessionSnapshots();
    mode = "noStateFailedRefetch";
    const noStateView = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={makeQueueItem()} />);
    fireEvent.click(noStateView.getByTestId("feed-card-option-channel-stable"));
    await waitFor(() => {
      const settled = noStateView.getByTestId("feed-card-answer-settled-queue-attention-q-ask-1");
      expect(settled.textContent).toContain("qitem q-ask-1 was already answered by alex@external (q-reply-2).");
    });
    expect(noStateView.queryByTestId("feed-card-option-channel-stable")).toBeNull();
  });

  it("refreshes the queue row on decision_revision_changed when another person settled the ask and shows their recorded answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes("/api/mission-control/action")) {
          return jsonResponse(
            {
              error: "decision_revision_changed",
              message:
                "qitem q-ask-1 changed since this revision was read, so nothing was written. Read it again for the current decision.",
              currentRevision: "rev-9",
              state: "done",
              humanAnswers: { channel: "nightly", changelog: "yes" },
            },
            409,
          );
        }
        if (u.includes("/api/queue/q-ask-1")) {
          return jsonResponse({
            qitemId: "q-ask-1",
            state: "done",
            closureReason: "direct_human_reply",
            decisionRevision: "rev-9",
            humanQuestions: TWO_QUESTIONS,
            humanAnswers: { channel: "nightly", changelog: "yes" },
          });
        }
        return jsonResponse({});
      }),
    );

    const view = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={makeQueueItem()} />);
    fireEvent.click(view.getByTestId("feed-card-option-channel-stable"));

    await waitFor(() => {
      const settled = view.getByTestId("feed-card-answer-settled-queue-attention-q-ask-1");
      expect(settled.textContent).toContain(
        "Already answered. Recorded: Which channel ships first?: Nightly; Hold the changelog until docs land?: Yes.",
      );
      expect(view.getByTestId("feed-card-answer-error-code-queue-attention-q-ask-1").textContent).toBe(
        "decision_revision_changed",
      );
    });
    expect(view.queryByTestId("feed-card-option-channel-stable")).toBeNull();
    expect(view.queryByTestId("feed-card-send-answers-queue-attention-q-ask-1")).toBeNull();
  });

  it("lets fresh queue data win over session-saved state when a cancelled ask is reopened (in-place and on remount)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("/api/mission-control/action")) {
          return jsonResponse(
            {
              error: "qitem_already_terminal",
              message: "qitem q-ask-1 is canceled, not waiting on an answer.",
              state: "canceled",
            },
            409,
          );
        }
        return jsonResponse({
          qitemId: "q-ask-1",
          state: "canceled",
          closureReason: "canceled",
          decisionRevision: "rev-canceled-2",
          humanQuestions: TWO_QUESTIONS,
          humanAnswers: null,
        });
      }),
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = renderWithQuery(
      <FeedCard card={makeQuestionCard()} queueItem={makeQueueItem({ decisionRevision: "rev-open-1" })} />,
      qc,
    );

    fireEvent.click(view.getByTestId("feed-card-option-channel-stable"));
    await waitFor(() => {
      expect(view.getByTestId("feed-card-answer-settled-queue-attention-q-ask-1").textContent).toContain(
        "This request is dropped now.",
      );
    });

    // Remount with the same cancelled revision: stays settled
    cleanup();
    const stillCancelled = renderWithQuery(
      <FeedCard
        card={makeQuestionCard()}
        queueItem={makeQueueItem({ state: "canceled", closureReason: "canceled", decisionRevision: "rev-canceled-2" })}
      />,
      qc,
    );
    expect(stillCancelled.getByTestId("feed-card-answer-settled-queue-attention-q-ask-1")).toBeTruthy();

    // Reopen the ask with a newer revision ("rev-reopened-3"): fresh state replaces saved settled state and restores controls
    stillCancelled.rerender(
      <QueryClientProvider client={qc}>
        <FeedCard
          card={makeQuestionCard()}
          queueItem={makeQueueItem({ state: "pending", closureReason: null, decisionRevision: "rev-reopened-3" })}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(stillCancelled.queryByTestId("feed-card-answer-settled-queue-attention-q-ask-1")).toBeNull();
      expect(stillCancelled.getByTestId("feed-card-option-channel-stable").hasAttribute("disabled")).toBe(false);
    });
  });

  it("keeps recorded-not-sent status on a reconciled retry when closedQitem is still pending, and preserves receipt on remount", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return jsonResponse({
            actionId: "a-rec",
            verb: "answer",
            qitemId: "q-ask-1",
            reconciled: true,
            decisionRevision: "rev-2",
            closedQitem: { qitemId: "q-ask-1", state: "pending", humanAnswers: { channel: "stable" } },
            createdQitemId: null,
            notifyAttempted: false,
            notifyResult: null,
            auditedAt: "2026-11-06T00:01:00Z",
          });
        }
        return jsonResponse({
          actionId: "a-rec-2",
          verb: "answer",
          qitemId: "q-ask-1",
          decisionRevision: "rev-3",
          closedQitem: { qitemId: "q-ask-1", state: "done", humanAnswers: { channel: "stable", changelog: "yes" } },
          createdQitemId: "q-reply-rec",
          notifyAttempted: false,
          notifyResult: null,
          auditedAt: "2026-11-06T00:01:05Z",
          answer: { outcome: "answered", unanswered: [] },
        });
      }),
    );

    const view = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={makeQueueItem()} />);
    fireEvent.click(view.getByTestId("feed-card-option-channel-stable"));

    await waitFor(() => {
      expect(
        view.getByTestId("feed-card-answer-status-queue-attention-q-ask-1").textContent,
      ).toBe("Recorded. 1 of 2 answered. Not sent yet.");
    });
    expect(view.queryByTestId("feed-card-answer-receipt-queue-attention-q-ask-1")).toBeNull();

    // Complete the 2nd question, unmount, and remount the SAME q-ask-1 card: receipt must survive from sessionAskSnapshots
    fireEvent.click(view.getByTestId("feed-card-option-changelog-yes"));
    await waitFor(() => {
      expect(view.getByTestId("feed-card-answer-receipt-queue-attention-q-ask-1")).toBeTruthy();
    });
    cleanup();

    const remountedAsk = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={makeQueueItem()} />);
    expect(remountedAsk.getByTestId("feed-card-answer-receipt-queue-attention-q-ask-1").textContent).toContain(
      "Answered and sent to lead@demo.",
    );
    expect(remountedAsk.queryByTestId("feed-card-send-answers-queue-attention-q-ask-1")).toBeNull();
    cleanup();

    // Remounting a done ask with humanAnswers renders settled view (not live buttons or 'SEND ANSWERS')
    const doneItem = makeQueueItem({
      qitemId: "q-done-1",
      state: "done",
      closureReason: "canceled",
      closureTarget: "no-follow-on",
      closingTransition: { actorSession: "lead@demo", closureReason: "canceled", closureTarget: "no-follow-on", state: "done" },
      humanAnswers: { channel: "stable", changelog: "yes" },
    });
    const doneView = renderWithQuery(
      <FeedCard card={makeQuestionCard({ id: "queue-attention-q-done-1" }, { qitemId: "q-done-1" })} queueItem={doneItem} />,
    );
    const settled = doneView.getByTestId("feed-card-answer-settled-queue-attention-q-done-1");
    expect(settled.textContent).toContain("This request is dropped now by lead@demo.");
    expect(settled.textContent).not.toContain("no-follow-on");
    expect(doneView.queryByTestId("feed-card-send-answers-queue-attention-q-done-1")).toBeNull();
  });

  it("refreshes the queue row and offers SEND ANSWERS TO <asker> when the final option tap fails with answer_not_closed (without replyQitemId)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("/api/mission-control/action")) {
          return jsonResponse(
            {
              error: "answer_not_closed",
              message: "Returning the answer to lead@demo failed, so q-ask-1 wasn't closed.",
            },
            409,
          );
        }
        if (String(url).includes("/api/queue/q-ask-1")) {
          return jsonResponse({
            qitemId: "q-ask-1",
            state: "pending",
            decisionRevision: "rev-2",
            humanQuestions: [TWO_QUESTIONS[0]],
            humanAnswers: { channel: "stable" },
          });
        }
        return jsonResponse({});
      }),
    );

    const singleQCard = makeQuestionCard({}, { humanQuestions: [TWO_QUESTIONS[0]] });
    const view = renderWithQuery(
      <FeedCard card={singleQCard} queueItem={makeQueueItem({ humanQuestions: [TWO_QUESTIONS[0]] })} />,
    );
    fireEvent.click(view.getByTestId("feed-card-option-channel-stable"));

    await waitFor(() => {
      expect(view.getByTestId("feed-card-answer-status-queue-attention-q-ask-1").textContent).toBe(
        "All answered and recorded. Not sent yet.",
      );
      expect(view.getByTestId("feed-card-send-answers-queue-attention-q-ask-1").textContent).toBe(
        "Send answers to lead@demo",
      );
      expect(view.getByTestId("feed-card-option-channel-stable").getAttribute("data-selected")).toBe("true");
    });
  });

  it("keeps the session attention cache bounded to only answered asks within the 50-item cap", async () => {
    const makeAttItem = (id: string): AttentionQueueItem => ({
      qitemId: id,
      tsCreated: "2026-11-06T00:00:00Z",
      tsUpdated: "2026-11-06T00:00:00Z",
      sourceSession: "lead@demo",
      destinationSession: "human@host",
      state: "pending",
      priority: "normal",
      tier: null,
      tags: null,
      blockedOn: null,
      handedOffTo: null,
      handedOffFrom: null,
      body: `Item ${id}`,
    });

    let serverItems = Array.from({ length: 50 }, (_, i) => makeAttItem(`q-${i + 1}`));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(serverItems)),
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useAttentionItems(50, false), { wrapper });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(50));

    // Only retain q-1 (the ask the user answered); q-2 is merely seen and must NOT be retained
    retainAttentionItemInSession("q-1", serverItems[0]);

    // Server next returns q-3..q-52 (50 items; both q-1 and q-2 are no longer on the server list)
    serverItems = Array.from({ length: 50 }, (_, i) => makeAttItem(`q-${i + 3}`));
    await result.current.refetch();

    await waitFor(() => {
      const ids = result.current.data!.items.map((i) => i.qitemId);
      // Capped at 50 items total (not 51), while keeping the retained answered ask q-1 visible
      expect(ids).toHaveLength(50);
      expect(ids).toContain("q-1");
      expect(ids).not.toContain("q-2");
    });

    // When server has fewer than 50 items (e.g. q-3..q-10), q-1 is retained and q-2 (unanswered) is not
    serverItems = Array.from({ length: 8 }, (_, i) => makeAttItem(`q-${i + 3}`));
    await result.current.refetch();
    await waitFor(() => {
      const ids = result.current.data!.items.map((i) => i.qitemId);
      expect(ids).toContain("q-1");
      expect(ids).not.toContain("q-2");
    });
  });

  it("handles insecure context without crypto.randomUUID, plain-text 502 error, failed refetch on decision_revision_changed, and stale queueItem revision on remount", async () => {
    const origCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => origCrypto.getRandomValues(arr),
    });

    const calls: Array<Record<string, unknown>> = [];
    let mode: "plain500" | "json500" | "reconciled" | "revChangedDone" = "plain500";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes("/api/mission-control/action")) {
          calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (mode === "plain500") {
            return new Response("Gateway Timeout: upstream unavailable", { status: 502 });
          }
          if (mode === "json500") {
            return jsonResponse({ error: "internal_error", message: "SQLite busy" }, 500);
          }
          if (mode === "reconciled") {
            return jsonResponse({
              actionId: "a-rec-http",
              verb: "answer",
              qitemId: "q-ask-1",
              reconciled: true,
              decisionRevision: "rev-2",
              closedQitem: { qitemId: "q-ask-1", state: "pending", humanAnswers: { channel: "stable" } },
              createdQitemId: null,
              notifyAttempted: false,
              notifyResult: null,
              auditedAt: "2026-11-06T00:01:00Z",
            });
          }
          return jsonResponse(
            {
              error: "decision_revision_changed",
              message: "qitem q-ask-1 changed since this revision was read.",
              currentRevision: "rev-9",
              state: "done",
              humanAnswers: { channel: "beta", changelog: "no" },
            },
            409,
          );
        }
        // Simulate failed refetch on /api/queue/q-ask-1
        return new Response("Service Unavailable", { status: 503 });
      }),
    );

    const staleQueueItem = makeQueueItem({ decisionRevision: "rev-1" });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const view = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={staleQueueItem} />, qc);

    // 1. Plain-text 502 error + getRandomValues operationId
    fireEvent.click(view.getByTestId("feed-card-option-channel-stable"));
    await waitFor(() => expect(calls).toHaveLength(1));
    const firstOpId = (calls[0]!.auditNotes as Record<string, unknown>).operationId as string;
    expect(firstOpId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    await waitFor(() => {
      expect(view.getByTestId("feed-card-answer-error-message-queue-attention-q-ask-1").textContent).toBe(
        "HTTP 502: Gateway Timeout: upstream unavailable",
      );
      expect(view.getByTestId("feed-card-answer-refresh-queue-attention-q-ask-1")).toBeTruthy();
    });

    // 1b. JSON 500 error with error code is also treated as unknown outcome (with refresh button)
    mode = "json500";
    fireEvent.click(view.getByTestId("feed-card-option-channel-stable"));
    await waitFor(() => expect(calls).toHaveLength(2));
    await waitFor(() => {
      const alert = view.getByTestId("feed-card-answer-error-queue-attention-q-ask-1");
      expect(alert.textContent).toContain("Outcome unknown — couldn't confirm whether your answer went through.");
      expect(view.getByTestId("feed-card-answer-error-message-queue-attention-q-ask-1").textContent).toBe(
        "SQLite busy",
      );
      expect(view.getByTestId("feed-card-answer-refresh-queue-attention-q-ask-1")).toBeTruthy();
    });

    // 2. Retry reuses the same getRandomValues operationId and reconciles (refreshing queue + attention)
    mode = "reconciled";
    fireEvent.click(view.getByTestId("feed-card-option-channel-stable"));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect((calls[2]!.auditNotes as Record<string, unknown>).operationId).toBe(firstOpId);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["queue", "item", "q-ask-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["attention-items"] });

    // 3. Unmount and remount while staleQueueItem still carries decisionRevision="rev-1":
    //    must send updated expectedRevision="rev-2" (not stale "rev-1") and when decision_revision_changed
    //    returns state="done" with a failed 503 refetch, must stay settled instead of re-enabling controls.
    cleanup();
    mode = "revChangedDone";
    const remounted = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={staleQueueItem} />, qc);
    fireEvent.click(remounted.getByTestId("feed-card-option-changelog-no"));
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[3]!.expectedRevision).toBe("rev-2");

    await waitFor(() => {
      expect(remounted.getByTestId("feed-card-answer-settled-queue-attention-q-ask-1")).toBeTruthy();
    });
    expect(remounted.queryByTestId("feed-card-option-changelog-no")).toBeNull();
  });
});
