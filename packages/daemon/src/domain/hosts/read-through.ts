// OPR.0.4.6.MH2 FR-2 + FR-7 — the general single-host READ-THROUGH.
//
// The read twin of the shipped forward-then-strip write pattern
// (routes/mission-control.ts remote-forward leg): the browser stays
// same-origin against the LOCAL daemon; a `?host=<id>` query param is the
// out-of-band host envelope (MH-1 BR-1 rail — host never rides in a path or
// session identity). The daemon edge consumes the envelope: resolve the
// registry, forward the SAME path (envelope stripped) to the origin daemon
// over the shared bearer transport, and return the origin's response
// VERBATIM — status + content-type + body untouched (arch P3). Origin
// shapes stay the law: no AggregatedPayload wrapping on single-host reads.
//
// READ-ONLY IS ENFORCED HERE, AT THE EDGE (FR-7, arch R2): a non-GET
// request carrying a remote host envelope, or a GET outside the named
// allowlist below, is REFUSED with a structured error naming the MH-3
// boundary and is NEVER forwarded. The UI hiding mutation affordances is
// necessary but not the enforcement.
//
// local / absent host param short-circuits to the existing handler before
// any of this logic runs — the local path is unchanged by construction
// (FR-2 zero-regression negative).

import type { Context, Next } from "hono";
import { LOCAL_HOST_ID } from "./fanout-contract.js";
import { loadHostRegistry, resolveHost } from "./hosts-registry-reader.js";
import { remoteRawRequest } from "./remote-daemon-http.js";

// The 5s single-host READ deadline class (matches the shipped aggregate
// read class in attention-aggregator.ts; deadline is a REQUIRED arg on the
// transport by arch ruling — named here, passed explicitly at the call).
export const READ_THROUGH_TIMEOUT_MS = 5_000;

// THE NAMED CLOSED ALLOWLIST (arch P1). One exported constant; additions
// are deliberate cross-review extensions, never drive-by edits — flag arch.
// Grammar: `:seg` matches exactly one non-empty path segment; a trailing
// `/*` matches one-or-more tail segments. v1 = the MVP read screens
// (topology / project / library / dashboard-ps) exactly.
//
// DELIBERATE EXCLUSIONS (recorded, not oversights): /api/queue/* (queue is
// the MH-3 lane — MH-1's queue-negative boundary, read included for now);
// /api/files/* (local FS discovery; the twin derives remote missions from
// the host-keyed slice list instead); /api/slices/:name/proof-asset/*
// (binary — the raw transport is text-only by design);
// /api/specs/library/active-lens (a local operator preference with write
// verbs — its literal segment cannot match `:id/review`'s shape).
// NUANCE (pinned by test): the slices REFRESH write is excluded by the
// METHOD tooth, not by path shape — `:name` matches the literal "refresh",
// so a GET there forwards and the origin resolves it as a slice named
// "refresh" (its own 404, verbatim); the POST can never cross the edge.
export const READ_THROUGH_ALLOWLIST = [
  "/api/rigs/summary",
  "/api/rigs/:rigId/graph",
  "/api/rigs/:rigId/nodes",
  // OPR.0.4.6.MH2 rev1-r2 B2 + arch ruling (qitem-…c5402960): seat detail
  // is the LEAF of the FR-2 hierarchy — same read class as its /nodes
  // sibling. STRICT SEGMENT-SHAPE match only (the arch tooth): the deeper
  // ACTION routes under this prefix (…/:logicalId/focus, …/open-cmux)
  // must stay REFUSED — pinned by named negatives.
  "/api/rigs/:rigId/nodes/:logicalId",
  "/api/ps",
  "/api/slices",
  "/api/slices/:name",
  "/api/slices/:name/doc/*",
  "/api/missions/:missionId",
  "/api/specs/library",
  "/api/specs/library/:id/review",
] as const;

export function isReadThroughPath(path: string): boolean {
  const parts = path.split("/").filter((s) => s !== "");
  return READ_THROUGH_ALLOWLIST.some((pattern) => {
    const pat = pattern.split("/").filter((s) => s !== "");
    const tailWild = pat[pat.length - 1] === "*";
    const fixed = tailWild ? pat.slice(0, -1) : pat;
    if (tailWild ? parts.length <= fixed.length : parts.length !== fixed.length) return false;
    return fixed.every((seg, i) => (seg.startsWith(":") ? parts[i] !== "" : seg === parts[i]));
  });
}

const MH3_BOUNDARY_MESSAGE =
  "acting on a remote host is the MH-3 routing lane; the MH-2 read-through forwards allowlisted GET reads only";

/** The param-intercept middleware (arch E2 ruling). Mounted on /api/* ahead
 *  of the route table; consumes the `?host=` envelope for remote reads and
 *  passes everything else through untouched. */
export function hostReadThrough() {
  return async (c: Context, next: Next) => {
    const hostParam = c.req.query("host");
    if (hostParam === undefined || hostParam === "" || hostParam === LOCAL_HOST_ID) {
      return next();
    }
    const hostId = hostParam;
    const path = c.req.path;

    if (c.req.method !== "GET") {
      // FR-7 tooth 1: a mutating request never crosses the edge.
      return c.json(
        { error: "cross_host_write_refused", boundary: "MH-3", hostId, method: c.req.method, path, message: MH3_BOUNDARY_MESSAGE },
        405,
      );
    }
    if (!isReadThroughPath(path)) {
      // FR-7 tooth 2: reads outside the named closed set never cross either.
      return c.json(
        { error: "read_through_path_not_allowed", boundary: "MH-3", hostId, path, message: MH3_BOUNDARY_MESSAGE },
        403,
      );
    }

    // Arch P2 leg 1: registry-validated BEFORE any dial — an unknown id is a
    // structured error, never a blind network attempt. Same injected-loader
    // seam as the write twin (tests swap it; production reads the registry).
    const registryLoader =
      (c.get("hostRegistryLoader" as never) as (() => ReturnType<typeof loadHostRegistry>) | undefined) ?? loadHostRegistry;
    const fetchImpl = c.get("remoteFetchImpl" as never) as typeof fetch | undefined;
    const fail = (detail: string, failureClass: string, remoteStatus?: number) =>
      c.json({ error: "remote_read_failed", hostId, failureClass, ...(remoteStatus !== undefined ? { remoteStatus } : {}), detail }, 502);

    const reg = registryLoader();
    if (!reg.ok) return fail(reg.error, "registry");
    const resolved = resolveHost(reg.registry, hostId);
    if (!resolved.ok) return fail(resolved.error, "unknown-host");
    if (resolved.host.transport !== "http") {
      return fail(`host '${hostId}' is SSH-declared; the read-through requires an http-transport registry entry (url + bearer)`, "unsupported-transport");
    }

    // Arch P2 leg 2: STRIP IS TOTAL — the forwarded request carries no host
    // param in any form, so the origin never sees the envelope and a
    // forwarded request structurally cannot re-forward. Every OTHER query
    // param rides through untouched (e.g. the slices filter).
    const url = new URL(c.req.url);
    url.searchParams.delete("host");
    const forwardPath = `${path}${url.searchParams.size > 0 ? `?${url.searchParams.toString()}` : ""}`;

    const res = await remoteRawRequest(resolved.host, forwardPath, {
      timeoutMs: READ_THROUGH_TIMEOUT_MS,
      fetchImpl,
    });
    if (res.ok) {
      // Arch P3: the origin ANSWERED — its status/content-type/body ARE the
      // answer, passed through untouched (its own 404/500 included). Edge
      // taxonomy errors below are only for the forward itself failing.
      return c.body(res.bodyText, res.status as never, { "Content-Type": res.contentType });
    }
    switch (res.kind) {
      case "bearer":
        return fail(res.detail, "auth-failed");
      case "timeout":
        return fail(
          res.phase === "body"
            ? `remote read timed out: response headers arrived (HTTP ${res.status}) but the body never completed`
            : `remote read timed out after ${READ_THROUGH_TIMEOUT_MS}ms`,
          "unreachable",
          res.status,
        );
      case "network":
        return fail(res.detail, "unreachable");
    }
  };
}
