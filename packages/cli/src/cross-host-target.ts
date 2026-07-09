import { loadHostRegistry, resolveHost } from "./host-registry.js";

/**
 * OPR.0.4.6.MH4 §4 — the host-qualified TARGET sugar + precedence contract,
 * uniform across the cross-host coordination verbs (send / capture /
 * transcript; broadcast has NO session-target operand — its positional is
 * message text, which must never be sugar-parsed — so it takes `--host` +
 * the persisted selection only).
 *
 * Sugar parse rule (CLI edge ONLY — BR-1: the daemon never sees a 3-part
 * session string either way):
 *   - A target of the form `X@Y@Z` is host-qualified IFF `Z` matches a
 *     REGISTERED host id after registry load; then target=`X@Y`, host=`Z`.
 *   - If `Z` matches no registered host (or the registry cannot load), the
 *     string passes through UNCHANGED — it fails exactly as today
 *     (adopted/raw session names containing `@` keep working). The returned
 *     `hint` is appended to the eventual failure surface so a mistyped
 *     3-part form always dies LOUD with the host named (never a silent
 *     fallthrough). This is deliberately DIFFERENT from MH-3's queue rule
 *     (canonical-only destinations always-strip post-classifier); the
 *     per-verb-class split is documented in cli-reference.md.
 *   - Reserved ids (kernel/host/local) can never be registered
 *     (RESERVED_HOST_IDS), so `@kernel`/`@host` human-seat forms can never
 *     be captured by the sugar.
 *
 * Precedence (the caller composes with the persisted selection):
 *   explicit `--host` > target sugar > persisted selection
 *   (`resolveEffectiveHost`). `--host X` + sugar `@Y` where X≠Y is a
 *   structured conflict — never a silent precedence pick. The same host
 *   named twice is fine.
 */
export interface CrossHostTargetResolution {
  ok: true;
  /** The target with any matched host qualifier stripped. */
  target: string;
  /** The sugar-derived host id (registered suffix), if any. */
  sugarHost: string | undefined;
  /**
   * Loud-failure hint when the target was 3-part-SHAPED but the suffix
   * matched no registered host. Callers append it to failure surfaces for
   * this target; it never changes behavior on success paths.
   */
  hint: string | undefined;
}

export interface CrossHostTargetConflict {
  ok: false;
  error: string;
}

export function resolveCrossHostTarget(
  rawTarget: string,
  explicitHost: string | undefined,
  registryLoader?: () => ReturnType<typeof loadHostRegistry>,
): CrossHostTargetResolution | CrossHostTargetConflict {
  const atCount = rawTarget.split("@").length - 1;
  if (atCount < 2) {
    return { ok: true, target: rawTarget, sugarHost: undefined, hint: undefined };
  }

  const lastAt = rawTarget.lastIndexOf("@");
  const base = rawTarget.slice(0, lastAt);
  const suffix = rawTarget.slice(lastAt + 1);

  const unregisteredHint = suffix.length > 0
    ? `no registered host '${suffix}' — if '${suffix}' was meant as a host, check \`rig host ls\``
    : undefined;

  if (suffix.length === 0 || base.length === 0) {
    return { ok: true, target: rawTarget, sugarHost: undefined, hint: unregisteredHint };
  }

  const loader = registryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    // No registry = no registered suffix can match; pass through unchanged
    // (the plain-target behavior must not gain a new failure mode).
    return { ok: true, target: rawTarget, sugarHost: undefined, hint: unregisteredHint };
  }

  const resolved = resolveHost(registry.registry, suffix);
  if (!resolved.ok) {
    return { ok: true, target: rawTarget, sugarHost: undefined, hint: unregisteredHint };
  }

  if (explicitHost !== undefined && explicitHost !== suffix) {
    return {
      ok: false,
      error: `ambiguous host: --host ${explicitHost} conflicts with the target's host qualifier @${suffix} — name one host`,
    };
  }

  return { ok: true, target: base, sugarHost: suffix, hint: undefined };
}
