import { describe, it, expect, vi } from "vitest";
import { CmuxAdapter } from "../src/adapters/cmux.js";
import type {
  CmuxTransport,
  CmuxTransportFactory,
  CmuxStatus,
  CmuxResult,
  CmuxWorkspace,
  CmuxSurface,
} from "../src/adapters/cmux.js";

function workingFactory(capabilities: string[] = ["workspace.list", "surface.list", "surface.focus"]): CmuxTransportFactory {
  return async () => ({
    request: async (method: string) => {
      if (method === "capabilities") {
        return { capabilities };
      }
      if (method === "workspace.current") {
        return { workspace_id: "workspace:1" };
      }
      return {};
    },
    close: () => {},
  });
}

function failingFactory(code: string): CmuxTransportFactory {
  return async () => {
    const err = new Error(`connect failed`) as Error & { code?: string };
    err.code = code;
    throw err;
  };
}

function surfaceFactory(responses: Record<string, unknown>): CmuxTransportFactory {
  return async () => ({
    request: async (method: string) => {
      if (method === "capabilities") {
        return { capabilities: Object.keys(responses) };
      }
      if (method === "workspace.current" && !("workspace.current" in responses)) {
        return { workspace_id: "workspace:1" };
      }
      if (method in responses) {
        return responses[method];
      }
      return {};
    },
    close: () => {},
  });
}

function hangingFactory(): CmuxTransportFactory {
  return () => new Promise(() => {
    // Never resolves — simulates timeout
  });
}

describe("CmuxAdapter", () => {
  it("connect with working factory: available=true, capabilities populated", async () => {
    const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
    await adapter.connect();

    const status = adapter.getStatus();
    expect(status.available).toBe(true);
    expect(status.capabilities["workspace.list"]).toBe(true);
    expect(status.capabilities["surface.list"]).toBe(true);
    expect(status.capabilities["surface.focus"]).toBe(true);
  });

  it("connect normalizes capability map payloads from system.capabilities", async () => {
    const factory: CmuxTransportFactory = async () => ({
      request: async (method: string) => {
        if (method === "capabilities") {
          return {
            "workspace.list": true,
            "surface.list": true,
            "surface.focus": true,
          };
        }
        if (method === "workspace.current") {
          return { workspace_id: "workspace:1" };
        }
        return {};
      },
      close: () => {},
    });
    const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
    await adapter.connect();

    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.getStatus().capabilities["workspace.list"]).toBe(true);
    expect(adapter.getStatus().capabilities["surface.list"]).toBe(true);
    expect(adapter.getStatus().capabilities["surface.focus"]).toBe(true);
  });

  it("connect with factory throwing ENOENT: available=false, capabilities={}", async () => {
    const adapter = new CmuxAdapter(failingFactory("ENOENT"), { timeoutMs: 1000 });
    await adapter.connect();

    const status = adapter.getStatus();
    expect(status.available).toBe(false);
    expect(status.capabilities).toEqual({});
  });

  it("connect with factory throwing ECONNREFUSED: available=false, capabilities={}", async () => {
    const adapter = new CmuxAdapter(failingFactory("ECONNREFUSED"), { timeoutMs: 1000 });
    await adapter.connect();

    const status = adapter.getStatus();
    expect(status.available).toBe(false);
    expect(status.capabilities).toEqual({});
  });

  it("connect with factory that times out: available=false, capabilities={}", async () => {
    const adapter = new CmuxAdapter(hangingFactory(), { timeoutMs: 50 });
    await adapter.connect();

    const status = adapter.getStatus();
    expect(status.available).toBe(false);
    expect(status.capabilities).toEqual({});
  });

  it("connect where factory succeeds but capabilities hang: available=false", async () => {
    // Factory connects fine, but request("capabilities") never resolves
    const closeSpy = vi.fn();
    const factory: CmuxTransportFactory = async () => ({
      request: () => new Promise(() => {
        // Never resolves
      }),
      close: closeSpy,
    });

    const adapter = new CmuxAdapter(factory, { timeoutMs: 50 });
    await adapter.connect();

    const status = adapter.getStatus();
    expect(status.available).toBe(false);
    expect(status.capabilities).toEqual({});
  });

  it("transport is closed when factory succeeds but capabilities hang", async () => {
    const closeSpy = vi.fn();
    const factory: CmuxTransportFactory = async () => ({
      request: () => new Promise(() => {
        // Never resolves — capabilities hang
      }),
      close: closeSpy,
    });

    const adapter = new CmuxAdapter(factory, { timeoutMs: 50 });
    await adapter.connect();

    // Transport was opened by factory, but capabilities timed out.
    // The adapter must close the transient transport to avoid leak.
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("transport is closed when factory succeeds but capabilities throw", async () => {
    const closeSpy = vi.fn();
    const factory: CmuxTransportFactory = async () => ({
      request: async () => {
        throw new Error("capabilities request failed");
      },
      close: closeSpy,
    });

    const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
    await adapter.connect();

    expect(adapter.isAvailable()).toBe(false);
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("connect reports unavailable when workspace.current fails after capabilities succeed", async () => {
    const closeSpy = vi.fn();
    const factory: CmuxTransportFactory = async () => ({
      request: async (method: string) => {
        if (method === "capabilities") {
          return { capabilities: ["workspace.current"] };
        }
        if (method === "workspace.current") {
          throw new Error("Broken pipe, errno 32");
        }
        return {};
      },
      close: closeSpy,
    });

    const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
    await adapter.connect();

    expect(adapter.isAvailable()).toBe(false);
    expect(adapter.getStatus()).toEqual({ available: false, capabilities: {} });
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("getStatus returns typed CmuxStatus", async () => {
    const adapter = new CmuxAdapter(workingFactory(["workspace.list"]), { timeoutMs: 1000 });
    await adapter.connect();

    const status: CmuxStatus = adapter.getStatus();
    expect(status).toHaveProperty("available");
    expect(status).toHaveProperty("capabilities");
    expect(typeof status.available).toBe("boolean");
    expect(typeof status.capabilities).toBe("object");
  });

  it("isAvailable returns false when not connected", () => {
    const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
    // No connect() called
    expect(adapter.isAvailable()).toBe(false);
  });

  it("capability detection: transport returns feature list, maps to capability record", async () => {
    const features = ["workspace.list", "workspace.create", "surface.focus", "sidebar.metadata"];
    const adapter = new CmuxAdapter(workingFactory(features), { timeoutMs: 1000 });
    await adapter.connect();

    const status = adapter.getStatus();
    expect(status.available).toBe(true);
    for (const f of features) {
      expect(status.capabilities[f]).toBe(true);
    }
    // A capability not in the list should be undefined/falsy
    expect(status.capabilities["nonexistent.capability"]).toBeFalsy();
  });

  it("reconnect after failure: second connect() with working factory succeeds", async () => {
    let callCount = 0;
    const factory: CmuxTransportFactory = async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("connect failed") as Error & { code?: string };
        err.code = "ECONNREFUSED";
        throw err;
      }
      return {
        request: async (method: string) => {
          if (method === "capabilities") {
            return { capabilities: ["workspace.list"] };
          }
          return {};
        },
        close: () => {},
      };
    };

    const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });

    // First connect fails
    await adapter.connect();
    expect(adapter.isAvailable()).toBe(false);

    // Second connect succeeds (factory called again — real reconnect)
    await adapter.connect();
    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.getStatus().capabilities["workspace.list"]).toBe(true);
    expect(callCount).toBe(2);
  });

  // -- Surface operations (T14) --

  describe("listWorkspaces", () => {
    it("returns typed workspace list from transport", async () => {
      const factory = surfaceFactory({
        "workspace.list": { workspaces: [{ id: "ws-1", name: "review" }, { id: "ws-2", name: "dev" }] },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result: CmuxResult<CmuxWorkspace[]> = await adapter.listWorkspaces();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0]!.id).toBe("ws-1");
        expect(result.data[0]!.name).toBe("review");
        expect(result.data[1]!.id).toBe("ws-2");
      }
    });

    it("returns { ok: false, code: 'unavailable' } when not connected", async () => {
      const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
      // No connect()
      const result = await adapter.listWorkspaces();
      expect(result).toEqual({ ok: false, code: "unavailable", message: "cmux is not connected" });
    });
  });

  describe("listSurfaces", () => {
    it("returns typed surface list from transport", async () => {
      const factory = surfaceFactory({
        "surface.list": { surfaces: [{ id: "s-1", title: "orchestrator", type: "terminal" }] },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result: CmuxResult<CmuxSurface[]> = await adapter.listSurfaces();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]!.id).toBe("s-1");
        expect(result.data[0]!.title).toBe("orchestrator");
      }
    });

    it("with workspaceId forwards filter param to transport", async () => {
      const requestSpy = vi.fn().mockImplementation(async (method: string) => {
        if (method === "capabilities") return { capabilities: ["surface.list"] };
        if (method === "surface.list") return { surfaces: [] };
        return {};
      });
      const factory: CmuxTransportFactory = async () => ({
        request: requestSpy,
        close: () => {},
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      await adapter.listSurfaces("ws-1");

      // Find the surface.list call (not the capabilities call)
      const surfaceCall = requestSpy.mock.calls.find((c: unknown[]) => c[0] === "surface.list");
      expect(surfaceCall).toBeDefined();
      expect(surfaceCall![1]).toEqual({ workspaceId: "ws-1" });
    });

    it("returns { ok: false, code: 'unavailable' } when not connected", async () => {
      const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
      const result = await adapter.listSurfaces();
      expect(result).toEqual({ ok: false, code: "unavailable", message: "cmux is not connected" });
    });
  });

  describe("focusSurface", () => {
    it("calls transport with correct method and params", async () => {
      const requestSpy = vi.fn().mockImplementation(async (method: string) => {
        if (method === "capabilities") return { capabilities: ["surface.focus"] };
        return {};
      });
      const factory: CmuxTransportFactory = async () => ({
        request: requestSpy,
        close: () => {},
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      await adapter.focusSurface("s-1");

      const focusCall = requestSpy.mock.calls.find((c: unknown[]) => c[0] === "surface.focus");
      expect(focusCall).toBeDefined();
      expect(focusCall![1]).toEqual({ surfaceId: "s-1" });
    });

    it("returns { ok: true, data: undefined } on success", async () => {
      const factory = surfaceFactory({ "surface.focus": {} });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result: CmuxResult<void> = await adapter.focusSurface("s-1");
      expect(result).toEqual({ ok: true, data: undefined });
    });

    it("returns { ok: false, code: 'unavailable' } when not connected", async () => {
      const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
      const result = await adapter.focusSurface("s-1");
      expect(result).toEqual({ ok: false, code: "unavailable", message: "cmux is not connected" });
    });
  });

  describe("sendText (cmux)", () => {
    it("calls transport with correct method and params", async () => {
      const requestSpy = vi.fn().mockImplementation(async (method: string) => {
        if (method === "capabilities") return { capabilities: ["surface.sendText"] };
        return {};
      });
      const factory: CmuxTransportFactory = async () => ({
        request: requestSpy,
        close: () => {},
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      await adapter.sendText("s-1", "hello world");

      const sendCall = requestSpy.mock.calls.find((c: unknown[]) => c[0] === "surface.sendText");
      expect(sendCall).toBeDefined();
      expect(sendCall![1]).toEqual({ surfaceId: "s-1", text: "hello world" });
    });

    it("returns { ok: true, data: undefined } on success", async () => {
      const factory = surfaceFactory({ "surface.sendText": {} });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result: CmuxResult<void> = await adapter.sendText("s-1", "test");
      expect(result).toEqual({ ok: true, data: undefined });
    });

    it("returns { ok: false, code: 'unavailable' } when not connected", async () => {
      const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
      const result = await adapter.sendText("s-1", "test");
      expect(result).toEqual({ ok: false, code: "unavailable", message: "cmux is not connected" });
    });
  });

  describe("currentWorkspace", () => {
    it("normalizes real cmux workspace_id payload into a handle string", async () => {
      // Real cmux CLI output: { "workspace_id": "workspace:1" }
      const factory = surfaceFactory({
        "workspace.current": { workspace_id: "workspace:1" },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.currentWorkspace();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe("workspace:1");
      }
    });

    it("returns { ok: false, code: 'unavailable' } when not connected", async () => {
      const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
      const result = await adapter.currentWorkspace();
      expect(result).toEqual({ ok: false, code: "unavailable", message: "cmux is not connected" });
    });
  });

  describe("createTerminalSurface", () => {
    it("normalizes real cmux created_surface_id payload into a handle string", async () => {
      // Real cmux CLI output contains created_surface_id / surface_id
      const requestSpy = vi.fn().mockImplementation(async (method: string) => {
        if (method === "capabilities") return { capabilities: ["surface.create"] };
        if (method === "surface.create") return { created_surface_id: "surface:9", workspace_id: "workspace:2", pane_id: "pane:3" };
        return {};
      });
      const factory: CmuxTransportFactory = async () => ({
        request: requestSpy,
        close: () => {},
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.createTerminalSurface("workspace:2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe("surface:9");
      }

      const createCall = requestSpy.mock.calls.find((c: unknown[]) => c[0] === "surface.create");
      expect(createCall).toBeDefined();
      expect(createCall![1]).toEqual({ workspaceId: "workspace:2", type: "terminal" });
    });

    it("prefers created_surface_ref over created_surface_id (refs idFormat default)", async () => {
      const factory = surfaceFactory({
        "surface.create": { created_surface_ref: "surface:9", created_surface_id: "abc-uuid-123" },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.createTerminalSurface("workspace:1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe("surface:9");
      }
    });

    it("extracts the surface ref from legacy summary strings", async () => {
      const factory = surfaceFactory({
        "surface.create": { created_surface_ref: "OK surface:78 pane:2 workspace:1" },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.createTerminalSurface("workspace:1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe("surface:78");
      }
    });

    it("falls back to surface_ref when created_surface_ref is missing", async () => {
      const factory = surfaceFactory({
        "surface.create": { surface_ref: "surface:5" },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.createTerminalSurface("workspace:1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe("surface:5");
      }
    });

    it("falls back through id chain: created_surface_id -> surface_id", async () => {
      const factory = surfaceFactory({
        "surface.create": { surface_id: "surface:3" },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.createTerminalSurface("workspace:1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe("surface:3");
      }
    });

    it("returns { ok: false, code: 'unavailable' } when not connected", async () => {
      const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
      const result = await adapter.createTerminalSurface("workspace:1");
      expect(result).toEqual({ ok: false, code: "unavailable", message: "cmux is not connected" });
    });
  });

  describe("transport request failure", () => {
    it("returns { ok: false, code: 'request_failed' }", async () => {
      const requestSpy = vi.fn().mockImplementation(async (method: string) => {
        if (method === "capabilities") return { capabilities: ["workspace.list"] };
        if (method === "workspace.current") return { workspace_id: "workspace:1" };
        throw new Error("socket closed unexpectedly");
      });
      const factory: CmuxTransportFactory = async () => ({
        request: requestSpy,
        close: () => {},
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.listWorkspaces();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("request_failed");
        expect(result.message).toContain("socket closed unexpectedly");
      }
    });
  });
});
