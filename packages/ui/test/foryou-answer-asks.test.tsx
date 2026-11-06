/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { FeedCard } from "../src/components/for-you/FeedCard.js";
import { clearQuestionAskSessionSnapshots } from "../src/components/for-you/FeedCardQuestionAsk.js";
import type { FeedCard as FeedCardModel } from "../src/lib/feed-classifier.js";
import type { QueueItemDetail } from "../src/hooks/useSlices.js";
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("For You — answering an ask's structured questions (#2407)", () => {
  it("shows who is answering, on whose ask, and from which host, plus recommended badge", () => {
    const localCard = makeQuestionCard({}, { destinationSession: "alex@external" });
    const localView = renderWithQuery(<FeedCard card={localCard} />);
    expect(
      localView.getByTestId("feed-card-answer-identity-queue-attention-q-ask-1").textContent,
    ).toBe("Answering as human@host on alex@external's ask");
    cleanup();

    const remoteCard = makeQuestionCard({ hostId: "box-west" }, { destinationSession: "alex@external" });
    const view = renderWithQuery(<FeedCard card={remoteCard} />);
    expect(
      view.getByTestId("feed-card-answer-identity-queue-attention-q-ask-1").textContent,
    ).toBe("Answering as alex@external from host box-west");

    const stableBtn = view.getByTestId("feed-card-option-channel-stable");
    expect(stableBtn.textContent).toContain("Stable · RECOMMENDED");
    expect(stableBtn.className).toContain("min-h-[44px]");
    expect(view.queryByTestId("mc-verb-approve")).toBeNull();
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
          answer: { outcome: "answered", unanswered: [] },
        });
      }),
    );

    const queueItem = {
      qitemId: "q-ask-1",
      sourceSession: "lead@demo",
      destinationSession: "human@host",
      state: "pending",
      decisionRevision: "rev-1",
      humanQuestions: TWO_QUESTIONS,
      humanAnswers: null,
    } as unknown as QueueItemDetail;

    const view = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={queueItem} />);

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

    const view = renderWithQuery(<FeedCard card={card} />);
    expect(view.getByTestId("feed-card-answer-status-queue-attention-q-ask-1").textContent).toBe(
      "All answered and recorded. Not sent yet.",
    );

    const sendBtn = view.getByTestId("feed-card-send-answers-queue-attention-q-ask-1");
    expect(sendBtn.textContent).toBe("Send answers to lead@demo");

    fireEvent.click(sendBtn);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ verb: "answer", qitemId: "q-ask-1", actorSession: "human@host" });
    expect("questionId" in calls[0]!).toBe(false);
    expect("optionId" in calls[0]!).toBe(false);
    expect("decision" in calls[0]!).toBe(false);
  });

  it("answers in your own words (decision), and preserves typed text + shows wrapped error + code on failure", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let shouldFail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        if (shouldFail) {
          return jsonResponse(
            {
              error: "answer_not_closed",
              message:
                "Returning the answer to lead@demo failed (disk full), so q-ask-1 wasn't closed. Nothing was recorded; answer again once that's fixed.",
            },
            409,
          );
        }
        return jsonResponse({
          actionId: "a-words",
          verb: "answer",
          qitemId: "q-ask-1",
          closedQitem: { qitemId: "q-ask-1", state: "done" },
          createdQitemId: "q-reply-3",
          notifyAttempted: false,
          notifyResult: null,
          auditedAt: "2026-11-06T00:03:00Z",
          answer: { outcome: "answered", unanswered: [] },
        });
      }),
    );

    const view = renderWithQuery(<FeedCard card={makeQuestionCard()} />);

    fireEvent.click(view.getByTestId("feed-card-own-words-toggle-queue-attention-q-ask-1"));
    const input = view.getByTestId("feed-card-own-words-input-queue-attention-q-ask-1") as HTMLTextAreaElement;
    const sendBtn = view.getByTestId("feed-card-own-words-send-queue-attention-q-ask-1");

    expect(sendBtn.hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "Ship beta first; stable waits for Friday." } });
    expect(sendBtn.hasAttribute("disabled")).toBe(false);

    fireEvent.click(sendBtn);
    await waitFor(() => expect(calls).toHaveLength(1));

    await waitFor(() => {
      const errAlert = view.getByTestId("feed-card-answer-error-queue-attention-q-ask-1");
      expect(errAlert.textContent).toContain("Nothing was sent. Your text is still here.");
      const errMsg = view.getByTestId("feed-card-answer-error-message-queue-attention-q-ask-1");
      expect(errMsg.textContent).toContain(
        "Returning the answer to lead@demo failed (disk full), so q-ask-1 wasn't closed.",
      );
      expect(errMsg.className).not.toContain("truncate");
      expect(view.getByTestId("feed-card-answer-error-code-queue-attention-q-ask-1").textContent).toBe(
        "answer_not_closed",
      );
    });
    expect(input.value).toBe("Ship beta first; stable waits for Friday.");

    shouldFail = false;
    fireEvent.click(sendBtn);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect((calls[1]!.auditNotes as Record<string, unknown>).operationId).toBe(
      (calls[0]!.auditNotes as Record<string, unknown>).operationId,
    );

    await waitFor(() => {
      const receipt = view.getByTestId("feed-card-answer-receipt-queue-attention-q-ask-1");
      expect(receipt.textContent).toContain("Answered and sent to lead@demo.");
      expect(receipt.textContent).toContain(
        "Which channel ships first?: Ship beta first; stable waits for Friday.",
      );
    });
  });

  it("refreshes the queue row on qitem_already_terminal and shows actual non-answered state (e.g. dropped) without offering to resend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes("/api/mission-control/action")) {
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

    const view = renderWithQuery(<FeedCard card={makeQuestionCard()} />);
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

    const queueItem = {
      qitemId: "q-ask-1",
      sourceSession: "lead@demo",
      destinationSession: "human@host",
      state: "pending",
      decisionRevision: "rev-1",
      humanQuestions: TWO_QUESTIONS,
    } as unknown as QueueItemDetail;

    const view = renderWithQuery(<FeedCard card={makeQuestionCard()} queueItem={queueItem} />);
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

  it("forwards recipient actorSession and hostId on a remote card and unwraps remote_action_failed error details", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes("/api/mission-control/action")) {
          calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return jsonResponse(
            {
              error: "remote_action_failed",
              hostId: "remote-lab",
              failureClass: "remote-error",
              remoteStatus: 409,
              detail: "answer_not_closed",
            },
            502,
          );
        }
        return jsonResponse({});
      }),
    );

    const card = makeQuestionCard(
      { hostId: "remote-lab" },
      { qitemId: "q-remote-1", sourceSession: "lead@t-remote", destinationSession: "tester@external" },
    );

    const view = renderWithQuery(<FeedCard card={card} />);
    fireEvent.click(view.getByTestId("feed-card-option-channel-stable"));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      verb: "answer",
      qitemId: "q-remote-1",
      actorSession: "tester@external",
      hostId: "remote-lab",
      questionId: "channel",
      optionId: "stable",
    });
    expect("authority" in calls[0]!).toBe(false);

    await waitFor(() => {
      expect(view.getByTestId("feed-card-answer-error-code-queue-attention-q-ask-1").textContent).toBe(
        "answer_not_closed",
      );
      expect(view.getByTestId("feed-card-answer-error-message-queue-attention-q-ask-1").textContent).toBe(
        "remote_action_failed · answer_not_closed · remote status 409",
      );
    });
  });

  it("shows 'This request is no longer waiting.' + code on a remote card when qitem_already_terminal returns", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("/api/mission-control/action")) {
          return jsonResponse(
            {
              error: "remote_action_failed",
              hostId: "remote-lab",
              failureClass: "remote-error",
              remoteStatus: 409,
              detail: "qitem_already_terminal",
            },
            502,
          );
        }
        return jsonResponse({});
      }),
    );

    const card = makeQuestionCard(
      { hostId: "remote-lab" },
      { qitemId: "q-remote-2", sourceSession: "lead@t-remote", destinationSession: "tester@external" },
    );

    const view = renderWithQuery(<FeedCard card={card} />);
    fireEvent.click(view.getByTestId("feed-card-option-channel-stable"));

    await waitFor(() => {
      const settled = view.getByTestId("feed-card-answer-settled-queue-attention-q-ask-1");
      expect(settled.textContent).toContain("This request is no longer waiting.");
      expect(settled.textContent).toContain(
        "remote_action_failed · qitem_already_terminal · remote status 409",
      );
      expect(view.getByTestId("feed-card-answer-error-code-queue-attention-q-ask-1").textContent).toBe(
        "qitem_already_terminal",
      );
    });
    expect(view.queryByTestId("feed-card-option-channel-stable")).toBeNull();
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

    const view = renderWithQuery(<FeedCard card={makeQuestionCard()} />);
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

    const remountedAsk = renderWithQuery(<FeedCard card={makeQuestionCard()} />);
    expect(remountedAsk.getByTestId("feed-card-answer-receipt-queue-attention-q-ask-1").textContent).toContain(
      "Answered and sent to lead@demo.",
    );
    expect(remountedAsk.queryByTestId("feed-card-send-answers-queue-attention-q-ask-1")).toBeNull();
    cleanup();

    // Remounting a done ask with humanAnswers renders settled view (not live buttons or 'SEND ANSWERS')
    const doneItem = {
      qitemId: "q-done-1",
      sourceSession: "lead@demo",
      destinationSession: "human@host",
      state: "done",
      closureReason: "canceled",
      closureTarget: "no-follow-on",
      closingTransition: { actorSession: "lead@demo", closureReason: "canceled", closureTarget: "no-follow-on", state: "done" },
      humanQuestions: TWO_QUESTIONS,
      humanAnswers: { channel: "stable", changelog: "yes" },
    } as unknown as QueueItemDetail;
    const doneView = renderWithQuery(
      <FeedCard card={makeQuestionCard({ id: "queue-attention-q-done-1" }, { qitemId: "q-done-1" })} queueItem={doneItem} />,
    );
    const settled = doneView.getByTestId("feed-card-answer-settled-queue-attention-q-done-1");
    expect(settled.textContent).toContain("This request is dropped now by lead@demo.");
    expect(settled.textContent).not.toContain("no-follow-on");
    expect(doneView.queryByTestId("feed-card-send-answers-queue-attention-q-done-1")).toBeNull();
  });

  it("refreshes the queue row and offers SEND ANSWERS TO <asker> when the final option tap fails with answer_not_closed", async () => {
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
    const view = renderWithQuery(<FeedCard card={singleQCard} />);
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
});
