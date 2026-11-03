// @vitest-environment jsdom

// CORRECTIVE §7.1 + founder N-1 (2026-07-05) — For-You quick actions are
// JUST two buttons: APPROVE (one-tap, the SAME verb write path) and CHAT
// (the shared terminal, BR-12 — never a chat panel). No deny, no route, no
// "Choose response" / "Your turn" chrome anywhere on the surface.
//
// The `bare` prop is JSX-only by contract: the mutation request must be
// BYTE-IDENTICAL bare vs chromed (guard's write-path-identity cell).

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { VerbActions } from "../src/components/mission-control/components/VerbActions.js";
import { buildChatPreamble } from "../src/components/review/chat.js";
import type { QueueItemDetail } from "../src/hooks/useSlices.js";
import type { FeedCard as FeedCardModel } from "../src/lib/feed-classifier.js";

// The shared terminal is mocked to a marker so the DOM test proves the CHAT
// surface is ProgressiveTerminal (BR-12) without booting xterm in jsdom.
const terminalMounts: Array<{ sessionName: string; initialText?: string }> = [];
vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({
  ProgressiveTerminal: (props: { sessionName: string; initialText?: string }) => {
    terminalMounts.push({ sessionName: props.sessionName, initialText: props.initialText });
    return <div data-testid="shared-progressive-terminal" />;
  },
}));

import { FeedCard } from "../src/components/for-you/FeedCard.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  terminalMounts.length = 0;
});

function withQuery(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

/** Captures RAW request bodies so identity is provable at the byte level. */
function stubActionFetch() {
  const raw: Array<{ url: string; method: string; body: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/mission-control/action")) {
        raw.push({ url: String(url), method: String(init?.method ?? "GET"), body: String(init?.body ?? "") });
        return new Response(
          JSON.stringify({ actionId: "a-1", verb: "approve", qitemId: "q-1", closedQitem: null, createdQitemId: null, notifyAttempted: false, notifyResult: null, auditedAt: "t" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ destinations: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return raw;
}

function renderVerbActions(props: Parameters<typeof VerbActions>[0]) {
  return withQuery(<VerbActions {...props} />);
}

describe("VerbActions `bare` — write-path identity (JSX-only chrome skip)", () => {
  async function approveAndCapture(bare: boolean) {
    const raw = stubActionFetch();
    const view = renderVerbActions({
      qitemId: "q-identity",
      actorSession: "human@host",
      enabledVerbs: ["approve"],
      oneClickVerbs: ["approve"],
      ...(bare ? { bare: true } : {}),
    });
    fireEvent.click(view.getByTestId("mc-verb-approve"));
    await waitFor(() => expect(raw).toHaveLength(1));
    const call = raw[0]!;
    cleanup();
    vi.unstubAllGlobals();
    return call;
  }

  it("the mutation request is BYTE-IDENTICAL bare vs chromed (url + method + body)", async () => {
    const chromed = await approveAndCapture(false);
    const bare = await approveAndCapture(true);
    expect(bare.url).toBe(chromed.url);
    expect(bare.method).toBe(chromed.method);
    expect(bare.body).toBe(chromed.body); // byte-identical — `bare` touches JSX only
  });

  it("bare renders ONLY the verb button — no 'Choose response' chrome; chromed keeps it", () => {
    stubActionFetch();
    const chromed = renderVerbActions({ qitemId: "q-a", actorSession: "h@h", enabledVerbs: ["approve"], oneClickVerbs: ["approve"] });
    expect(chromed.queryByText("Choose response")).not.toBeNull();
    cleanup();
    const bare = renderVerbActions({ qitemId: "q-b", actorSession: "h@h", enabledVerbs: ["approve"], oneClickVerbs: ["approve"], bare: true });
    expect(bare.queryByText("Choose response")).toBeNull();
    expect(bare.getByTestId("mc-verb-approve")).toBeTruthy();
  });
});

describe("For-You quick actions — bare APPROVE + CHAT only (N-1, BR-12)", () => {
  function actionCard(): FeedCardModel {
    return {
      id: "queue.enqueued-7",
      kind: "action-required",
      title: "Approve the cut",
      body: "needs your call",
      receivedAt: 1234567890,
      createdAt: new Date(1234567890 * 1000).toISOString(),
      source: {
        seq: 7,
        type: "queue.enqueued",
        payload: { qitem_id: "q-chat-1", source_session: "dev-owner@rig", humanQuestions: null },
      } as unknown as FeedCardModel["source"],
    } as FeedCardModel;
  }

  it("renders exactly two actions — one-click APPROVE + one CHAT button; zero deny/route; zero chrome prose", () => {
    stubActionFetch();
    const view = withQuery(<FeedCard card={actionCard()} />);
    // APPROVE: the same VerbActions verb button, bare.
    expect(view.getByTestId("mc-verb-approve")).toBeTruthy();
    // CHAT: exactly one.
    expect(view.getByTestId("feed-card-chat-queue.enqueued-7")).toBeTruthy();
    // The retired verbs are GONE from the surface.
    expect(view.queryByTestId("mc-verb-deny")).toBeNull();
    expect(view.queryByTestId("mc-verb-route")).toBeNull();
    // Both chrome layers removed (founder N-1): the card prose AND the
    // VerbActions header. Guard fixback 2026-07-06: the CARD-LEVEL kind tag
    // is a status label (the kind's canonical name), never "Your turn".
    expect(view.queryByText("Choose response")).toBeNull();
    expect(view.queryByText("Your turn")).toBeNull();
    expect(view.getByText("Action required")).toBeTruthy();
    // rev1-r2 B1: catch BOTH phrasings of the retired-schema copy.
    expect(view.queryByText(/approve,\s*deny,?\s*(?:and|or)\s*route/i)).toBeNull();
  });

  it.each(["action-required", "approval"] as const)("%s question cards offer Chat without posting approval", async (kind) => {
    const raw = stubActionFetch();
    const card = actionCard();
    card.kind = kind;
    card.source.payload.humanQuestions = [{ id: "channel", question: "Which channel?", options: [{ id: "stable", label: "Stable" }, { id: "beta", label: "Beta" }] }];
    const view = withQuery(<FeedCard card={card} />);
    expect(view.queryByTestId("mc-verb-approve")).toBeNull();
    fireEvent.click(view.getByTestId("feed-card-chat-queue.enqueued-7"));
    await waitFor(() => expect(view.getByTestId("shared-progressive-terminal")).toBeTruthy());
    expect(raw).toHaveLength(0);
  });

  it.each([true, false])("remote questions name the origin host without suggesting Chat (terminal: %s)", (hasTerminal) => {
    stubActionFetch();
    const card = actionCard();
    card.hostId = "remote-host";
    card.source.payload.humanQuestions = [{ id: "note", question: "What should change?" }];
    if (!hasTerminal) delete card.source.payload.source_session;
    const view = withQuery(<FeedCard card={card} />);
    expect(view.getByText("This ask has questions. Answer in the TUI on host remote-host (rig tui).")).toBeTruthy();
    expect(view.queryByText(/or tell .* in Chat/)).toBeNull();
    expect(view.queryByTestId("mc-verb-approve")).toBeNull();
    expect(view.getByTestId("feed-card-chat-queue.enqueued-7").hasAttribute("disabled")).toBe(!hasTerminal);
  });

  it.each([undefined, "local"])("local questions retain TUI and Chat guidance (host: %s)", (hostId) => {
    stubActionFetch();
    const card = actionCard();
    card.hostId = hostId;
    card.source.payload.humanQuestions = [{ id: "note", question: "What should change?" }];
    const view = withQuery(<FeedCard card={card} />);
    expect(view.getByText("This ask has questions. Answer in the TUI (rig tui), or tell dev-owner@rig in Chat.")).toBeTruthy();
  });

  it.each([undefined, "remote"])("keeps Approve for runner permission questions on host %s", async (hostId) => {
    const raw = stubActionFetch();
    const card = actionCard();
    card.hostId = hostId;
    card.source.payload.humanQuestions = [{ id: "permission", question: "Allow this tool?" }];
    card.source.payload.tags = ["runner-permission"];
    const view = withQuery(<FeedCard card={card} />);
    fireEvent.click(view.getByTestId("mc-verb-approve"));
    await waitFor(() => expect(raw).toHaveLength(1));
    expect(JSON.parse(raw[0]!.body).verb).toBe("approve");
  });

  it("does not offer approval before queue details establish whether there are questions", () => {
    stubActionFetch();
    const card = actionCard();
    delete card.source.payload.humanQuestions;
    const view = withQuery(<FeedCard card={card} />);
    expect(view.queryByTestId("mc-verb-approve")).toBeNull();
    expect(view.queryByText(/unavailable/i)).toBeNull();
  });

  it.each([null, []])("keeps one-click approval for hydrated asks without questions (%j)", (humanQuestions) => {
    stubActionFetch();
    const card = actionCard();
    delete card.source.payload.humanQuestions;
    const queueItem = { qitemId: "q-chat-1", sourceSession: "dev-owner@rig", state: "pending", humanQuestions } as QueueItemDetail;
    const view = withQuery(<FeedCard card={card} queueItem={queueItem} />);
    expect(view.getByTestId("mc-verb-approve")).toBeTruthy();
  });

  it("reads questions from hydration and offers only the TUI when no Chat sender resolves", () => {
    stubActionFetch();
    const card = actionCard();
    delete card.source.payload.source_session;
    const queueItem = { qitemId: "q-chat-1", state: "pending", humanQuestions: [{ id: "note", question: "What should change?" }] } as QueueItemDetail;
    const view = withQuery(<FeedCard card={card} queueItem={queueItem} />);
    expect(view.queryByTestId("mc-verb-approve")).toBeNull();
    expect(view.getByText("This ask has questions. Answer in the TUI (rig tui).")).toBeTruthy();
    expect(view.getByTestId("feed-card-chat-queue.enqueued-7").hasAttribute("disabled")).toBe(true);
  });

  it("CHAT opens the SHARED ProgressiveTerminal seeded with the pinned preamble (BR-12: terminal, never a chat panel)", async () => {
    stubActionFetch();
    const view = withQuery(<FeedCard card={actionCard()} />);
    expect(view.queryByTestId("shared-progressive-terminal")).toBeNull();

    fireEvent.click(view.getByTestId("feed-card-chat-queue.enqueued-7"));
    await waitFor(() => expect(view.getByTestId("shared-progressive-terminal")).toBeTruthy());

    // Human-action cards chat with the SENDER (the owning agent).
    expect(terminalMounts).toHaveLength(1);
    expect(terminalMounts[0]).toEqual({
      sessionName: "dev-owner@rig",
      initialText: buildChatPreamble({ sessionName: "dev-owner@rig", itemRef: "q-chat-1" }),
    });

    // BR-12 dead-component wall: no chat panel, no compose box, no bubbles.
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.queryByPlaceholderText(/message/i)).toBeNull();
  });

  it("approving from the card fires the SAME mutation body as the chromed path (end-to-end identity)", async () => {
    const raw = stubActionFetch();
    const view = withQuery(<FeedCard card={actionCard()} />);
    fireEvent.click(view.getByTestId("mc-verb-approve"));
    await waitFor(() => expect(raw).toHaveLength(1));
    const body = JSON.parse(raw[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ verb: "approve", qitemId: "q-chat-1", actorSession: "human@host" });
    expect("hostId" in body).toBe(false); // local card — byte-parity with the local path
  });
});

// rev1-r2 B1 (2026-07-06): the retired deny/route schema leaked through the
// action-required lens's EMPTY-STATE copy — chrome the card-level DOM tests
// cannot see. Source-scan guard over the For-You surface files catches
// EITHER phrasing ("approve, deny, or route" / "approve, deny, and route")
// in copy anywhere in the file, rendered or not. (The audit-outcome verb SET
// rendering recorded historical actions is not copy and does not match.)
describe("For-You surface copy — no retired-schema leakage (rev1-r2 B1)", () => {
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const packageRoot = nodePath.resolve(here, "..");
  const RETIRED_COPY = /approve,\s*deny,?\s*(?:and|or)\s*route/i;

  for (const rel of [
    "src/components/for-you/Feed.tsx",
    "src/components/for-you/FeedCard.tsx",
  ]) {
    it(`${rel} carries no 'approve, deny, and/or route' copy`, () => {
      const source = readFileSync(nodePath.join(packageRoot, rel), "utf-8");
      expect(source).not.toMatch(RETIRED_COPY);
    });
  }

  it("the action-required empty state speaks approve + chat", () => {
    const source = readFileSync(nodePath.join(packageRoot, "src/components/for-you/Feed.tsx"), "utf-8");
    expect(source).toContain("one-tap approve and chat");
  });
});
