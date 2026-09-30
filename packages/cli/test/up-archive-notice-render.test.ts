// #141: `rig up` terminal output for the stopped-generation archive. The archive notice must reach the user
// on the attention 409 too (the replacement is kept there), and a generation_unconfirmed refusal prints its
// own actionable message. Actual command renderer and daemon attention builder; the client is stubbed.
import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { upCommand } from "../src/commands/up.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { DaemonClient } from "../src/client.js";
import { buildAttentionResponse } from "../../daemon/src/routes/up.js";

const OLD = "01OLDGENERATION00000000000";
const NOTICE = `Archived the stopped earlier "first-project" rig ${OLD}; its records are kept. Restore it with: rig unarchive ${OLD}`;

async function render(data: Record<string, unknown>, status: number, json = false) {
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
  const client = { get: vi.fn(async () => ({ status: 200, data: [] })), post: vi.fn(async () => ({ status, data })) };
  process.exitCode = undefined;
  try {
    const cmd = new Command().exitOverride().addCommand(upCommand({
      lifecycleDeps, clientFactory: () => client as unknown as DaemonClient, preflightExec: forbidden,
    }));
    await cmd.parseAsync(["node", "rig", "up", "first-project", ...(json ? ["--json"] : [])]);
    return { out: out.join("\n"), err: err.join("\n"), exit: process.exitCode };
  } finally { process.exitCode = oldExit; log.mockRestore(); error.mockRestore(); }
}

function attentionWithNotice() {
  const attentionNodes = [{ logicalId: "dev.owner", sessionName: "dev-owner@first-project", reason: "trust_gate", evidence: "trust" }];
  const result = { rigId: "NEWRIG", warnings: [NOTICE], stages: [{ stage: "import_rig", status: "blocked",
    detail: { code: "attention_required", message: "1 member needs attention.", attentionNodes } }] };
  return { ...result, ...buildAttentionResponse(result)! };
}

describe("#141 rig up output for the stopped-generation archive", () => {
  it("attention 409: prints the archive notice with the old rig id and its unarchive instruction", async () => {
    const r = await render(attentionWithNotice(), 409);
    expect(r.err).toContain(`rig unarchive ${OLD}`);
    expect(r.err).toContain("dev.owner");
    expect(r.exit).toBe(1);
  });

  it("attention 409 --json: the JSON body is unchanged and nothing else is printed", async () => {
    const data = attentionWithNotice();
    const r = await render(data, 409, true);
    expect(r.out).toBe(JSON.stringify(data));
    expect(r.err).toBe("");
    expect(r.exit).toBe(1);
  });

  it("generation_unconfirmed 409: prints its actionable message, not the validate-your-spec fallback", async () => {
    const message = `A rig named "first-project" already exists (${OLD}), and OpenRig could not confirm it is stopped: tmux session x still exists. Nothing was created. Restore it with 'rig up first-project', or archive it first with 'rig archive ${OLD}'.`;
    const r = await render({ code: "generation_unconfirmed", error: message, errors: [message],
      stages: [{ stage: "import_rig", status: "failed", detail: { code: "generation_unconfirmed" } }] }, 409);
    expect(r.err).toContain(message);
    expect(r.err).not.toMatch(/validate your spec|Check daemon logs/);
    expect(r.exit).toBe(1);
  });

  it("control: on success a warning is printed exactly once", async () => {
    const r = await render({ status: "completed", rigId: "NEWRIG", stages: [], warnings: [NOTICE] }, 201);
    expect(r.err.split(`rig unarchive ${OLD}`).length - 1).toBe(1);
  });
});
