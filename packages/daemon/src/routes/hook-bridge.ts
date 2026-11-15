// Slice 13: the hook bridge's routes.
//
// - /seat/:seatRef reads and sets a seat's opt-in. The actor comes from the transport header, never the body; a terminal
//   with no seat identity is recorded as unattributed, as the typing guard records it.
// - The waiter's routes (arm, poll, ack, turn, expired) accept what the activity hooks accept, with their checks: the
//   install-wide hook token, or the seat's own activity grant, bound as the activity route binds it once the body has
//   arrived (revoked, a run's standing, its runtime, its seat and generation). A waiter must name the seat's current
//   occupant generation, so a replaced occupant's waiter is refused and exits.
import { Hono, type Context } from "hono";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { AgentActivityStore } from "../domain/agent-activity-store.js";
import { HOOK_BRIDGE_EXPIRE_MARGIN_SECONDS, HOOK_BRIDGE_TIMEOUT_SECONDS, HookBridgeError, UNATTRIBUTED_ACTOR, type HookBridge } from "../domain/hook-bridge.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import { activityPrincipal, bindToGrant } from "./activity.js";
import { transportSenderSession } from "./require-sender-identity.js";

export const hookBridgeRoutes = new Hono();

const bridgeOf = (c: Context) => c.get("hookBridge" as never) as HookBridge | undefined;
const guardOf = (c: Context) => (c.get("tmuxAdapter" as never) as TmuxAdapter | undefined)?.deliveryGuard;

function unavailable(c: Context) {
  return c.json({ ok: false, code: "hook_bridge_unavailable", error: "This daemon has no hook bridge." }, 503);
}

hookBridgeRoutes.get("/seat/:seatRef", (c) => {
  const bridge = bridgeOf(c);
  const guard = guardOf(c);
  if (!bridge || !guard) return unavailable(c);
  try {
    const target = guard.target(c.req.param("seatRef"));
    return c.json({ ok: true, session: target.session, ...bridge.status(target.nodeId, target.occupant) });
  } catch (error) {
    return c.json({ ok: false, code: (error as { code?: string }).code ?? "guard_target_unknown", error: (error as Error).message }, 404);
  }
});

hookBridgeRoutes.post("/seat/:seatRef", async (c) => {
  const bridge = bridgeOf(c);
  const guard = guardOf(c);
  if (!bridge || !guard) return unavailable(c);
  const parsed = await c.req.json<unknown>().catch(() => null);
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const actor = transportSenderSession(c) ?? UNATTRIBUTED_ACTOR;
  if (typeof body.enabled !== "boolean") return c.json({ ok: false, code: "invalid_hook_bridge", error: "enabled must be true or false." }, 400);
  if (typeof body.reason !== "string" || !body.reason.trim()) return c.json({ ok: false, code: "hook_bridge_reason_required", error: "A reason is required." }, 400);
  try {
    const target = guard.target(c.req.param("seatRef"));
    const preference = bridge.setPreference(target.nodeId, body.enabled, actor, body.reason);
    return c.json({ ok: true, session: target.session, preference,
      note: body.enabled ? "Takes effect when this seat is next launched or restored; until its waiter arms, delivery is typed as before."
        : "Off now: new messages are typed. A running occupant keeps its hooks until it is next launched; its waiter gets nothing." });
  } catch (error) {
    const code = error instanceof HookBridgeError ? error.code : (error as { code?: string }).code ?? "guard_target_unknown";
    return c.json({ ok: false, code, error: (error as Error).message }, error instanceof HookBridgeError ? 400 : 404);
  }
});

/** The waiter's seat: authenticated like an activity hook, and naming the seat's current occupant. `recheck` runs the same
 *  checks again (the grant read afresh, the occupant), for a route that waits before it acts. */
async function waiter(c: Context): Promise<{ bridge: HookBridge; nodeId: string; sessionName: string; generation: string | null; body: Record<string, unknown>;
  recheck: () => Response | null } | Response> {
  const bridge = bridgeOf(c);
  const store = c.get("agentActivityStore" as never) as AgentActivityStore | undefined;
  const registry = c.get("sessionRegistry" as never) as SessionRegistry | undefined;
  const guard = guardOf(c);
  if (!bridge || !store || !registry || !guard) return unavailable(c);
  const principal = activityPrincipal(c, store, c.get("activityHookToken" as never) as string | undefined);
  if ("refused" in principal) return principal.refused;
  // A body that isn't a JSON object (null, an array, a number) names no seat: it's refused below, never a crash.
  const parsed = await c.req.json<unknown>().catch(() => null);
  const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  // Synchronous: nothing is awaited between these checks and what the route does next.
  const authorize = (): Response | { nodeId: string; sessionName: string; generation: string | null; body: Record<string, unknown> } => {
    let body = raw;
    if (principal.grant) {
      const bound = bindToGrant(c, store, principal.grant, body);
      if ("refused" in bound) return bound.refused;
      body = bound.body;
    }
    const sessionName = typeof body.sessionName === "string" ? body.sessionName : "";
    let target;
    try { target = guard.target(sessionName); } catch { return c.json({ ok: false, code: "hook_bridge_seat_unknown", error: "This seat isn't known here." }, 404); }
    if ((principal.grant && principal.grant.nodeId !== target.nodeId) || (typeof body.nodeId === "string" && body.nodeId !== target.nodeId)) {
      return c.json({ ok: false, code: "hook_bridge_seat_mismatch", error: "This waiter speaks for another seat." }, 403);
    }
    const generation = typeof body.generation === "string" ? body.generation : null;
    const current = registry.currentOccupantTenure(target.nodeId)?.generationUuid ?? null;
    if (generation !== current) return c.json({ ok: false, code: "hook_bridge_stale_occupant", stop: true, error: "This waiter's occupant was replaced." }, 409);
    return { nodeId: target.nodeId, sessionName: target.session, generation, body };
  };
  const admitted = authorize();
  if (admitted instanceof Response) return admitted;
  const recheck = () => {
    const again = authorize();
    if (again instanceof Response) return again;
    return again.nodeId === admitted.nodeId && again.generation === admitted.generation ? null
      : c.json({ ok: false, code: "hook_bridge_stale_occupant", stop: true, error: "This waiter's occupant was replaced." }, 409);
  };
  return { bridge, ...admitted, recheck };
}

hookBridgeRoutes.post("/arm", async (c) => {
  const w = await waiter(c);
  if (w instanceof Response) return w;
  const pref = w.bridge.preference(w.nodeId);
  if (!pref?.desired) return c.json({ ok: true, stop: true, reason: "This seat isn't opted in to the hook bridge." });
  const hookEvent = typeof w.body.hookEvent === "string" ? w.body.hookEvent : "unknown";
  const { armId } = w.bridge.arm({ nodeId: w.nodeId, sessionName: w.sessionName, generation: w.generation, hookEvent,
    ...(typeof w.body.armId === "string" ? { armId: w.body.armId } : {}) });
  return c.json({ ok: true, armId, expireAfterSeconds: HOOK_BRIDGE_TIMEOUT_SECONDS - HOOK_BRIDGE_EXPIRE_MARGIN_SECONDS });
});

hookBridgeRoutes.post("/poll", async (c) => {
  const w = await waiter(c);
  if (w instanceof Response) return w;
  if (typeof w.body.armId !== "string") return c.json({ ok: false, code: "invalid_hook_bridge", error: "armId required." }, 400);
  // Under the seat's delivery lease: a typed send to the seat finishes before this poll can take what's queued behind it.
  // The waiter's checks run again once the lease is held, right before the claim.
  const answer = await w.bridge.pollUnderLease(w.nodeId, w.body.armId, w.recheck);
  if ("refused" in answer) return answer.refused;
  return c.json({ ok: true, ...answer });
});

hookBridgeRoutes.post("/ack", async (c) => {
  const w = await waiter(c);
  if (w instanceof Response) return w;
  if (typeof w.body.armId !== "string" || typeof w.body.batchId !== "string") return c.json({ ok: false, code: "invalid_hook_bridge", error: "armId and batchId required." }, 400);
  return c.json({ ok: true, ...w.bridge.ack(w.nodeId, w.sessionName, w.generation, w.body.armId, w.body.batchId) });
});

hookBridgeRoutes.post("/turn", async (c) => {
  const w = await waiter(c);
  if (w instanceof Response) return w;
  w.bridge.turnStarted(w.nodeId);
  return c.json({ ok: true });
});

hookBridgeRoutes.post("/expired", async (c) => {
  const w = await waiter(c);
  if (w instanceof Response) return w;
  if (typeof w.body.armId !== "string") return c.json({ ok: false, code: "invalid_hook_bridge", error: "armId required." }, 400);
  w.bridge.expired(w.nodeId, w.sessionName, w.body.armId);
  return c.json({ ok: true });
});
