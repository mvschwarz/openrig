import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JsonRpcRequestError, JsonRpcTransportClosed, StdioJsonRpcPeer } from "../src/acp/json-rpc-stdio.js";

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill("SIGKILL"); });

function agent(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [FAKE_AGENT], { stdio: "pipe", env: { ...process.env, ...env } });
  children.push(child);
  const packets: Array<{ direction: string; packet: unknown }> = [];
  const peer = new StdioJsonRpcPeer(child, (direction, packet) => packets.push({ direction, packet }));
  return { peer, packets };
}

async function session(peer: StdioJsonRpcPeer): Promise<string> {
  await peer.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  return ((await peer.request("session/new", { cwd: "/tmp", mcpServers: [] })) as { sessionId: string }).sessionId;
}

const text = (sessionId: string, body: string) => ({ sessionId, prompt: [{ type: "text", text: body }] });

describe("ACP JSON-RPC over stdio", () => {
  it("a prompt's progress arrives before its stop reason, in order", async () => {
    const { peer } = agent();
    const sessionId = await session(peer);
    const updates: string[] = [];
    peer.onNotification("session/update", (params) => {
      const update = (params as { update: { sessionUpdate: string; content?: { text: string } } }).update;
      updates.push(update.content?.text ?? update.sessionUpdate);
    });
    expect(await peer.request("session/prompt", text(sessionId, "scenario:reply PONG"))).toEqual({ stopReason: "end_turn" });
    expect(updates).toEqual(["working… ", "PONG", "usage_update"]);
  });

  it("an agent's error keeps its original code, message and data", async () => {
    const { peer } = agent();
    const sessionId = await session(peer);
    const failure = await peer.request("session/prompt", text(sessionId, "scenario:error")).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JsonRpcRequestError);
    expect((failure as JsonRpcRequestError).error).toEqual({ code: -32603, message: "Internal error", data: { details: "context length exceeded" } });
  });

  it("the agent's permission request gets the client's answer on that same request", async () => {
    const { peer, packets } = agent();
    const sessionId = await session(peer);
    const asked: unknown[] = [];
    peer.onRequest("session/request_permission", async (params) => {
      asked.push(params);
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });
    const said: string[] = [];
    peer.onNotification("session/update", (params) => {
      const content = (params as { update: { content?: { text?: string } } }).update.content;
      if (content?.text) said.push(content.text);
    });
    expect(await peer.request("session/prompt", text(sessionId, "scenario:permission"))).toEqual({ stopReason: "end_turn" });
    expect(asked).toHaveLength(1);
    expect(said).toEqual(["permission allow-once"]);
    const request = packets.find((p) => p.direction === "in" && (p.packet as { method?: string }).method === "session/request_permission")!.packet as { id: number };
    const answer = packets.find((p) => p.direction === "out" && (p.packet as { id?: number; result?: unknown }).id === request.id && "result" in (p.packet as object));
    expect(answer).toBeDefined();
  });

  it("a request the client doesn't handle is answered method-not-found, not left hanging", async () => {
    const { peer } = agent();
    const sessionId = await session(peer);
    const said: string[] = [];
    peer.onNotification("session/update", (params) => {
      const content = (params as { update: { content?: { text?: string } } }).update.content;
      if (content?.text) said.push(content.text);
    });
    await peer.request("session/prompt", text(sessionId, "scenario:permission"));
    expect(said).toEqual(["permission answer unreadable"]);
  });

  it("a request in flight when the agent exits rejects as transport-closed (its effect is unknown)", async () => {
    const { peer } = agent();
    const sessionId = await session(peer);
    const inFlight = peer.request("session/prompt", text(sessionId, "scenario:slow"));
    children[0]!.kill("SIGTERM");
    await expect(inFlight).rejects.toBeInstanceOf(JsonRpcTransportClosed);
    await expect(peer.request("session/new", { cwd: "/tmp", mcpServers: [] })).rejects.toBeInstanceOf(JsonRpcTransportClosed);
  });

  it("closing stdin detaches and reports the agent's exit", async () => {
    const { peer } = agent();
    await session(peer);
    expect(await peer.end(5000)).toEqual({ code: 0, signal: null });
  });
});
