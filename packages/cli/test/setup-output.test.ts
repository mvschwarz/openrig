import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { setupCommand, type SetupDeps, type SetupResult } from "../src/commands/setup.js";

// Exercise the real command/result path without probing or changing this host.
vi.mock("../src/commands/doctor.js", () => ({
  runDoctorChecks: () => ({ checks: [], asyncChecks: [] }),
}));
vi.mock("../src/config-store.js", () => ({
  ConfigStore: class {
    resolve() { return { daemon: { host: "127.0.0.1", port: 1 } }; }
  },
}));

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(failed: boolean): SetupDeps {
  return {
    platform: "darwin",
    env: {},
    exec: vi.fn((cmd: string) => {
      if (cmd === "claude auth status" && failed) throw new Error("fixture login missing");
      if (cmd === "cmux capabilities --json") return '{"capabilities":[]}';
      return "available";
    }),
    readFile: () => null,
    exists: () => false,
    writeFile: vi.fn(),
    mkdirp: vi.fn(),
  };
}

function expectConversationRoute(text: string): void {
  expect(text).toContain("Open the OpenRig view now?");
  expect(text).toContain("rig terminal open saved:kernel");
  expect(text).toContain("rig terminal open saved:kernel --window --json");
  expect(text).toContain("No copying or typing for the person");
  expect(text).toContain("then hand them to the ready operator");
  expect(text).toContain("Do not implement the person's project yourself");
  expect(text).toContain("Started is not ready");
  expect(text).toContain("rig context get reference/getting-started.md#incomplete-setup-and-restart");
}

describe("setup conversation handoff output", () => {
  for (const mode of ["dry-run", "failed", "ready"] as const) {
    for (const json of [false, true]) {
      it(`${mode} retains its outcome and offers the operator route in ${json ? "JSON" : "human output"}`, async () => {
        process.exitCode = undefined;
        vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
        const logs: string[] = [];
        vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.map(String).join(" ")); });
        const deps = fixture(mode === "failed");
        const program = new Command().addCommand(setupCommand(deps));
        await program.parseAsync(["node", "rig", "setup", ...(mode === "dry-run" ? ["--dry-run"] : []), ...(json ? ["--json"] : [])]);

        const output = logs.join("\n");
        expect(process.exitCode).toBe(mode === "failed" ? 1 : undefined);
        if (json) {
          expect(logs).toHaveLength(1);
          const result = JSON.parse(output) as SetupResult & { nextSteps: string[] };
          expect(result.ready).toBe(mode === "ready");
          expect(result.profile).toBe("core");
          expect(result.platform).toBe("darwin");
          expect(result.runtimeConfig.length).toBeGreaterThan(0);
          expectConversationRoute(result.nextSteps?.join("\n") ?? "");
          if (mode === "failed") {
            expect(result.steps).toContainEqual(expect.objectContaining({ id: "claude_auth", status: "fail", message: expect.stringContaining("fixture login missing") }));
          } else if (mode === "dry-run") {
            expect(result.steps.every((step) => step.status === "skipped")).toBe(true);
          }
        } else {
          expectConversationRoute(output);
          expect(output.includes("Setup complete.")).toBe(mode === "ready");
          expect(output).toContain("Permission policy (optional");
          if (mode === "failed") expect(output).toContain("fixture login missing");
          if (mode === "dry-run") {
            expect(output).toContain("Plan only: no setup changes were made; readiness was not checked.");
            // A short installer read must still reach the conversation handoff.
            expectConversationRoute(output.split("\n").slice(0, 80).join("\n"));
          }
        }
        if (mode === "dry-run") {
          expect(deps.exec).not.toHaveBeenCalled();
          expect(deps.writeFile).not.toHaveBeenCalled();
          expect(deps.mkdirp).not.toHaveBeenCalled();
          expect(fetch).not.toHaveBeenCalled();
        }
      });
    }
  }
});
