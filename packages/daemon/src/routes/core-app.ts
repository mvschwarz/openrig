import { Hono, type Context } from "hono";
import type { CoreAppJob } from "../domain/core-app-job.js";
import type { CoreAppCredential } from "../domain/core-app-access.js";
import { isIP } from "node:net";
import { CoreAppAccess, CoreAppError, appObject } from "../domain/core-app-access.js";
import { constantTimeEqual } from "../middleware/auth-bearer-token.js";

/** Local-instance facade. The server's Host/Origin boundary still precedes this group. */
export function coreAppRoutes(opts: { access?: CoreAppAccess; operatorToken?: string | null; job?: CoreAppJob }): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof CoreAppError) return c.json({ error: error.code, ...error.details }, error.status);
    throw error;
  });
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    try { await next(); } catch (error) {
      if (error instanceof CoreAppError) return c.json({ error: error.code, ...error.details }, error.status);
      throw error;
    }
  });
  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/api/apps/v1/credentials" || c.req.path.startsWith("/api/apps/v1/credentials/")) {
      if (!opts.operatorToken) throw new CoreAppError("app_provisioning_unconfigured", 503);
      if (!constantTimeEqual(c.req.header("Authorization") ?? "", `Bearer ${opts.operatorToken}`)) throw new CoreAppError("unauthorized", 401);
      // Native socket evidence only: neither Host nor forwarded headers establish locality.
      const peer = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
      if (!peer || !(peer === "::1" || peer === "::ffff:127.0.0.1" || isIP(peer) === 4 && peer.startsWith("127."))) throw new CoreAppError("local_peer_required", 403);
    } else {
      if (!opts.access) throw new CoreAppError("unauthorized", 401);
      c.set("coreAppCredential" as never, opts.access.authenticate(c.req.header("Authorization")) as never);
    }
    await next();
  });
  app.post("/v1/credentials", async c => {
    if (!opts.access) throw new CoreAppError("app_job_unavailable", 503);
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new CoreAppError("invalid_body", 400); }
    return c.json(opts.access.issue(appObject(body)), 201);
  });
  app.delete("/v1/credentials/:credentialId", c => {
    if (!opts.access) throw new CoreAppError("app_job_unavailable", 503);
    opts.access.revoke(c.req.param("credentialId"));
    return c.json({ revoked: true });
  });
  app.get("/v1/capabilities", c => c.json({ contract: "openrig.core-app", version: 1, jobs: [],
    app: { id: credential(c).appId, actors: credential(c).actors },
    refresh: { snapshot: true, pollAfterMs: 5000 } }));
  const job = () => { if (!opts.job) throw new CoreAppError("app_job_unavailable", 503); return opts.job; };
  const actor = (c: Context) => job().actor(credential(c), c.req.query("actor"));
  app.get("/v1/needs-me", c => c.json(job().needsMe(credential(c), actor(c))));
  app.get("/v1/requests/:requestId", c => c.json(job().snapshot(() => job().request(credential(c), c.req.param("requestId"), actor(c)))));
  app.get("/v1/answers/:answerId", c => c.json(job().readAnswer(credential(c), c.req.param("answerId"), actor(c))));
  app.post("/v1/answers/:answerId", async c => {
    let body: unknown; try { body = await c.req.json(); } catch { throw new CoreAppError("invalid_body", 400); }
    return c.json(await job().submit(credential(c), c.req.param("answerId"), body));
  });
  app.all("/v1/*", c => c.json({ error: "not_found" }, 404));
  app.all("/*", c => c.json({ error: "unsupported_contract_version", supportedVersions: [1] }, 404));
  return app;
}

function credential(c: Context): CoreAppCredential { return c.get("coreAppCredential" as never) as CoreAppCredential; }
