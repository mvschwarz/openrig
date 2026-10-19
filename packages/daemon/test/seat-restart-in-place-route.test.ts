// OPR.0.7.0.5 — the in-place restart routes through the production route factory: refusal statuses, and
// that the factory hands the Codex adapter's in-place surface to the restart (not only injected doubles).
import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";

describe("POST /api/seat/restart{,-plan,-verify}/:seatRef", () => {
  let db: Database.Database;
  afterEach(() => db.close());

  function app(runtime: string, adapters?: Record<string, unknown>) {
    db = createFullTestDb();
    const setup = createTestApp(db, adapters ? { adapters: adapters as never } : undefined);
    // The shared mock predates the classified probe; this seat's session is present.
    (setup.tmuxAdapter as unknown as { probeSession: () => Promise<{ state: "present" }> }).probeSession = async () => ({ state: "present" });
    const rig = setup.rigRepo.createRig("r");
    const node = setup.rigRepo.addNode(rig.id, "dev.codex", { runtime, cwd: "/work" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-codex@r");
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: "dev-codex@r", tmuxPane: "%1" });
    const post = async (route: string, body: Record<string, unknown> = {}) => {
      const res = await setup.app.request(`/api/seat/${route}/dev-codex%40r`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    return { post };
  }

  it("400 without a reason; 500 when the daemon has no in-place Codex adapter", async () => {
    const { post } = app("codex");
    expect(await post("restart")).toMatchObject({ status: 400, body: { code: "missing_reason" } });
    expect(await post("restart-plan")).toMatchObject({ status: 500, body: { code: "runtime_adapter_missing" } });
    expect(await post("restart-verify")).toMatchObject({ status: 500, body: { code: "runtime_adapter_missing" } });
  });

  it("the production Codex adapter satisfies the in-place surface; a non-Codex seat is refused 409", async () => {
    const codex = new CodexRuntimeAdapter({ tmux: {} as never, fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {} } });
    expect(typeof codex.buildResumeCommand).toBe("function");
    expect(typeof codex.verifyResumeInPane).toBe("function");
    const { post } = app("claude-code", { codex });
    expect(await post("restart-plan")).toMatchObject({ status: 409, body: { code: "not_codex" } });
  });

  it("verify with nothing restarted is a 409 refusal", async () => {
    const codex = new CodexRuntimeAdapter({ tmux: {} as never, fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {} } });
    const { post } = app("codex", { codex });
    expect(await post("restart-verify", { expectAccount: "me@example.com" })).toMatchObject({ status: 409, body: { code: "no_restart_recorded" } });
  });
});
