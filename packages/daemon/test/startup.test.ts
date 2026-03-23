import { describe, it, expect, vi } from "vitest";
import { createDaemon } from "../src/startup.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";

describe("createDaemon startup composition", () => {
  it("calls cmuxAdapter.connect() during startup", async () => {
    const connectCalled = vi.fn();
    const cmuxFactory: CmuxTransportFactory = async () => {
      connectCalled();
      const err = new Error("no socket") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    };
    const tmuxExec: ExecFn = async () => "";

    const { db } = await createDaemon({ cmuxFactory, tmuxExec });

    // Factory was called during startup (connect() invoked)
    expect(connectCalled).toHaveBeenCalled();

    db.close();
  });

  it("createDaemon app: GET /api/rigs/:rigId/sessions returns 200 (session routes mounted)", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { app, db, deps } = await createDaemon({ cmuxFactory, tmuxExec });

    // Seed a rig so the sessions endpoint has something to query
    const rig = deps.rigRepo.createRig("r01");

    const res = await app.request(`/api/rigs/${rig.id}/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    db.close();
  });

  it("createDaemon app: GET /api/adapters/cmux/status returns 200 (adapter routes mounted)", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { app, db } = await createDaemon({ cmuxFactory, tmuxExec });

    const res = await app.request("/api/adapters/cmux/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("available");

    db.close();
  });
});
