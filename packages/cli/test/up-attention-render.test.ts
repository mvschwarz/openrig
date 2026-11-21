import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { upCommand } from "../src/commands/up.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { DaemonClient } from "../src/client.js";
import { buildAttentionResponse } from "../../daemon/src/routes/up.js";
import * as remoteOps from "../src/remote-host-ops.js";

const attentionNodes = [
  { logicalId: "dev.owner", sessionName: "dev-owner@first", reason: "update_gate", evidence: "Update available!" },
  { logicalId: "dev.checker", sessionName: "dev-checker@first", reason: "returned_to_shell", evidence: "$" },
];
function attentionBody() {
  const result = { rigId: "first", stages: [{ stage: "import_rig", status: "blocked",
    detail: { code: "attention_required", message: "2 members need attention.", attentionNodes } }] };
  return { ...result, ...buildAttentionResponse(result)! };
}

// Execute the actual command and daemon response builder; transport/lifecycle
// are injected. No listener, daemon, tmux or provider process is started.
async function render(data: Record<string, unknown>, status = 409, json = false, host = false) {
  const oldExit = process.exitCode;
  const out: string[] = [], err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...s) => { out.push(s.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...s) => { err.push(s.join(" ")); });
  const forbidden = () => { throw new Error("unexpected lifecycle operation"); };
  const lifecycleDeps = {
    spawn: forbidden, kill: forbidden, writeFile: forbidden, removeFile: forbidden,
    mkdirp: forbidden, openForAppend: forbidden,
    fetch: async () => ({ ok: true }), isProcessAlive: () => true,
    exists: (p: string) => p === STATE_FILE,
    readFile: (p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 12345, db: "mock", startedAt: "2000-01-01" }) : null,
  } as LifecycleDeps;
  const client = { get: vi.fn(async () => ({ status: 200, data: [] })),
    post: vi.fn(async () => ({ status, data })) };
  const remote = host ? vi.spyOn(remoteOps, "runRemoteHttpOp").mockResolvedValue({ ok: true, failedStep: "none", data }) : undefined;
  process.exitCode = undefined;
  try {
    const cmd = new Command().exitOverride().addCommand(upCommand({
      lifecycleDeps, clientFactory: () => client as unknown as DaemonClient,
      preflightExec: forbidden,
    }));
    await cmd.parseAsync(["node", "rig", "up", "first-project", ...(json ? ["--json"] : []), ...(host ? ["--host", "fixture"] : [])]);
    if (host) expect(remote).toHaveBeenCalledTimes(1);
    else expect(client.post).toHaveBeenCalledTimes(1);
    return { out: out.join("\n"), err: err.join("\n"), exit: process.exitCode };
  } finally { process.exitCode = oldExit; log.mockRestore(); error.mockRestore(); remote?.mockRestore(); }
}

describe("startup attention guidance", () => {
  it("shows pending startup guidance on a partial fresh up and preserves JSON and exits", async () => {
    const reason = "Permission consent needs attention; After resolving it in dev-owner@first, run: rig seat continue 'dev-owner@first'";
    const data = { status: "partial", rigId: "first", stages: [{ stage: "import_rig", status: "blocked", detail: {
      attentionNodes: [{ logicalId: "dev.owner", sessionName: "dev-owner@first", reason }],
    } }] };
    const human = await render(data, 200);
    expect(human.out).toContain(`Startup attention (dev-owner@first): ${reason}`);
    expect(human.out).toContain("Status: partial");
    expect(human.exit).toBe(1);
    const json = await render(data, 200, true);
    expect(json.out).toBe(JSON.stringify(data));
    expect(json.err).toBe("");
    expect(json.exit).toBe(1);
  });
  it("names a seat's launch error on a partial fresh up (OPR.0.7.0.9)", async () => {
    const error = "addition_missing: the agent file claude/missing.md is missing";
    const r = await render({ status: "partial", rigId: "proof", stages: [{ stage: "import_rig", status: "failed", detail: {
      nodes: [{ logicalId: "dev.ok", status: "launched" }, { logicalId: "dev.proof", status: "failed", error }] } }] }, 200);
    expect(r.err).toContain(`dev.proof: failed: ${error}`);
    expect(r.err).not.toContain("dev.ok");
  });
  it.each([
    { json: false, host: false }, { json: true, host: false },
    { json: false, host: true }, { json: true, host: true },
  ])("reports an unsuccessful launch with HTTP 200 (json=$json, host=$host)", async ({ json, host }) => {
    // Given an observed launch failure, not a missing model observation.
    const data = { status: "partial", stages: [{ stage: "import_rig", status: "failed", detail: {
      nodes: [{ logicalId: "main.seat", status: "failed", error: "pi launch failed: the runner exited (code 1)" }],
    } }] };
    // When rendering the daemon's retained launch outcome.
    const result = await render(data, 200, json, host);
    // Then both output modes fail and keep the seat's actual error.
    expect(result.exit).toBe(1);
    expect(result.out + result.err).toContain("main.seat");
    expect(result.out + result.err).toContain("pi launch failed");
    expect(result.out).not.toContain("Status: completed");
  });
  it("renders actual structured response and all affected members without spec advice", async () => {
    const body = attentionBody();
    const r = await render(body);
    expect(r.err).toContain(`Error: ${body.error.fact}`);
    expect(r.err).toContain(body.error.consequence);
    expect(r.err).toContain(body.error.action);
    for (const n of attentionNodes) {
      expect(r.err).toContain(n.logicalId);
      expect(r.err).toContain(n.sessionName);
      expect(r.err).toContain(n.reason);
    }
    expect(r.err).not.toMatch(/\[object Object\]|validate your spec|Sessions are running|answering it.*completes/);
    expect(r.out).toContain("import_rig: blocked");
    expect(r.exit).toBe(1);
  });
  it("daemon guidance does not assume a trust prompt or a live runtime", () => {
    const { error } = attentionBody();
    expect(error.consequence).toContain("attention_required");
    expect(error.consequence).toMatch(/not.*proven|not.*confirmed/i);
    expect(error.action).toMatch(/inspect/i);
    expect(error.action).not.toMatch(/answer.*prompt|parked session/i);
  });
  it.each([409, 500])("preserves exact JSON body and exit for HTTP %i", async (status) => {
    const data = attentionBody();
    const r = await render(data, status, true);
    expect(r.out).toBe(JSON.stringify(data));
    expect(r.err).toBe("");
    expect(r.exit).toBe(status === 409 ? 1 : 2);
  });
  it.each([409, 500])("preserves string fallback and exit for HTTP %i", async (status) => {
    const r = await render({ error: "agent_ref resolution failed", stages: [] }, status);
    expect(r.err).toContain(`Up failed: agent_ref resolution failed (HTTP ${status})`);
    expect(r.err).toContain("local: agent_ref paths resolve relative");
    expect(r.exit).toBe(status === 409 ? 1 : 2);
  });
});
