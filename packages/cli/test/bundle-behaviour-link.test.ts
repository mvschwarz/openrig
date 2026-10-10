import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { bundleCommand } from "../src/commands/bundle.js";
import { upCommand } from "../src/commands/up.js";
import { importGitHubBundle } from "../src/lib/bundle-source.js";
import type { StatusDeps } from "../src/commands/status.js";
import type { BundleBehaviour } from "@openrig/daemon/bundle-behaviour";

vi.mock("../src/host-selection.js", () => ({ resolveEffectiveHost: (host?: string) => host }));
vi.mock("../src/lib/bundle-source.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/bundle-source.js")>(), importGitHubBundle: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const view: BundleBehaviour = {
  schema: "openrig.bundle-behaviour/v1", state: "not_generated", reason: "legacy", localInspectCommand: "rig bundle inspect <archive> --json",
  identity: { source: null, configurationId: null, packageDigest: null, assembler: null, generator: { openrigVersion: "test" }, integrity: { digestValid: true, filesVerified: true } },
};

describe("prepared GitHub bundle view", () => {
  it.each(["up", "install", "inspect"])("%s uses one prepared archive and keeps JSON on one stdout result", async action => {
    const events: string[] = [];
    const stdout = vi.spyOn(console, "log").mockImplementation(() => { events.push("stdout"); });
    vi.spyOn(console, "error").mockImplementation(() => { events.push("header"); });
    const post = vi.fn(async (url: string, body: unknown) => {
      events.push(url);
      expect(body).toMatchObject({ bundlePath: "/retained/single.rigbundle" });
      if (url === "/api/bundles/inspect") return { status: 200, data: { manifest: {}, digestValid: true, integrityResult: { passed: true }, behaviour: view } };
      expect(url).toBe("/api/bundles/install");
      return { status: 201, data: { status: "completed", marker: "original result" } };
    });
    vi.mocked(importGitHubBundle).mockImplementation(async () => {
      events.push("prepare");
      return { client: { post }, bundlePath: "/retained/single.rigbundle", res: { status: 201, data: { archiveHash: "same" } } } as never;
    });
    const deps = { clientFactory: () => { throw new Error("must reuse prepared client"); }, lifecycleDeps: {} } as unknown as StatusDeps;
    const program = new Command().exitOverride();
    program.addCommand(action === "up" ? upCommand(deps) : bundleCommand(deps));
    const oldExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(["node", "rig", ...(action === "up" ? ["up"] : ["bundle", action]), "https://github.com/example/team/tree/main/rig", "--json"]);
      expect(importGitHubBundle).toHaveBeenCalledTimes(1);
      expect(post.mock.calls.filter(([url]) => url === "/api/bundles/inspect")).toHaveLength(1);
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({ behaviour: view });
      expect(process.exitCode).toBeUndefined();
      if (action !== "inspect") {
        expect(events.indexOf("header")).toBeLessThan(events.indexOf("/api/bundles/install"));
        expect(post.mock.calls.filter(([url]) => url === "/api/bundles/install")).toHaveLength(1);
        expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({ marker: "original result", archiveHash: "same" });
      } else expect(post).toHaveBeenCalledTimes(1);
    } finally { process.exitCode = oldExit; }
  });
});
