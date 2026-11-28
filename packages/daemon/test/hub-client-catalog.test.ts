import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectMcpHub } from "../src/domain/network/hub-client.js";

const fixture = vi.hoisted(() => ({
  listTools: vi.fn(),
  changed: (() => {}) as () => void,
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    constructor(_identity: unknown, options: { listChanged: { tools: { onChanged: () => void } } }) {
      fixture.changed = options.listChanged.tools.onChanged;
    }
    connect = async () => {};
    close = async () => {};
    listTools = fixture.listTools;
  },
}));

beforeEach(() => fixture.listTools.mockReset());
afterEach(() => vi.restoreAllMocks());
const tool = (requester = false) => ({
  name: "rig_queue_create", inputSchema: { type: "object", properties: requester ? { requesterOf: { type: "string" } } : {} },
});

it("CR a positive first-page advertisement does not depend on a later page", async () => {
  fixture.listTools.mockResolvedValueOnce({ tools: [tool(true)], nextCursor: "second" }).mockRejectedValueOnce(new Error("second page unavailable"));
  const hub = await connectMcpHub("https://hub.example/mcp", "fixture");
  try {
    await expect(hub.offers("rig_queue_create", "requesterOf")).resolves.toBe(true);
    expect(fixture.listTools).toHaveBeenCalledTimes(1);
    await expect(hub.offers("missing_tool")).rejects.toMatchObject({ kind: "unavailable" });
  } finally { await hub.end(); }
});

it("CR list-changed invalidates an advertisement still being read", async () => {
  let finish!: (page: { tools: ReturnType<typeof tool>[] }) => void;
  fixture.listTools.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const hub = await connectMcpHub("https://hub.example/mcp", "fixture");
  try {
    const pending = hub.offers("rig_queue_create", "requesterOf");
    fixture.changed();
    finish({ tools: [tool(true)] });
    await expect(pending).resolves.toBe(false);
    fixture.listTools.mockResolvedValueOnce({ tools: [tool(false)] });
    await expect(hub.offers("rig_queue_create", "requesterOf")).resolves.toBe(false);
    await expect(hub.offers("rig_queue_create")).resolves.toBe(true);
    expect(fixture.listTools).toHaveBeenCalledTimes(2);
  } finally { await hub.end(); }
});

it("CR a complete catalog is required to conclude a tool is absent", async () => {
  fixture.listTools.mockResolvedValueOnce({ tools: [tool(false)], nextCursor: "second" }).mockResolvedValueOnce({ tools: [{ name: "later", inputSchema: { type: "object" } }] });
  const hub = await connectMcpHub("https://hub.example/mcp", "fixture");
  try {
    await expect(hub.offers("later")).resolves.toBe(true);
    await expect(hub.offers("missing_tool")).resolves.toBe(false);
    expect(fixture.listTools).toHaveBeenCalledTimes(2);
    expect(fixture.listTools).toHaveBeenLastCalledWith({ cursor: "second" });
  } finally { await hub.end(); }
});
