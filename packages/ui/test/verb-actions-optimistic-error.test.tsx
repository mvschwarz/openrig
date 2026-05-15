// 0.3.1 demo-bug fix verification: VerbActions optimistic outcome +
// inline error surface.
//
// Founder VM walk regression: clicking Route on a queue-item card
// silently reverted — no confirmation if success, no error if failure.
// The fix splits onSuccess/onError; onSuccess fires onOptimisticOutcome
// (parent renders ActionOutcomePanel instantly) and onError shows an
// inline error block while preserving the selected verb.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

describe("VerbActions — optimistic outcome (demo-bug fix #1)", () => {
  beforeEach(() => {
    // Stub /api/mission-control/destinations + the action endpoint.
    // Approve doesn't need destinations, so the destination fetch is
    // only exercised by the Route test below.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/api/mission-control/destinations")) {
          return new Response(
            JSON.stringify({ destinations: [{ sessionName: "orch-lead@rig", label: "orch-lead" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/api/mission-control/action")) {
          const input = JSON.parse(String(init?.body ?? "{}"));
          return new Response(
            JSON.stringify({
              actionId: "act-1",
              verb: input.verb,
              qitemId: input.qitemId,
              closedQitem: null,
              createdQitemId: null,
              notifyAttempted: false,
              notifyResult: null,
              auditedAt: "2026-05-15T04:35:00.000Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  it("fires onOptimisticOutcome on Approve success with the correct shape", async () => {
    const onOptimisticOutcome = vi.fn();
    const { getByTestId } = renderVerbActions({
      qitemId: "qitem-abc",
      actorSession: "human@host",
      onOptimisticOutcome,
    });

    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));

    await waitFor(() => expect(onOptimisticOutcome).toHaveBeenCalledTimes(1));
    const outcome = onOptimisticOutcome.mock.calls[0]![0] as FeedActionOutcome;
    expect(outcome.verb).toBe("approve");
    expect(outcome.actorSession).toBe("human@host");
    expect(outcome.destinationSession).toBeNull();
    expect(outcome.reason).toBeNull();
    expect(typeof outcome.actedAt).toBe("string");
    expect(outcome.actedAt.length).toBeGreaterThan(0);
  });

  it("fires onOptimisticOutcome on Route success with destinationSession populated", async () => {
    const onOptimisticOutcome = vi.fn();
    // Override the destinations fetch to return an empty list so the
    // component falls into manual-entry mode (much simpler to drive in
    // jsdom than a controlled <select>).
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
          const input = JSON.parse(String(init?.body ?? "{}"));
          return new Response(
            JSON.stringify({
              actionId: "act-2",
              verb: input.verb,
              qitemId: input.qitemId,
              closedQitem: null,
              createdQitemId: null,
              notifyAttempted: false,
              notifyResult: null,
              auditedAt: "2026-05-15T04:35:00.000Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const { getByTestId } = renderVerbActions({
      qitemId: "qitem-xyz",
      actorSession: "human@host",
      onOptimisticOutcome,
    });

    fireEvent.click(getByTestId("mc-verb-route"));
    const input = (await waitFor(() => getByTestId("mc-verb-destination-input"))) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "orch-lead@rig" } });
    fireEvent.click(getByTestId("mc-verb-submit"));

    await waitFor(() => expect(onOptimisticOutcome).toHaveBeenCalledTimes(1));
    const outcome = onOptimisticOutcome.mock.calls[0]![0] as FeedActionOutcome;
    expect(outcome.verb).toBe("route");
    expect(outcome.destinationSession).toBe("orch-lead@rig");
  });

  it("resets selection after a successful mutation", async () => {
    const onOptimisticOutcome = vi.fn();
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-q1",
      actorSession: "human@host",
      onOptimisticOutcome,
    });
    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));
    await waitFor(() => expect(onOptimisticOutcome).toHaveBeenCalled());
    // After success, the verb-detail panel (Cancel/Confirm row) is gone.
    expect(queryByTestId("mc-verb-submit")).toBeNull();
    expect(queryByTestId("mc-verb-error")).toBeNull();
  });
});

describe("VerbActions — inline error surface (demo-bug fix #2)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/mission-control/destinations")) {
          return new Response(
            JSON.stringify({ destinations: [{ sessionName: "ghost@nowhere", label: "ghost" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/api/mission-control/action")) {
          return new Response(
            JSON.stringify({ error: "destination_unreachable", message: "ghost@nowhere is not bound" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  it("renders mc-verb-error with the server error message on failure", async () => {
    const onOptimisticOutcome = vi.fn();
    const { getByTestId } = renderVerbActions({
      qitemId: "qitem-fail",
      actorSession: "human@host",
      onOptimisticOutcome,
    });

    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));

    await waitFor(() => getByTestId("mc-verb-error"));
    const err = getByTestId("mc-verb-error");
    expect(err.textContent).toContain("ghost@nowhere is not bound");
    expect(err.getAttribute("role")).toBe("alert");
    expect(onOptimisticOutcome).not.toHaveBeenCalled();
  });

  it("does NOT reset the verb selection on error (silent-revert regression guard)", async () => {
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-fail-2",
      actorSession: "human@host",
    });

    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));

    await waitFor(() => getByTestId("mc-verb-error"));
    // Confirm/Cancel row is still present — the selection survived.
    expect(queryByTestId("mc-verb-submit")).not.toBeNull();
    expect(queryByTestId("mc-verb-cancel")).not.toBeNull();
  });

  it("clears the error message when the operator picks a different verb", async () => {
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-fail-3",
      actorSession: "human@host",
    });
    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));
    await waitFor(() => getByTestId("mc-verb-error"));
    fireEvent.click(getByTestId("mc-verb-deny"));
    expect(queryByTestId("mc-verb-error")).toBeNull();
  });

  it("clears the error message when Cancel is clicked", async () => {
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-fail-4",
      actorSession: "human@host",
    });
    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));
    await waitFor(() => getByTestId("mc-verb-error"));
    fireEvent.click(getByTestId("mc-verb-cancel"));
    expect(queryByTestId("mc-verb-error")).toBeNull();
  });
});
