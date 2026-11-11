import { Hono, type Context } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import { NetworkBindingError, NetworkBindingStore } from "../domain/network/network-bindings.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { OPENRIG_HOME } from "../openrig-compat.js";

/** A local seat's connections to a remote hub (`rig network`). Reads list every binding with its state and last contact;
 *  the token is accepted on connect and never returned. Writes are gated like the hosts routes: enforced when an operator
 *  bearer is configured, passed through on a loopback or tailnet-trusted daemon. */
export function networkRoutes(opts?: { bearerToken?: string | null; home?: string }): Hono {
  const router = new Hono();
  const requireAuth = authBearerTokenMiddleware({ expectedToken: opts?.bearerToken ?? null });
  router.use("/bindings", async (c, next) => (c.req.method === "GET" ? next() : requireAuth(c, next)));
  router.use("/bindings/:id/disconnect", requireAuth);

  const store = (c: Context) => new NetworkBindingStore((c.get("rigRepo" as never) as RigRepository).db, opts?.home ?? OPENRIG_HOME);
  const refused = (c: Context, error: unknown) => {
    if (error instanceof NetworkBindingError) return c.json({ error: error.code, message: error.message }, error.status);
    throw error;
  };

  // The connector's own view (next pass, backoff, last pass) when it runs in this daemon; null otherwise.
  router.get("/bindings", (c) => {
    const connector = c.get("networkConnector" as never) as { snapshot(): unknown } | undefined;
    return c.json({ bindings: store(c).list(), connector: connector?.snapshot() ?? null });
  });

  router.post("/bindings", async (c) => {
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_body", message: "The body must be JSON." }, 400); }
    try {
      return c.json(store(c).create({ session: body.session, hubUrl: body.hubUrl, hubSeat: body.hubSeat, token: body.token, allowHttp: body.allowHttp }), 201);
    } catch (error) { return refused(c, error); }
  });

  router.post("/bindings/:id/disconnect", async (c) => {
    let body: Record<string, unknown> = {};
    try { body = await c.req.json(); } catch { /* no reason given */ }
    try {
      return c.json(store(c).disconnect(c.req.param("id"), typeof body.reason === "string" ? body.reason : undefined));
    } catch (error) { return refused(c, error); }
  });

  return router;
}
