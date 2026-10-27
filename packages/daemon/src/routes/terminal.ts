import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
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
import type { FollowControls } from "../domain/terminal/terminal-follow-policy.js";

function readFollowControls(raw: Record<string, unknown>): FollowControls | { error: string } {
  if (typeof raw.enabled !== "boolean") return { error: "enabled must be true or false." };
  const controls: FollowControls = { enabled: raw.enabled };
  for (const [name, maximum] of [["maxTiles", 256], ["graceMs", 60000], ["focusRetentionMs", 300000], ["suppressionMs", 86400000]] as const) {
    const value = raw[name];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < (name === "maxTiles" ? 1 : 0) || (value as number) > maximum) return { error: `${name} is outside its supported range.` };
    controls[name] = value as number;
  }
  for (const name of ["pin", "unpin", "suppress", "unsuppress"] as const) {
    const value = raw[name];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > 256 || value.some(seat => typeof seat !== "string" || !seat.trim() || seat.length > 256 || /[\x00-\x1f\x7f]/.test(seat))) return { error: `${name} must be an array of seat names.` };
    controls[name] = value as string[];
  }
  return controls;
}

function getService(c: { get(key: string): unknown }): TerminalService | null {
  return (c.get("terminalService" as never) as TerminalService | undefined) ?? null;
}

/** Map a service OpenViewResult code to an HTTP status (body is always the full result). */
function statusForOpen(ok: boolean, code: string | undefined): 200 | 400 | 404 | 409 {
  if (ok) return 200;
  if (code === "view_required" || code === "unknown_provider") return 400;
  if (code === "invalid_terminal_session" || code === "unsupported_terminal_session") return 400;
  if (code === "view_not_found") return 404;
  if (code === "preview_changed") return 409;
  // provider-unavailable / layout-unsupported / honest-partial: a truthful 200 body.
  return 200;
}

/** Parse the `{ provider?, view }` open body honestly (a non-object / missing view → structured 400 upstream). */
function readOpenBody(raw: unknown): { provider?: string; session?: string; view?: string; expectedPlan?: string; viewportColumns?: number } | { error: string } {
  if (raw === null || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  if (obj["session"] !== undefined && typeof obj["session"] !== "string") return { error: "session must be a session name string." };
  const provider = typeof obj["provider"] === "string" ? (obj["provider"] as string) : undefined;
  const view = typeof obj["view"] === "string" ? (obj["view"] as string) : undefined;
  const expectedPlan = typeof obj["expectedPlan"] === "string" ? obj["expectedPlan"] : undefined;
  const viewportColumns = typeof obj["viewportColumns"] === "number" ? obj["viewportColumns"] : undefined;
  return { ...(provider !== undefined ? { provider } : {}), ...(obj["session"] !== undefined ? { session: obj["session"] as string } : {}), ...(view !== undefined ? { view } : {}), ...(expectedPlan !== undefined ? { expectedPlan } : {}), ...(viewportColumns !== undefined ? { viewportColumns } : {}) };
}

/** The canonical, non-rig-scoped terminal route family. Mounted at `/api/terminal`. */
export function terminalRoutes(opts?: { bearerToken?: string | null }): Hono {
  const app = new Hono();

  // Following provisions writable local viewers under the same owner boundary
  // as ensure-viewer. Existing one-shot open keeps its current route posture.
  app.post("/follow", authBearerTokenMiddleware({ expectedToken: opts?.bearerToken ?? null }), async c => {
    const svc = getService(c);
    if (!svc) return c.json({ ok: false, code: "terminal_service_unavailable" }, 503);
    const raw = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!raw || Array.isArray(raw) || typeof raw !== "object") return c.json({ ok: false, code: "body_invalid" }, 400);
    const parsed = readOpenBody(raw);
    const controls = readFollowControls(raw);
    if ("error" in parsed || "error" in controls) return c.json({ ok: false, code: "body_invalid", error: "error" in parsed ? parsed.error : (controls as { error: string }).error }, 400);
    const result = await svc.followView({ ...parsed, view: parsed.view ?? "", ...controls });
    return c.json(result, statusForOpen(result.ok, result.code));
  });

  app.post("/open", async (c) => {
    const svc = getService(c);
    if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body_invalid", hint: "expected a JSON object { provider?, view }" }, 400);
    }
    const body = readOpenBody(raw);
    if ("error" in body) return c.json({ code: "invalid_terminal_session", error: body.error }, 400);
    const result = await svc.openView({ ...body, view: body.view ?? "" });
    return c.json(result, statusForOpen(result.ok, result.code));
  });

  app.post("/viewer/ensure", authBearerTokenMiddleware({ expectedToken: opts?.bearerToken ?? null }), async c => {
    const svc = getService(c);
    if (!svc) return c.json({ ok: false, code: "terminal_service_unavailable" }, 503);
    const raw = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return c.json({ ok: false, code: "body_invalid" }, 400);
    const parsed = readOpenBody(raw);
    const member = raw.member as { hostId?: unknown; nodeId?: unknown } | undefined;
    if ("error" in parsed || !member || typeof member.hostId !== "string" || !member.hostId.trim()
      || typeof member.nodeId !== "string" || !member.nodeId.trim() || typeof raw.expectedPlan !== "string" || !raw.expectedPlan) {
      return c.json({ ok: false, code: "body_invalid", error: "Expected view, member:{hostId,nodeId}, and expectedPlan from the current preview." }, 400);
    }
    const result = await svc.ensureViewer({ ...parsed, view: parsed.view ?? "", expectedPlan: raw.expectedPlan,
      member: { hostId: member.hostId, nodeId: member.nodeId } });
    return c.json(result, result.ok ? 200 : result.code === "preview_changed" ? 409 : result.code === "view_not_found" ? 404 : 200);
  });

  app.get("/views", async (c) => {
    const svc = getService(c);
    if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
    return c.json(await svc.listViews(c.req.query("detail") === "1"));
  });

  app.get("/preview", async (c) => {
    const svc = getService(c);
    if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
    const width = c.req.query("viewportColumns");
    const session = c.req.query("session");
    const result = await svc.previewView({ view: c.req.query("view") ?? "", provider: c.req.query("provider"), ...(session !== undefined ? { session } : {}), ...(width !== undefined ? { viewportColumns: Number(width) } : {}) });
    return c.json(result, "planId" in result ? 200 : statusForOpen(result.ok, result.code));
  });

  app.get("/status", async (c) => {
    const svc = getService(c);
    if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
    const provider = c.req.query("provider");
    const session = c.req.query("session");
    const result = session === undefined ? await svc.status(provider) : await svc.status(provider, session);
    return c.json(result, result.code ? statusForOpen(false, result.code) : 200);
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
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    // An empty/absent body is fine for the alias — the view is the rig itself.
  }
  const body = readOpenBody(raw);
  if ("error" in body) return c.json({ code: "invalid_terminal_session", error: body.error }, 400);
  const result = await svc.openView({ ...body, view: `rig:${rigId}` });
  return c.json(result, statusForOpen(result.ok, result.code));
});
