// Slice-03 Atom 6b — the shared context-ref resolver for the delivery flags.
// `--context` (rig send / rig broadcast) and `--body-context` (rig queue create)
// all resolve a path-like ref to its WHOLE plain content (the compose output),
// enforcing the SAME all-or-nothing missing-member contract that `rig walk` uses:
// a missing/unreadable pack member is known up-front, so it aborts BEFORE any
// delivery — never a partial/silent context. Reuses the 6a pieces route (which
// now also returns `text`/`bytes` via the sealed assemblePlainFiles).

import type { DaemonClient } from "./client.js";

interface RefPiecesWire {
  ref: string;
  text?: string;
  bytes?: number;
  missingFiles?: Array<{ path: string; role?: string }>;
  error?: string;
  message?: string;
}

export interface ResolvedContext {
  ref: string;
  text: string;
  bytes: number;
}

/** Advisory size threshold: a resolved context larger than this is "walk-sized"
 *  — better paced with `rig walk` than blasted into a pane as one paste (§4). */
export const WALK_SIZED_THRESHOLD_BYTES = 8_192;

export async function resolveContextRef(client: DaemonClient, ref: string): Promise<ResolvedContext> {
  const res = await client.get<RefPiecesWire>(
    `/api/context-packs/library/by-ref/pieces?ref=${encodeURIComponent(ref)}`,
  );
  if (res.status === 404) {
    throw new Error(`Context pack '${ref}' not found in library. Run 'rig context list' to see the available refs.`);
  }
  if (res.status === 400) {
    throw new Error(res.data?.message ?? `Unsafe context ref '${ref}'.`);
  }
  if (res.status !== 200) {
    throw new Error(`Daemon returned HTTP ${res.status} resolving context ref '${ref}'.`);
  }
  // All-or-nothing: a missing/unreadable member aborts before any delivery.
  const missing = res.data.missingFiles ?? [];
  if (missing.length > 0) {
    throw new Error(
      `Context pack '${ref}' has ${missing.length} missing/unreadable member(s): ${missing.map((m) => m.path).join(", ")}. ` +
        `Fix the pack (or its files) and re-run — a delivery carries the whole context or none.`,
    );
  }
  const text = res.data.text ?? "";
  const bytes = typeof res.data.bytes === "number" ? res.data.bytes : Buffer.byteLength(text, "utf8");
  return { ref, text, bytes };
}

/** The §4 size warn: when a resolved --context is walk-sized, advise pacing it
 *  with `rig walk` instead of one paste. Advisory — never blocks the send. */
export function walkSizedWarning(resolved: ResolvedContext, seat?: string): string | null {
  if (resolved.bytes <= WALK_SIZED_THRESHOLD_BYTES) return null;
  const target = seat ?? "<seat>";
  return `context '${resolved.ref}' is ${resolved.bytes} bytes — this is walk-sized. Consider 'rig walk ${target} --through ${resolved.ref}' to pace it instead of one paste.`;
}
