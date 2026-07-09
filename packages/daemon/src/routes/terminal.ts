// OPR.0.4.6.02 C3 — the terminal-provider-ride daemon routes.
//
// ONE canonical, NON-rig-scoped composer for EVERY view kind (arch R1 / guard
// b1): `POST /api/terminal/open {provider, view}` + `GET /api/terminal/views` +
// `GET /api/terminal/status`. The rig-scoped `POST /api/rigs/:rigId/terminal/
// open` is a THIN ALIAS that composes `view = rig:<rigId>` and delegates to the
// SAME `TerminalService` — zero composition logic of its own. The CLI and the
// web-UI launcher both hit the canonical seam.
//
// The response body is ALWAYS the one shared `OpenViewResult { opened, absent,
// degraded }` shape (arch Q3) — carried byte-identically here and in the CLI
// JSON. HTTP status maps only the resolution outcome: bad input → 400, unknown
// view → 404; a provider-unavailable or honest-partial is a 200 whose BODY
// tells the truth (ok / opened / degraded), never an error status.
//
// No new auth/trust surface (PRD "no new auth surface v1"): these routes mirror
// the shipped cmux launch route's posture (which does not gate on the terminal
// bearer token) — composing a view reads inventory and returns attach commands
// the provider runs client-side; it mutates no daemon state.

import { Hono } from "hono";
import type { TerminalService } from "../domain/terminal/terminal-service.js";

function getService(c: { get(key: string): unknown }): TerminalService | null {
  return (c.get("terminalService" as never) as TerminalService | undefined) ?? null;
}

/** Map a service OpenViewResult code to an HTTP status (body is always the full result). */
function statusForOpen(ok: boolean, code: string | undefined): 200 | 400 | 404 {
  if (ok) return 200;
  if (code === "view_required" || code === "unknown_provider") return 400;
  if (code === "view_not_found") return 404;
  // provider-unavailable / layout-unsupported / honest-partial: a truthful 200 body.
  return 200;
}

/** Parse the `{ provider?, view }` open body honestly (a non-object / missing view → structured 400 upstream). */
function readOpenBody(raw: unknown): { provider?: string; view?: string } {
  if (raw === null || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const provider = typeof obj["provider"] === "string" ? (obj["provider"] as string) : undefined;
  const view = typeof obj["view"] === "string" ? (obj["view"] as string) : undefined;
  return { ...(provider !== undefined ? { provider } : {}), ...(view !== undefined ? { view } : {}) };
}

/** The canonical, non-rig-scoped terminal route family. Mounted at `/api/terminal`. */
export function terminalRoutes(): Hono {
  const app = new Hono();

  app.post("/open", async (c) => {
    const svc = getService(c);
    if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body_invalid", hint: "expected a JSON object { provider?, view }" }, 400);
    }
    const { provider, view } = readOpenBody(raw);
    const result = await svc.openView({ ...(provider !== undefined ? { provider } : {}), view: view ?? "" });
    return c.json(result, statusForOpen(result.ok, result.code));
  });

  app.get("/views", async (c) => {
    const svc = getService(c);
    if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
    return c.json(await svc.listViews());
  });

  app.get("/status", async (c) => {
    const svc = getService(c);
    if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
    const provider = c.req.query("provider");
    return c.json(await svc.status(provider));
  });

  return app;
}

/**
 * The rig-scoped THIN ALIAS. Mounted at `/api/rigs/:rigId/terminal`, so `POST
 * /api/rigs/:rigId/terminal/open` composes `view = rig:<rigId>` and delegates
 * to the same canonical `TerminalService.openView` — no composition logic here
 * (arch R1 / guard b1). A `provider` may still ride in the body.
 */
export const rigTerminalRoutes = new Hono();

rigTerminalRoutes.post("/open", async (c) => {
  const svc = getService(c);
  if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
  const rigId = c.req.param("rigId");
  if (!rigId) return c.json({ error: "rig_id_required" }, 400);
  let provider: string | undefined;
  try {
    const raw = (await c.req.json()) as unknown;
    if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>)["provider"] === "string") {
      provider = (raw as Record<string, unknown>)["provider"] as string;
    }
  } catch {
    // An empty/absent body is fine for the alias — the view is the rig itself.
  }
  const result = await svc.openView({ ...(provider !== undefined ? { provider } : {}), view: `rig:${rigId}` });
  return c.json(result, statusForOpen(result.ok, result.code));
});
