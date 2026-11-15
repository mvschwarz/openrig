import { Hono, type Context } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import { NetworkBindingError, NetworkBindingStore } from "../domain/network/network-bindings.js";
import { networkClosedElsewhere } from "../domain/network/network-connector.js";
import { NetworkInstallationStore, type AccountFetch } from "../domain/network/network-installations.js";
import { getSelfHostId } from "../domain/hosts/fanout-contract.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { OPENRIG_HOME } from "../openrig-compat.js";

/** A local seat's connections to a remote hub (`rig network`). Reads list every binding with its state and last contact,
 *  and the account enrollments; tokens and keys are accepted and never returned. Writes are gated like the hosts routes:
 *  enforced when an operator bearer is configured, passed through on a loopback or tailnet-trusted daemon. */
export function networkRoutes(opts?: { bearerToken?: string | null; home?: string; accountFetch?: AccountFetch; selfHostId?: () => string | null; accountTimeoutMs?: number }): Hono {
  const router = new Hono();
  const requireAuth = authBearerTokenMiddleware({ expectedToken: opts?.bearerToken ?? null });
  router.use("/bindings", async (c, next) => (c.req.method === "GET" ? next() : requireAuth(c, next)));
  router.use("/bindings/:id/disconnect", requireAuth);
  router.use("/installations", requireAuth);

  const home = opts?.home ?? OPENRIG_HOME;
  const db = (c: Context) => (c.get("rigRepo" as never) as RigRepository).db;
  const store = (c: Context) => new NetworkBindingStore(db(c), home);
  const installations = (c: Context) => new NetworkInstallationStore(db(c), home, { fetch: opts?.accountFetch, selfHostId: opts?.selfHostId ?? getSelfHostId, timeoutMs: opts?.accountTimeoutMs });
  const refused = (c: Context, error: unknown) => {
    if (error instanceof NetworkBindingError) return c.json({ error: error.code, message: error.message }, error.status);
    throw error;
  };
  const json = async (c: Context): Promise<Record<string, unknown> | null> => {
    try { return await c.req.json(); } catch { return null; }
  };

  // The connector's own view (next pass, backoff, last pass) when it runs in this daemon; null otherwise.
  router.get("/bindings", (c) => {
    const connector = c.get("networkConnector" as never) as { snapshot(): unknown } | undefined;
    // Hub items someone else closed before a binding's result reached them: a conflict the person sees.
    const enrolled = installations(c);
    const bindings = store(c).list().map((b) => ({ ...b, closedElsewhere: networkClosedElsewhere(db(c), b.id), accountRemoval: enrolled.removalOf(b) }));
    return c.json({ bindings, installations: enrolled.list(), connector: connector?.snapshot() ?? null });
  });

  // With a hub URL and token, bind to that hub directly; with only a participant name, through the enrolled account.
  router.post("/bindings", async (c) => {
    const body = await json(c);
    if (!body) return c.json({ error: "invalid_body", message: "The body must be JSON." }, 400);
    try {
      if (body.hubUrl === undefined && body.token === undefined && body.participantName !== undefined) {
        return c.json(await installations(c).connect(store(c), { session: body.session, name: body.participantName }), 201);
      }
      return c.json(store(c).create({ session: body.session, hubUrl: body.hubUrl, hubSeat: body.hubSeat, token: body.token, allowHttp: body.allowHttp }), 201);
    } catch (error) { return refused(c, error); }
  });

  router.post("/installations", async (c) => {
    const body = await json(c);
    if (!body) return c.json({ error: "invalid_body", message: "The body must be JSON." }, 400);
    try {
      return c.json(await installations(c).enroll(store(c), { code: body.code, site: body.site, allowHttp: body.allowHttp, replace: body.replace }), 201);
    } catch (error) { return refused(c, error); }
  });

  // The binding ends here first, then a binding made through the account is dropped there, which revokes its name.
  router.post("/bindings/:id/disconnect", async (c) => {
    const body = (await json(c)) ?? {};
    const bindings = store(c);
    const target = bindings.find(c.req.param("id"));
    if (!target) return refused(c, new NetworkBindingError("binding_not_found", `No network binding or connected seat is named '${c.req.param("id")}'.`, 404));
    let cleanup: unknown = null;
    try { bindings.disconnect(target.id, typeof body.reason === "string" ? body.reason : undefined); } catch (error) { cleanup = error; }
    try {
      const enrolled = installations(c);
      const ended = await enrolled.removeAtAccount(bindings, bindings.get(target.id)!);
      return cleanup ? refused(c, cleanup) : c.json({ ...ended, accountRemoval: enrolled.removalOf(ended) });
    } catch (error) { return refused(c, cleanup ?? error); }
  });

  return router;
}
