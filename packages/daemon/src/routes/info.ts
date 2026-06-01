import { Hono } from "hono";
import { getOpenRigInstallRoot } from "../domain/cwd-resolution.js";

// GET /api/info — daemon-info surface for tactical CLI awareness paths
// (OPR.0.3.2.22 Bug 3 first consumer: CLI default-cwd extension for
// path-form `rig up <install-internal-spec>` without --cwd).
//
// installRoot is the daemon's on-disk install root (the parent of the
// daemon's package directory). The CLI uses it to detect when a spec
// path lives inside the OpenRig install — the case that hits
// getOpenRigInstallCwdError at preflight without a --cwd override.
export function infoRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json({
      installRoot: getOpenRigInstallRoot(),
    });
  });

  return app;
}
