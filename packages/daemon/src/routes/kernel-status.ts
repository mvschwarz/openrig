// V0.3.1 slice 05 kernel-rig-as-default — forward-fix #3 architectural.
//
// GET /api/kernel/status — read-only observability surface for the
// background kernel-boot. Pairs with the architectural decoupling in
// kernel-boot-tracker.ts: healthz binds early; this route lets
// operators (and CLI's `--wait-for-kernel`) observe kernel agent
// readiness independently of HTTP health.
//
// Returns one of two shapes:
//
//   200 { kernel_state, agents[], first_unready_since, variant, detail }
//     — when the tracker is wired (the standard daemon composition).
//
//   503 { error: 'kernel_boot_tracker_unavailable', message: ... }
//     — when AppDeps was constructed without a tracker (test fixtures
//       or custom daemon compositions). Clear hint instead of a 500.

import { Hono } from "hono";
import type { KernelBootTracker } from "../domain/kernel-boot-tracker.js";

export const kernelStatusRoutes = new Hono();

kernelStatusRoutes.get("/status", (c) => {
  const tracker = c.get("kernelBootTracker" as never) as KernelBootTracker | undefined;
  if (!tracker) {
    return c.json(
      {
        error: "kernel_boot_tracker_unavailable",
        message:
          "Kernel-boot tracker not wired into this daemon. Use --no-kernel or check startup logs for a kernel-boot failure that prevented tracker construction.",
      },
      503,
    );
  }
  const status = tracker.getStatus();
  return c.json({
    kernel_state: status.kernelState,
    agents: status.agents.map((a) => ({
      session_name: a.sessionName,
      runtime: a.runtime,
      startup_status: a.startupStatus,
    })),
    first_unready_since: status.firstUnreadySince,
    variant: status.variant,
    detail: status.detail,
  });
});
