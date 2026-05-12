// Slice 24 Checkpoint A repair — transport-level tests for the four
// layout RPC methods (surface.split / workspace.create / workspace.close
// / pane.surfaces). velocity-guard 24.A BLOCKING-CONCERN at 8f13174:
// adapter methods were unreachable through the concrete CLI transport
// because buildCommand had no mapping. Repair routes these four methods
// through `cmux rpc <method> '<json-params>'` — a generic CLI subcommand
// that cmux exposes for direct RPC pass-through (verified via slice 24
// pre-scaffold spike). Tests pin the exact command shape + JSON
// serialization + snake_case param preservation.

import { describe, it, expect, vi } from "vitest";
import { createCmuxCliTransport } from "../src/adapters/cmux-transport.js";
import type { ExecFn } from "../src/adapters/tmux.js";

function helpText(): string {
  return [
    "cmux - control cmux via Unix socket",
    "",
    "Commands:",
    "  version",
    "  capabilities",
    "  list-workspaces",
    "  current-workspace",
    "  rpc <method> [json-params]",
    "",
  ].join("\n");
}

function mockExec(captured: Array<string>, responses: Record<string, string> = {}): ExecFn {
  const impl = async (cmd: string): Promise<string> => {
    captured.push(cmd);
    if (cmd === "cmux --help") return helpText();
    if (cmd === "cmux capabilities --json") return '{"capabilities":[]}';
    if (cmd in responses) return responses[cmd]!;
    return "{}";
  };
  return vi.fn(impl) as unknown as ExecFn;
}

describe("cmux CLI transport — layout RPC method pass-through (slice 24.A repair)", () => {
  describe("surface.split", () => {
    it("emits `cmux rpc surface.split` with snake_case JSON params", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await transport.request("surface.split", {
        surface_id: "surface:10",
        direction: "right",
        workspace_id: "workspace:1",
      });

      const splitCmd = captured.find((c) => c.startsWith("cmux rpc surface.split"));
      expect(splitCmd).toBeTruthy();
      expect(splitCmd).toContain("surface.split");
      // Params are JSON-encoded and shell-quoted.
      expect(splitCmd).toMatch(/surface_id/);
      expect(splitCmd).toMatch(/"surface:10"/);
      expect(splitCmd).toMatch(/direction/);
      expect(splitCmd).toMatch(/"right"/);
      expect(splitCmd).toMatch(/workspace_id/);
    });

    it("parses JSON response from cmux rpc output", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      // Override the rpc response for surface.split
      const customExec = vi.fn(async (cmd: string) => {
        captured.push(cmd);
        if (cmd === "cmux --help") return helpText();
        if (cmd === "cmux capabilities --json") return '{"capabilities":[]}';
        if (cmd.startsWith("cmux rpc surface.split")) {
          return '{"created_surface_ref":"surface:42","workspace_ref":"workspace:1"}';
        }
        return "{}";
      }) as unknown as ExecFn;
      const factory = createCmuxCliTransport(customExec);
      const transport = await factory();

      const result = (await transport.request("surface.split", {
        surface_id: "surface:10",
        direction: "right",
      })) as Record<string, unknown>;

      expect(result["created_surface_ref"]).toBe("surface:42");
    });
  });

  describe("workspace.create", () => {
    it("emits `cmux rpc workspace.create` with visible title + optional cwd as snake_case JSON", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await transport.request("workspace.create", {
        title: "my-rig",
        cwd: "/path/to/cwd",
      });

      const cmd = captured.find((c) => c.startsWith("cmux rpc workspace.create"));
      expect(cmd).toBeTruthy();
      expect(cmd).toMatch(/"title"/);
      expect(cmd).toMatch(/"my-rig"/);
      expect(cmd).toMatch(/"cwd"/);
      expect(cmd).toMatch(/"\/path\/to\/cwd"/);
    });

    it("handles workspace.create with only title (no cwd)", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await transport.request("workspace.create", { title: "my-rig" });

      const cmd = captured.find((c) => c.startsWith("cmux rpc workspace.create"));
      expect(cmd).toBeTruthy();
      expect(cmd).toMatch(/"title"/);
      expect(cmd).not.toMatch(/"name"/);
      expect(cmd).not.toMatch(/"cwd"/);
    });
  });

  describe("workspace.close", () => {
    it("emits `cmux rpc workspace.close` with workspace_id (snake_case)", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await transport.request("workspace.close", { workspace_id: "workspace:6" });

      const cmd = captured.find((c) => c.startsWith("cmux rpc workspace.close"));
      expect(cmd).toBeTruthy();
      expect(cmd).toMatch(/"workspace_id"/);
      expect(cmd).toMatch(/"workspace:6"/);
    });
  });

  describe("pane.surfaces", () => {
    it("emits `cmux rpc pane.surfaces` with pane_id (snake_case)", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await transport.request("pane.surfaces", {
        pane_id: "pane:3",
        workspace_id: "workspace:1",
      });

      const cmd = captured.find((c) => c.startsWith("cmux rpc pane.surfaces"));
      expect(cmd).toBeTruthy();
      expect(cmd).toMatch(/"pane_id"/);
      expect(cmd).toMatch(/"pane:3"/);
      expect(cmd).toMatch(/"workspace_id"/);
    });

    it("parses surfaces array from cmux rpc response", async () => {
      const customExec = vi.fn(async (cmd: string) => {
        if (cmd === "cmux --help") return helpText();
        if (cmd === "cmux capabilities --json") return '{"capabilities":[]}';
        if (cmd.startsWith("cmux rpc pane.surfaces")) {
          return '{"surfaces":[{"id":"surface:1","title":"tab1","type":"terminal"}]}';
        }
        return "{}";
      }) as unknown as ExecFn;
      const factory = createCmuxCliTransport(customExec);
      const transport = await factory();

      const result = (await transport.request("pane.surfaces", { pane_id: "pane:3" })) as Record<string, unknown>;
      expect(Array.isArray(result["surfaces"])).toBe(true);
    });
  });

  describe("unknown methods still throw (regression guard)", () => {
    it("throws Unknown cmux method for an unmapped method name", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await expect(transport.request("totally.bogus.method", {})).rejects.toThrow(/Unknown cmux method/);
    });
  });
});
