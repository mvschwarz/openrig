import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { upCommand } from "../src/commands/up.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { DaemonClient } from "../src/client.js";
import { buildAttentionResponse } from "../../daemon/src/routes/up.js";

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
async function render(data: Record<string, unknown>, status = 409, json = false) {
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
  process.exitCode = undefined;
  try {
    const cmd = new Command().exitOverride().addCommand(upCommand({
      lifecycleDeps, clientFactory: () => client as unknown as DaemonClient,
      preflightExec: forbidden,
    }));
    await cmd.parseAsync(["node", "rig", "up", "first-project", ...(json ? ["--json"] : [])]);
    expect(client.post).toHaveBeenCalledTimes(1);
    return { out: out.join("\n"), err: err.join("\n"), exit: process.exitCode };
  } finally { process.exitCode = oldExit; log.mockRestore(); error.mockRestore(); }
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
    expect(json.exit).toBeUndefined();
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
