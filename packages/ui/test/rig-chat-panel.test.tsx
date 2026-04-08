import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";
import { RigChatPanel } from "../src/components/RigChatPanel.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

function renderPanel(rigId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RigChatPanel rigId={rigId} />
    </QueryClientProvider>
  );
}

describe("RigChatPanel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  });

  afterEach(() => {
    if (OriginalEventSource) {
      globalThis.EventSource = OriginalEventSource;
    }
    cleanup();
  });

  const chatMessages = [
    { id: "msg-1", rigId: "rig-1", sender: "alice", kind: "message", body: "hello", topic: null, createdAt: "2026-03-31T10:00:00Z" },
    { id: "msg-2", rigId: "rig-1", sender: "bob", kind: "message", body: "world", topic: null, createdAt: "2026-03-31T10:01:00Z" },
  ];

  it("renders message history with sender labels", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/chat/history")) {
        return Promise.resolve({
          ok: true,
          json: async () => chatMessages,
        });
      }
      if (typeof url === "string" && url.includes("/chat/send")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: "msg-new", rigId: "rig-1", sender: "ui", kind: "message", body: "test", topic: null, createdAt: "2026-03-31T10:02:00Z" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");

    // Wait for messages to render — sender is now on its own line
    expect(await screen.findByText("alice")).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("bob")).toBeTruthy();
    expect(screen.getByText("world")).toBeTruthy();
  });

  it("send form submits message", async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.includes("/chat/history")) {
        return Promise.resolve({
          ok: true,
          json: async () => [],
        });
      }
      if (typeof url === "string" && url.includes("/chat/send") && opts?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: "msg-new", rigId: "rig-1", sender: "ui", kind: "message", body: "hello world", topic: null, createdAt: "2026-03-31T10:00:00Z" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");

    // Wait for panel to load
    await screen.findByTestId("chat-send-form");

    const input = screen.getByTestId("chat-input");
    const sendBtn = screen.getByTestId("chat-send-btn");

    // Type and send
    fireEvent.change(input, { target: { value: "hello world" } });
    fireEvent.click(sendBtn);

    // Verify fetch was called with the message
    await waitFor(() => {
      const sendCalls = mockFetch.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("/chat/send")
      );
      expect(sendCalls.length).toBeGreaterThan(0);
    });
  });

  it("renders topic markers as visually distinct blocks", async () => {
    const messagesWithTopic = [
      { id: "msg-t1", rigId: "rig-1", sender: "host", kind: "topic", body: "", topic: "review", createdAt: "2026-03-31T10:00:00Z" },
      { id: "msg-1", rigId: "rig-1", sender: "alice", kind: "message", body: "review comment", topic: null, createdAt: "2026-03-31T10:01:00Z" },
    ];
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/chat/history")) {
        return Promise.resolve({ ok: true, json: async () => messagesWithTopic });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");

    // Topic marker should render with distinct testId
    const topicEl = await screen.findByTestId("chat-topic-msg-t1");
    expect(topicEl.textContent).toContain("review");
    // Regular message should have sender header
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("review comment")).toBeTruthy();
  });

  it("renders sender as header separated from body", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/chat/history")) {
        return Promise.resolve({ ok: true, json: async () => chatMessages });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");

    // Sender should be in its own element, not inline with body
    const senderEl = await screen.findByTestId("chat-sender-msg-1");
    expect(senderEl.textContent).toBe("alice");
    // Body should be in a separate element
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("updates when new message event arrives", async () => {
    let callCount = 0;
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/chat/history")) {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => chatMessages,
          });
        }
        // After SSE event triggers refetch, return with new message
        return Promise.resolve({
          ok: true,
          json: async () => [
            ...chatMessages,
            { id: "msg-3", rigId: "rig-1", sender: "charlie", kind: "message", body: "new message", topic: null, createdAt: "2026-03-31T10:02:00Z" },
          ],
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");

    // Wait for initial render
    await screen.findByText("alice");

    // Simulate SSE message event
    const esInstance = instances[0]!;
    esInstance.simulateMessage(JSON.stringify({ id: "msg-3", sender: "charlie", body: "new message" }));

    // Wait for refetch to include the new message
    await waitFor(() => {
      expect(screen.getByText("new message")).toBeTruthy();
    });
  });
});
