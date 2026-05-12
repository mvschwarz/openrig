// Slice 24 Checkpoint A — failing tests for CmuxAdapter RPC method
// extensions that power the layout flow (splitSurface, createWorkspace,
// closeWorkspace, listPaneSurfaces). Spike confirmed cmux RPC exposes
// these primitives; tests pin the adapter's contract before
// implementation lands.

import { describe, it, expect, vi } from "vitest";
import { CmuxAdapter } from "../src/adapters/cmux.js";
import type { CmuxTransport, CmuxTransportFactory } from "../src/adapters/cmux.js";

function adapterWithTransport(transport: CmuxTransport): CmuxAdapter {
  const factory: CmuxTransportFactory = async () => transport;
  return new CmuxAdapter(factory, { timeoutMs: 1000 });
}

async function connectAdapter(responses: Record<string, unknown>): Promise<CmuxAdapter> {
  const adapter = adapterWithTransport({
    request: async (method: string) => {
      if (method === "capabilities") return { capabilities: Object.keys(responses) };
      if (method === "workspace.current") return responses["workspace.current"] ?? { workspace_id: "workspace:1" };
      if (method in responses) return responses[method];
      return {};
    },
    close: () => {},
  });
  await adapter.connect();
  return adapter;
}

describe("CmuxAdapter — layout method extensions (slice 24 Checkpoint A)", () => {
  describe("splitSurface", () => {
    it("returns new surface handle on success", async () => {
      const adapter = await connectAdapter({
        "surface.split": { created_surface_ref: "surface:42" },
      });
      const result = await adapter.splitSurface("surface:10", "right", "workspace:1");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe("surface:42");
    });

    it("passes snake_case params to RPC (surface_id, direction, workspace_id)", async () => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const adapter = adapterWithTransport({
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capabilities") return { capabilities: ["surface.split"] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "surface.split") return { created_surface_ref: "surface:99" };
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      await adapter.splitSurface("surface:10", "right", "workspace:1");
      const splitCall = calls.find((c) => c.method === "surface.split");
      expect(splitCall).toBeTruthy();
      const params = splitCall!.params as Record<string, unknown>;
      expect(params["surface_id"]).toBe("surface:10");
      expect(params["direction"]).toBe("right");
      expect(params["workspace_id"]).toBe("workspace:1");
    });

    it("returns unavailable error when transport not connected", async () => {
      const adapter = new CmuxAdapter(
        async () => { throw new Error("nope"); },
        { timeoutMs: 100 },
      );
      const result = await adapter.splitSurface("surface:10", "right");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("unavailable");
    });

    it("returns request_failed when RPC throws", async () => {
      const adapter = adapterWithTransport({
        request: async (method: string) => {
          if (method === "capabilities") return { capabilities: ["surface.split"] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "surface.split") throw new Error("invalid direction");
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      const result = await adapter.splitSurface("surface:10", "bogus" as "right");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("request_failed");
        expect(result.message).toContain("invalid direction");
      }
    });

    it("returns request_failed when RPC returns no surface handle", async () => {
      const adapter = await connectAdapter({ "surface.split": {} });
      const result = await adapter.splitSurface("surface:10", "right");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("request_failed");
    });
  });

  describe("createWorkspace", () => {
    it("returns new workspace handle on success", async () => {
      const adapter = await connectAdapter({
        "workspace.create": { workspace_ref: "workspace:6" },
      });
      const result = await adapter.createWorkspace("my-rig");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe("workspace:6");
    });

    it("passes visible workspace title + optional cwd as snake_case params", async () => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const adapter = adapterWithTransport({
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capabilities") return { capabilities: ["workspace.create"] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.create") return { workspace_ref: "workspace:99" };
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      await adapter.createWorkspace("my-rig", "/path/to/cwd");
      const createCall = calls.find((c) => c.method === "workspace.create");
      const params = createCall!.params as Record<string, unknown>;
      expect(params["title"]).toBe("my-rig");
      expect("name" in params).toBe(false);
      expect(params["cwd"]).toBe("/path/to/cwd");
    });

    it("omits cwd param when not provided", async () => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const adapter = adapterWithTransport({
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capabilities") return { capabilities: ["workspace.create"] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.create") return { workspace_ref: "workspace:99" };
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      await adapter.createWorkspace("my-rig");
      const createCall = calls.find((c) => c.method === "workspace.create");
      const params = createCall!.params as Record<string, unknown>;
      expect(params["title"]).toBe("my-rig");
      expect("name" in params).toBe(false);
      expect("cwd" in params).toBe(false);
    });

    it("returns request_failed when transport throws", async () => {
      const adapter = adapterWithTransport({
        request: async (method: string) => {
          if (method === "capabilities") return { capabilities: [] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.create") throw new Error("duplicate name");
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      const result = await adapter.createWorkspace("conflict");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("request_failed");
        expect(result.message).toContain("duplicate name");
      }
    });
  });

  describe("closeWorkspace", () => {
    it("returns ok on successful workspace.close", async () => {
      const adapter = await connectAdapter({ "workspace.close": { workspace_id: "..." } });
      const result = await adapter.closeWorkspace("workspace:6");
      expect(result.ok).toBe(true);
    });

    it("passes workspace_id as snake_case param", async () => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const adapter = adapterWithTransport({
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capabilities") return { capabilities: [] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.close") return {};
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      await adapter.closeWorkspace("workspace:6");
      const closeCall = calls.find((c) => c.method === "workspace.close");
      const params = closeCall!.params as Record<string, unknown>;
      expect(params["workspace_id"]).toBe("workspace:6");
    });

    it("returns request_failed when transport throws", async () => {
      const adapter = adapterWithTransport({
        request: async (method: string) => {
          if (method === "capabilities") return { capabilities: [] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.close") throw new Error("not found");
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      const result = await adapter.closeWorkspace("workspace:99");
      expect(result.ok).toBe(false);
    });
  });

  describe("listPaneSurfaces", () => {
    it("returns surfaces array from pane.surfaces", async () => {
      const adapter = await connectAdapter({
        "pane.surfaces": {
          surfaces: [
            { id: "surface:1", title: "tab1", type: "terminal" },
            { id: "surface:2", title: "tab2", type: "terminal" },
          ],
        },
      });
      const result = await adapter.listPaneSurfaces("pane:3");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0]!.id).toBe("surface:1");
      }
    });

    it("returns empty array when surfaces field missing", async () => {
      const adapter = await connectAdapter({ "pane.surfaces": {} });
      const result = await adapter.listPaneSurfaces("pane:3");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toHaveLength(0);
    });

    it("passes pane_id + optional workspace_id as snake_case", async () => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const adapter = adapterWithTransport({
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capabilities") return { capabilities: [] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "pane.surfaces") return { surfaces: [] };
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      await adapter.listPaneSurfaces("pane:3", "workspace:1");
      const call = calls.find((c) => c.method === "pane.surfaces");
      const params = call!.params as Record<string, unknown>;
      expect(params["pane_id"]).toBe("pane:3");
      expect(params["workspace_id"]).toBe("workspace:1");
    });
  });
});
