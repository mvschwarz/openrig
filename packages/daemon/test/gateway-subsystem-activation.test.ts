import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDaemon } from "../src/startup.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";

// S10 (OPR.0.5.5.10) proof item 1 — ACTIVATION, RED-FIRST. The M1 gateway components shipped
// with no boot-time caller (GATEWAY-M1-RECONCILIATION item 3: landed-not-activated). Under the
// amended M1 §3 contract (daemon-subsystem; the process split retired under founder R2) the
// daemon must activate the gateway as an IN-PROCESS subsystem at boot — no child process, no
// connector wire. These tests FAIL at today's tip because createDaemon never constructs the
// subsystem; they go green with the startup wiring. That pins the landed-not-activated class:
// a future regression that drops the boot caller turns this suite red by name.

const cmuxFactory: CmuxTransportFactory = async () => {
  throw Object.assign(new Error("no socket"), { code: "ENOENT" });
};
const tmuxExec: ExecFn = async () => "";

describe("S10 gateway subsystem activation (RED at tip: no boot-time subsystem caller)", () => {
  beforeAll(() => {
    process.env.OPENRIG_NO_KERNEL = "1";
  });
  afterAll(() => {
    delete process.env.OPENRIG_NO_KERNEL;
  });

  it("createDaemon exposes an ACTIVE gateway subsystem on AppDeps (daemon boot activates it in-process)", async () => {
    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      const subsystem = (deps as Record<string, unknown>).gatewaySubsystem as
        | { status: () => { state: string } }
        | undefined;
      expect(subsystem, "AppDeps.gatewaySubsystem must be constructed by createDaemon (the boot-time caller)").toBeDefined();
      expect(subsystem!.status().state, "the subsystem must report ACTIVE after boot").toBe("active");
    } finally {
      db.close();
    }
  }, 30000);

  it("subsystem health is visible on a real surface: GET /api/health-summary/gateway", async () => {
    const { db, app } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      const res = await app.request("/api/health-summary/gateway");
      expect(res.status, "the gateway health route must exist (404 = no surface)").toBe(200);
      const body = (await res.json()) as { state?: string };
      expect(body.state, "the health surface must carry the subsystem state").toBe("active");
    } finally {
      db.close();
    }
  }, 30000);

  it("an induced activation failure reports HONESTLY (state=failed with the cause) — never a silent dead gateway, never a boot crash", async () => {
    // Dynamic import so this leg fails by name at tip (module absent), independently of legs 1-2.
    const mod = (await import("../src/domain/gateway/gateway-subsystem.js")) as {
      GatewaySubsystem: new (deps: {
        home: string;
        wire: () => { stop: () => void };
        log?: (m: string) => void;
      }) => {
        start: () => void;
        status: () => { state: string; reason?: string };
        stop: () => void;
      };
    };
    const home = mkdtempSync(join(tmpdir(), "s10-gw-"));
    try {
      const failing = new mod.GatewaySubsystem({
        home,
        wire: () => {
          throw new Error("induced wiring failure: slack transport misconfigured");
        },
      });
      // start() must NOT throw upward (a broken gateway must never take the daemon down)…
      expect(() => failing.start()).not.toThrow();
      const s = failing.status();
      // …and must NOT read active: honest failure with the cause named.
      expect(s.state, "an induced failure must surface as failed, never silent-active").toBe("failed");
      expect(s.reason ?? "", "the failure reason must name the cause").toContain("induced wiring failure");
      failing.stop();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
