// OPR.0.3.3.20 — one-click approve (AC-2/AC-3, approve-only).
//
// A single click on Approve records verb=approve with NO select+confirm step
// and fires the existing optimistic instant receipt. route/deny stay in the
// controlled select+confirm flow (no one-click path for input-needing verbs —
// structural guard). The held-error path (no silent reset) covers the
// one-click path too. Act-driven: the mutation fires on the click; there is
// no timer anywhere in this path.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VerbActions } from "../src/components/mission-control/components/VerbActions.js";
import type { FeedActionOutcome } from "../src/components/for-you/FeedCard.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderVerbActions(props: Parameters<typeof VerbActions>[0]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <VerbActions {...props} />
    </QueryClientProvider>,
  );
}

function stubActionFetch(opts?: { failAction?: boolean }) {
  const actionCalls: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/mission-control/destinations")) {
        return new Response(JSON.stringify({ destinations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/mission-control/action")) {
        const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        actionCalls.push(input);
        if (opts?.failAction) {
          return new Response(
            JSON.stringify({ error: "act_failed", message: "approve refused by daemon" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            actionId: "act-1",
            verb: input.verb,
            qitemId: input.qitemId,
            closedQitem: null,
            createdQitemId: null,
            notifyAttempted: false,
            notifyResult: null,
            auditedAt: "2026-06-11T00:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return actionCalls;
}

describe("VerbActions — one-click approve (OPR.0.3.3.20)", () => {
  it("a single click on Approve records verb=approve with NO select+confirm step and fires the instant receipt", async () => {
    const actionCalls = stubActionFetch();
    const onOptimisticOutcome = vi.fn();
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-one-click",
      actorSession: "human@host",
      enabledVerbs: ["approve", "deny", "route"],
      oneClickVerbs: ["approve"],
      onOptimisticOutcome,
    });

    fireEvent.click(getByTestId("mc-verb-approve"));

    // No select step appeared — the confirm row never rendered.
    expect(queryByTestId("mc-verb-submit")).toBeNull();

    await waitFor(() => expect(onOptimisticOutcome).toHaveBeenCalledTimes(1));
    const outcome = onOptimisticOutcome.mock.calls[0]![0] as FeedActionOutcome;
    expect(outcome.verb).toBe("approve");
    expect(actionCalls).toHaveLength(1);
    expect(actionCalls[0]!.verb).toBe("approve");
    expect(actionCalls[0]!.qitemId).toBe("qitem-one-click");
  });

  it("route and deny keep the controlled select+confirm flow (no one-click path)", async () => {
    const actionCalls = stubActionFetch();
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-controlled",
      actorSession: "human@host",
      enabledVerbs: ["approve", "deny", "route"],
      oneClickVerbs: ["approve"],
    });

    // Clicking deny SELECTS it (confirm row appears) — nothing fired.
    fireEvent.click(getByTestId("mc-verb-deny"));
    expect(queryByTestId("mc-verb-submit")).not.toBeNull();
    expect(actionCalls).toHaveLength(0);

    // Clicking route selects it too — needs a destination, nothing fired.
    fireEvent.click(getByTestId("mc-verb-route"));
    expect(queryByTestId("mc-verb-submit")).not.toBeNull();
    expect(actionCalls).toHaveLength(0);
  });

  it("ALLOWLIST GUARD: route forced into oneClickVerbs is NOT one-clicked (runtime refusal)", async () => {
    const actionCalls = stubActionFetch();
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-guard",
      actorSession: "human@host",
      enabledVerbs: ["approve", "deny", "route"],
      // Misuse on purpose: the prop TYPE is approve-only, so misuse requires a
      // cast — and the runtime allowlist must still refuse it.
      oneClickVerbs: ["route"] as unknown as Parameters<typeof VerbActions>[0]["oneClickVerbs"],
    });

    fireEvent.click(getByTestId("mc-verb-route"));

    // Fell back to the controlled flow: selected, not fired.
    expect(queryByTestId("mc-verb-submit")).not.toBeNull();
    expect(actionCalls).toHaveLength(0);
  });

  it("ALLOWLIST GUARD: deny forced into oneClickVerbs is NOT one-clicked (input-free is not sufficient)", async () => {
    const actionCalls = stubActionFetch();
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-guard-deny",
      actorSession: "human@host",
      enabledVerbs: ["approve", "deny", "route"],
      // deny needs NO input — the approve-only ALLOWLIST (not the input rule)
      // is what must refuse it (PRD scope + section S: approve-only).
      oneClickVerbs: ["deny"] as unknown as Parameters<typeof VerbActions>[0]["oneClickVerbs"],
    });

    fireEvent.click(getByTestId("mc-verb-deny"));

    // Controlled select+confirm flow appeared; NO action call was made.
    expect(queryByTestId("mc-verb-submit")).not.toBeNull();
    expect(actionCalls).toHaveLength(0);
  });

  it("without oneClickVerbs, Approve keeps the existing select+confirm behavior", async () => {
    const actionCalls = stubActionFetch();
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-legacy",
      actorSession: "human@host",
      enabledVerbs: ["approve", "deny", "route"],
    });

    fireEvent.click(getByTestId("mc-verb-approve"));
    expect(actionCalls).toHaveLength(0);
    expect(queryByTestId("mc-verb-submit")).not.toBeNull();
  });

  it("one-click approve error is HELD inline (no silent reset) — AC-3 on the new path", async () => {
    stubActionFetch({ failAction: true });
    const onOptimisticOutcome = vi.fn();
    const { getByTestId } = renderVerbActions({
      qitemId: "qitem-one-click-fail",
      actorSession: "human@host",
      enabledVerbs: ["approve", "deny", "route"],
      oneClickVerbs: ["approve"],
      onOptimisticOutcome,
    });

    fireEvent.click(getByTestId("mc-verb-approve"));

    await waitFor(() => getByTestId("mc-verb-error"));
    expect(getByTestId("mc-verb-error").textContent).toContain("approve refused by daemon");
    expect(onOptimisticOutcome).not.toHaveBeenCalled();
    // The verb buttons are still present and usable — nothing silently reset.
    expect(getByTestId("mc-verb-approve")).not.toBeNull();
  });
});
