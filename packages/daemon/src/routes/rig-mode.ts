// Slice 09 — Rig Policy (operator context mode) HTTP routes.
//
// Surface (binding-related ONLY — HG-SAFE):
//   GET    /api/rig-mode/bindings                      — list bindings
//   GET    /api/rig-mode/bindings/:scope/:qualifier?   — read one binding
//   PUT    /api/rig-mode/bindings/:scope/:qualifier?   — upsert (operator)
//   DELETE /api/rig-mode/bindings/:scope/:qualifier?   — unset (operator)
//   GET    /api/rig-mode/effective                     — resolve effective
//                                                          (?rig=&project=&mission=&workstream=&qitem=)
//   GET    /api/rig-mode/defaults                      — recommended
//                                                          per-mode 8×7
//                                                          + default scope
//                                                          + DEFAULT_STALE_RULE
//
// Authority (HG-4): write verbs (PUT / DELETE) require the daemon's
// operator bearer (same posture as mission-control). Reads are open
// (within the daemon's existing loopback/tailnet/bearer model). There
// is NO agent-set code path — the route mounts the bearer middleware
// on write verbs only; agents calling read endpoints must use the same
// auth the daemon already enforces at the listen layer.
//
// HG-SAFE preserved: this router NEVER touches permission allowlists /
// runtime configs / auth tokens / tmux / lifecycle. It calls a single
// store (RigModeStore) whose surface area is itself binding-limited.

import { Hono, type Context } from "hono";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { bindingCategory, type BindingCategory, type RigModeStore } from "../domain/rig-mode/rig-mode-store.js";
import type { OperatingPostureService } from "../domain/rig-mode/operating-posture.js";
import {
  OPERATOR_CONTEXT_MODES,
  OPERATOR_CONTEXT_SCOPES,
  SCOPE_SPECIFICITY,
  type OperatorContextMode,
  type OperatorContextScope,
} from "../domain/rig-mode/rig-mode-types.js";
import {
  DEFAULT_STALE_RULE,
  RECOMMENDED_DEFAULT_SCOPE,
  RECOMMENDED_MODE_DEFAULTS,
} from "../domain/rig-mode/rig-mode-defaults.js";

const POSTURE_MODES = OPERATOR_CONTEXT_MODES.filter((m) => bindingCategory(m) === "posture");
const LEGACY_MODES = OPERATOR_CONTEXT_MODES.filter((m) => bindingCategory(m) === "mode");

export interface RigModeRoutesOpts {
  /** Operator bearer token (same one Mission Control uses). When null,
   * the daemon's listen layer is loopback-only and write verbs pass
   * through; non-null requires `Authorization: Bearer <token>`. */
  bearerToken?: string | null;
}

const VALID_SCOPES = new Set<string>(OPERATOR_CONTEXT_SCOPES);

function parseScope(raw: string): OperatorContextScope | null {
  return VALID_SCOPES.has(raw) ? (raw as OperatorContextScope) : null;
}

interface ScopeQualifierOk {
  ok: true;
  scope: OperatorContextScope;
  qualifier: string | null;
}
interface ScopeQualifierErr {
  ok: false;
  status: 400;
  body: { error: string; hint: string };
}

/**
 * Parse + validate `:scope` / `:qualifier` path params. Rejects:
 *   - unknown scope name                          → scope_invalid
 *   - global_host scope WITH a non-empty qualifier → qualifier_forbidden
 *     (prevents hidden scope inference / mutation on the global-host
 *     binding — guard BLOCKER 2)
 *   - non-global scope WITHOUT a qualifier        → qualifier_required
 *
 * Used by every route verb so GET / PUT / DELETE share the exact same
 * parse rules. No silent qualifier-dropping anywhere on a write path.
 */
function parseScopeAndQualifier(scopeRaw: string, qualifierRaw: string | undefined): ScopeQualifierOk | ScopeQualifierErr {
  const scope = parseScope(scopeRaw);
  if (!scope) {
    return {
      ok: false,
      status: 400,
      body: { error: "scope_invalid", hint: `Unknown scope. Allowed: ${OPERATOR_CONTEXT_SCOPES.join(", ")}.` },
    };
  }
  if (scope === "global_host") {
    if (qualifierRaw !== undefined && qualifierRaw.length > 0) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "qualifier_forbidden",
          hint: "Global-host bindings cannot carry a qualifier. Use /api/rig-mode/bindings/global_host with no trailing path segment.",
        },
      };
    }
    return { ok: true, scope, qualifier: null };
  }
  if (qualifierRaw === undefined || qualifierRaw.length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "qualifier_required",
        hint: `Scope ${scope} requires a qualifier (rig/project/qitem ID or project/mission[/slice-id]).`,
      },
    };
  }
  return { ok: true, scope, qualifier: qualifierRaw };
}

function getStore(c: { get: (key: string) => unknown }): RigModeStore | null {
  const store = c.get("rigModeStore" as never) as RigModeStore | undefined;
  return store ?? null;
}

export function rigModeRoutes(opts?: RigModeRoutesOpts): Hono {
  const router = new Hono();
  const bearer = opts?.bearerToken ?? null;
  const requireOperator = authBearerTokenMiddleware({ expectedToken: bearer });

  // -- read: defaults --------------------------------------------------
  router.get("/defaults", (c) => {
    return c.json({
      recommendedModeDefaults: RECOMMENDED_MODE_DEFAULTS,
      recommendedDefaultScope: RECOMMENDED_DEFAULT_SCOPE,
      defaultStaleRule: DEFAULT_STALE_RULE,
    });
  });

  // -- read: list ------------------------------------------------------
  router.get("/bindings", (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    return c.json({ bindings: store.listBindings() });
  });

  // -- read: resolveEffective ------------------------------------------
  router.get("/effective", (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    const rigId = c.req.query("rig");
    const projectId = c.req.query("project");
    const missionId = c.req.query("mission");
    const workstreamId = c.req.query("workstream");
    const qitemId = c.req.query("qitem");
    const input = { rigId, projectId, missionId, workstreamId, qitemId };
    const service = c.get("operatingPosture" as never) as OperatingPostureService | undefined;
    const operatingPosture = service?.resolve(input) ?? {
      posture: "unknown", source: "unknown", context: null, binding: null,
      reason: "Operating posture resolver unavailable.", grantsAuthority: false,
    };
    let resolved;
    try {
      // Keep pre-existing ergonomic bindings addressed by raw names readable.
      const raw = store.resolveEffective(input);
      const canonical = store.resolveEffective(operatingPosture.context ?? input);
      resolved = !raw || (canonical && SCOPE_SPECIFICITY[canonical.resolvedScope] > SCOPE_SPECIFICITY[raw.resolvedScope]) ? canonical : raw;
    }
    catch { return c.json({ effective: null, posture: "unknown_posture", operatingPosture }); }
    // Q6 — null = unknown_posture; do NOT silently default. Surface to caller.
    if (!resolved) {
      return c.json({
        effective: null,
        operatingPosture,
        posture: "unknown_posture",
        hint: "No binding matches this read context. Per convention §Q6 callers MUST treat this as unknown_posture (do not default to desk).",
      });
    }
    // Each category's own effective binding, read the way `effective` is (raw names and canonical ids, the more
    // specific wins), so a saved mode and a posture kept side by side both show.
    const ofCategory = (modes: readonly OperatorContextMode[]) => {
      try {
        const raw = store.resolveEffective(input, modes);
        const canonical = store.resolveEffective(operatingPosture.context ?? input, modes);
        const pick = !raw || (canonical && SCOPE_SPECIFICITY[canonical.resolvedScope] > SCOPE_SPECIFICITY[raw.resolvedScope]) ? canonical : raw;
        return pick?.binding ?? null;
      } catch { return null; }
    };
    const categories = { mode: ofCategory(LEGACY_MODES), posture: ofCategory(POSTURE_MODES) };
    return c.json({ effective: resolved, posture: "known", operatingPosture, categories });
  });

  // -- read: one binding (qualifier path-optional via /:scope or /:scope/:qualifier)
  router.get("/bindings/:scope/:qualifier?", (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    const parsed = parseScopeAndQualifier(c.req.param("scope"), c.req.param("qualifier"));
    if (!parsed.ok) return c.json(parsed.body, parsed.status);
    // ?for=mode|posture: the bindings at the target a write of that category would land on, resolved as the write
    // resolves it (a posture through the same canonicalisation, a saved mode as given), named in `writeTarget`.
    const forRaw = c.req.query("for");
    if (forRaw !== undefined) {
      if (forRaw !== "mode" && forRaw !== "posture") return c.json({ error: "category_invalid", hint: "for is mode or posture." }, 400);
      let target = parsed.qualifier;
      if (forRaw === "posture") {
        const service = c.get("operatingPosture" as never) as OperatingPostureService | undefined;
        if (!service) return c.json({ error: "operating_posture_unavailable" }, 503);
        try { target = service.target(parsed.scope, target); }
        catch (error) { return c.json({ error: "scope_unresolved", hint: String(error) }, 400); }
      }
      return c.json({ writeTarget: `${parsed.scope}:${target ?? "host"}`, bindings: store.getBindings(parsed.scope, target) });
    }
    let qualifier = parsed.qualifier;
    let binding = store.getBinding(parsed.scope, qualifier);
    if (!binding) {
      const service = c.get("operatingPosture" as never) as OperatingPostureService | undefined;
      if (service) {
        try { qualifier = service.target(parsed.scope, parsed.qualifier); binding = store.getBinding(parsed.scope, qualifier); }
        catch (error) { return c.json({ error: "scope_unresolved", hint: String(error) }, 400); }
      }
    }
    if (!binding) return c.json({ error: "not_found" }, 404);
    // `binding` is the latest set here; `bindings` is each category kept at this target.
    return c.json({ binding, bindings: store.getBindings(parsed.scope, qualifier) });
  });

  // -- write: upsert (operator-only) -----------------------------------
  router.put("/bindings/:scope/:qualifier?", requireOperator, async (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    const parsed = parseScopeAndQualifier(c.req.param("scope"), c.req.param("qualifier"));
    if (!parsed.ok) return c.json(parsed.body, parsed.status);
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object") {
      return c.json({
        error: "body_required",
        hint: "PUT body must be { mode: <supported mode>, record: <10-field OperatorContextModeRecord> }.",
      }, 400);
    }
    const { mode, record } = body as { mode?: unknown; record?: unknown };
    if (mode === undefined || record === undefined) {
      return c.json({
        error: "body_shape_invalid",
        hint: "PUT body must be { mode: <supported mode>, record: <10-field OperatorContextModeRecord> }.",
      }, 400);
    }
    let qualifier = parsed.qualifier;
    if (mode === "human-led" || mode === "delegated") {
      const service = c.get("operatingPosture" as never) as OperatingPostureService | undefined;
      if (!service) return c.json({ error: "operating_posture_unavailable" }, 503);
      try { qualifier = service.target(parsed.scope, qualifier); }
      catch (error) { return c.json({ error: "scope_unresolved", hint: String(error) }, 400); }
    }
    const result = store.setBinding(parsed.scope, qualifier, mode, record);
    if (!result.ok) {
      return c.json({ error: "validation_failed", errors: result.errors }, 400);
    }
    return c.json({ binding: result.binding });
  });

  // -- write: delete (operator-only) -----------------------------------
  // An unset of one category is addressed by path: a daemon without categories has no such route and answers a plain
  // 404 without deleting anything (its own DELETE ignores a query parameter and would remove whatever is stored).
  router.delete("/bindings/:scope/categories/:category", requireOperator, (c) =>
    c.req.param("scope") === "global_host"
      ? unset(c, "global_host", undefined, c.req.param("category"))
      : c.json({ error: "qualifier_required", hint: "Only global_host takes a category without a qualifier." }, 400));
  router.delete("/bindings/:scope/:qualifier/categories/:category", requireOperator, (c) =>
    unset(c, c.req.param("scope"), c.req.param("qualifier"), c.req.param("category")));
  router.delete("/bindings/:scope/:qualifier?", requireOperator, (c) =>
    unset(c, c.req.param("scope"), c.req.param("qualifier"), c.req.query("category")));

  function unset(c: Context, scopeRaw: string, qualifierRaw: string | undefined, categoryRaw: string | undefined) {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    const parsed = parseScopeAndQualifier(scopeRaw, qualifierRaw);
    if (!parsed.ok) return c.json(parsed.body, parsed.status);
    if (categoryRaw !== undefined && categoryRaw !== "mode" && categoryRaw !== "posture") {
      return c.json({ error: "category_invalid", hint: "category is mode or posture; omit it to remove the latest set binding at this target." }, 400);
    }
    const category = categoryRaw as BindingCategory | undefined;
    let qualifier = parsed.qualifier;
    if (!store.getBindings(parsed.scope, qualifier).some((b) => !category || bindingCategory(b.mode) === category)) {
      const service = c.get("operatingPosture" as never) as OperatingPostureService | undefined;
      if (service) {
        try { qualifier = service.target(parsed.scope, qualifier); }
        catch (error) { return c.json({ error: "scope_unresolved", hint: String(error) }, 400); }
      }
    }
    const gone = store.removeBinding(parsed.scope, qualifier, category);
    if (!gone) return c.json({ removed: false });
    // The other category kept at this target, if any.
    const remaining = store.getBinding(parsed.scope, qualifier);
    return c.json({ removed: true, category: bindingCategory(gone.mode), remaining });
  }

  return router;
}
