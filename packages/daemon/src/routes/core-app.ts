import { streamSSE } from "hono/streaming";
import { Hono, type Context } from "hono";
import type { CoreAppJob } from "../domain/core-app-job.js";
import type { CoreAppCredential } from "../domain/core-app-access.js";
import { CoreAppAccess, CoreAppError, appObject } from "../domain/core-app-access.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";

/** Local-instance facade. The server's Host/Origin boundary still precedes this group. */
export function coreAppRoutes(opts: { access?: CoreAppAccess; operatorToken?: string | null; job?: CoreAppJob }): Hono {
  const app = new Hono();
  const requireOwner = authBearerTokenMiddleware({ expectedToken: opts.operatorToken ?? null });
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
      // Provisioning is an owner act: the owner write route's own gate, unchanged. With no owner bearer configured that gate
      // passes any request, so an app credential (valid, revoked or malformed) must never ride that opening as the owner.
      if ((opts.operatorToken ?? null) === null && /^Bearer\s+orapp_/i.test(c.req.header("Authorization") ?? "")) throw new CoreAppError("unauthorized", 401);
      return requireOwner(c, next);
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
  app.get("/v1/capabilities", c => {
    if (!opts.job) throw new CoreAppError("app_job_unavailable", 503);
    opts.access!.assertAvailable();
    return c.json({ contract: "openrig.core-app", version: 1,
      jobs: [{ id: "human-answer", requestKinds: ["structured-human-ask"], answerForms: ["option", "typed-reply"],
        actorAssurance: ["app-attributed"], independentHumanAuthentication: false, stableSubmissionIds: true, resultRead: true }],
      app: { id: credential(c).appId, actors: credential(c).actors },
      refresh: { snapshot: true, events: "invalidation-only", pollAfterMs: 5000, reconnect: "reread-capabilities-needs-me-and-tracked-results" },
      links: { needsMe: "/api/apps/v1/needs-me", events: "/api/apps/v1/events" } });
  });
  const job = () => { if (!opts.job) throw new CoreAppError("app_job_unavailable", 503); return opts.job; };
  const actor = (c: Context) => job().actor(credential(c), c.req.query("actor"));
  app.get("/v1/needs-me", c => c.json(job().needsMe(credential(c), actor(c))));
  app.get("/v1/requests/:requestId", c => c.json(job().snapshot(() => job().request(credential(c), c.req.param("requestId"), actor(c)))));
  app.get("/v1/requests/:requestId/result", c => c.json(job().result(credential(c), c.req.param("requestId"), actor(c))));
  app.get("/v1/work/:qitemId", c => c.json(job().work(credential(c), c.req.param("qitemId"), c.req.query("requestId") ?? "", actor(c))));
  app.get("/v1/answers/:answerId", c => c.json(job().readAnswer(credential(c), c.req.param("answerId"), actor(c))));
  app.post("/v1/answers/:answerId", async c => {
    let body: unknown; try { body = await c.req.json(); } catch { throw new CoreAppError("invalid_body", 400); }
    return c.json(await job().submit(credential(c), c.req.param("answerId"), body));
  });
  app.get("/v1/events", c => {
    const source = job(), auth = c.req.header("Authorization");
    // App-scoped invalidations carry no actor or raw event data. Each following read selects its own actor.
    return streamSSE(c, async stream => {
      const buffer: number[] = [];
      let overflow = false, revoked = false, stopped = false, wake: (() => void) | undefined;
      const signal = () => { wake?.(); wake = undefined; };
      const unsubscribe = source.bus.subscribe(event => {
        if (event.transient || !["queue.created", "queue.updated", "queue.answer_recorded", "mission_control.action_executed"].includes(event.type)) return;
        try { opts.access!.authenticate(auth); } catch { revoked = true; signal(); return; }
        if (buffer.length >= 500) overflow = true; else buffer.push(event.seq);
        signal();
      });
      const heartbeat = setInterval(signal, 15000);
      stream.onAbort(() => { stopped = true; clearInterval(heartbeat); unsubscribe(); signal(); });
      const reset = () => stream.writeSSE({ event: "reset", data: JSON.stringify({ kind: "reset", reason: "continuity-unproven" }) });
      const invalidate = (seq: number) => stream.writeSSE({ id: source.cursor(seq), event: "invalidate", data: JSON.stringify({ kind: "invalidate", cursor: source.cursor(seq), requestId: null }) });
      try {
        // Subscribe precedes the synchronous replay snapshot, so events crossing the boundary are buffered and deduped.
        const replay = source.eventReplay(c.req.header("Last-Event-ID"));
        if (!replay) { await reset(); return; }
        for (const seq of replay.sequences) {
          if (stopped || revoked || overflow) break;
          await invalidate(seq);
        }
        let consumed = replay.head;
        if (stopped) return;
        await stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ kind: "heartbeat" }) });
        while (!stopped) {
          try { opts.access!.authenticate(auth); } catch { revoked = true; }
          if (revoked) return;
          if (overflow) { await reset(); return; }
          while (buffer.length && !stopped && !revoked && !overflow) {
            const seq = buffer.shift()!;
            if (seq <= consumed) continue;
            await invalidate(seq); consumed = seq;
          }
          if (overflow || revoked || stopped) continue;
          await new Promise<void>(resolve => { wake = resolve; });
          try { opts.access!.authenticate(auth); } catch { return; }
          if (!buffer.length && !stopped && !revoked && !overflow) await stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ kind: "heartbeat" }) });
        }
      } finally { clearInterval(heartbeat); unsubscribe(); }
    });
  });
  app.all("/v1/*", c => c.json({ error: "not_found" }, 404));
  app.all("/*", c => c.json({ error: "unsupported_contract_version", supportedVersions: [1] }, 404));
  return app;
}

function credential(c: Context): CoreAppCredential { return c.get("coreAppCredential" as never) as CoreAppCredential; }
