import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { startupProofCommand, resolveStartupProofEndpoint, submitStartupProof } from "../src/commands/startup-proof.js";

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errors: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExit = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await fn();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const exitCode = process.exitCode;
    process.exitCode = origExit;
    resolve({ logs, errors, exitCode });
  });
}

describe("rig startup-proof", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("resolves endpoint and token from the activity endpoint file", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-startup-proof-"));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "activity-endpoint.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:17433", token: "tok-file" }));
      expect(resolveStartupProofEndpoint({ env: { OPENRIG_HOME: root } })).toEqual({
        baseUrl: "http://127.0.0.1:17433",
        token: "tok-file",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("posts startup_proof through the authenticated activity hook", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      oriented: "verified",
      nodeId: "node-1",
      challengeId: "challenge-1",
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const result = await submitStartupProof(
      { challengeId: "challenge-1", answer: "answer-1" },
      {
        fetchImpl,
        env: {
          OPENRIG_URL: "http://127.0.0.1:7433",
          OPENRIG_ACTIVITY_HOOK_TOKEN: "tok-env",
          OPENRIG_SESSION_NAME: "dev-qa@test-rig",
          OPENRIG_NODE_ID: "node-1",
          OPENRIG_RUNTIME: "codex",
        },
      },
    );

    expect(result).toMatchObject({ ok: true, oriented: "verified", nodeId: "node-1" });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:7433/api/activity/hooks", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer tok-env" }),
    }));
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      eventFamily: "startup_proof",
      sessionName: "dev-qa@test-rig",
      nodeId: "node-1",
      runtime: "codex",
      challengeId: "challenge-1",
      answer: "answer-1",
    });
  });

  it("CLI submit prints verified result without exposing the bearer token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      oriented: "verified",
      nodeId: "node-1",
      challengeId: "challenge-1",
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const program = new Command();
    program.exitOverride();
    program.addCommand(startupProofCommand({
      fetchImpl,
      env: {
        OPENRIG_URL: "http://127.0.0.1:7433",
        OPENRIG_ACTIVITY_HOOK_TOKEN: "tok-secret",
        OPENRIG_NODE_ID: "node-1",
        OPENRIG_RUNTIME: "claude-code",
      },
    }));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync(["node", "rig", "startup-proof", "submit", "--challenge-id", "challenge-1", "--answer", "answer-1"]);
    });

    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain("startup_proof: verified");
    expect(output).toContain("node_id: node-1");
    expect(output).not.toContain("tok-secret");
  });
});
