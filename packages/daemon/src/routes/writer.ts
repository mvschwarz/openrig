import { Hono } from "hono";
import type { WriterAuthority, WriterResourceKind } from "../domain/writer-authority.js";
import {
  WriterAuthorityError,
  WRITER_RESOURCE_KINDS,
} from "../domain/writer-authority.js";
import type { FencedPublishTarget } from "../domain/fenced-publish-target.js";
import { FencedPublishError } from "../domain/fenced-publish-target.js";
import {
  ArtifactAcceptanceError,
  bindAcceptance,
  type ArtifactIdentity,
} from "../domain/artifact-acceptance.js";
import {
  OperationPublishError,
  type OperationPublishService,
} from "../domain/operation-publish.js";
import { requireSenderIdentity } from "./require-sender-identity.js";

/**
 * Thin writer-authority HTTP surface.
 *
 * First fenced product verb: publish onto a disposable `publish_target`
 * (`POST /publish`) under a live writer lease + matching generation.
 * Guarantee is API-only fencing — not an OS sandbox.
 */
export function writerRoutes(): Hono {
  const app = new Hono();

  function getWriters(c: { get: (key: string) => unknown }): WriterAuthority | null {
    return (c.get("writerAuthority" as never) as WriterAuthority | undefined) ?? null;
  }

  function getPublishTarget(c: {
    get: (key: string) => unknown;
  }): FencedPublishTarget | null {
    return (c.get("fencedPublishTarget" as never) as FencedPublishTarget | undefined) ?? null;
  }

  function getOperationPublish(c: {
    get: (key: string) => unknown;
  }): OperationPublishService | null {
    return (
      (c.get("operationPublish" as never) as OperationPublishService | undefined) ?? null
    );
  }

  function errorResponse(
    c: { json: (body: unknown, status?: number) => Response },
    err: unknown,
  ): Response {
    if (
      err instanceof WriterAuthorityError ||
      err instanceof FencedPublishError ||
      err instanceof ArtifactAcceptanceError ||
      err instanceof OperationPublishError
    ) {
      const status =
        err.code === "writer_held" ||
        err.code === "generation_mismatch" ||
        err.code === "lease_not_active" ||
        err.code === "lease_expired" ||
        err.code === "no_active_writer" ||
        err.code === "artifact_mismatch" ||
        err.code === "dirty_candidate_refused" ||
        err.code === "content_digest_mismatch"
          ? 409
          : err.code === "lease_session_mismatch"
            ? 403
            : err.code === "lease_not_found"
              ? 404
              : 400;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    const message = err instanceof Error ? err.message : "internal error";
    return c.json({ error: "internal_error", message }, 500);
  }

  function requireWriters(c: {
    get: (key: string) => unknown;
    json: (body: unknown, status?: number) => Response;
  }): WriterAuthority | Response {
    const writers = getWriters(c);
    if (!writers) {
      return c.json(
        { error: "writer_unavailable", message: "WriterAuthority is not wired in this daemon" },
        503,
      );
    }
    return writers;
  }

  app.post("/acquire", async (c) => {
    const body = await c.req
      .json<{
        resourceKind?: WriterResourceKind;
        resourceId?: string;
        holderSession?: string;
      }>()
      .catch(() => ({} as never));
    const identity = requireSenderIdentity(c, {
      verb: "writer acquire",
      bodyClaim: body.holderSession,
    });
    if (!identity.ok) return identity.response;
    const writers = requireWriters(c);
    if (writers instanceof Response) return writers;
    try {
      const kind = body.resourceKind ?? "publish_target";
      if (!(WRITER_RESOURCE_KINDS as readonly string[]).includes(kind)) {
        return c.json({ error: "invalid_resource_kind", message: "invalid resourceKind" }, 400);
      }
      const lease = writers.acquire(kind, body.resourceId ?? "", identity.session);
      return c.json(lease, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/renew", async (c) => {
    const body = await c.req
      .json<{ leaseId?: string; holderSession?: string }>()
      .catch(() => ({} as never));
    const identity = requireSenderIdentity(c, {
      verb: "writer renew",
      bodyClaim: body.holderSession,
    });
    if (!identity.ok) return identity.response;
    const writers = requireWriters(c);
    if (writers instanceof Response) return writers;
    try {
      return c.json(writers.renew(body.leaseId ?? "", identity.session));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/release", async (c) => {
    const body = await c.req
      .json<{ leaseId?: string; holderSession?: string }>()
      .catch(() => ({} as never));
    const identity = requireSenderIdentity(c, {
      verb: "writer release",
      bodyClaim: body.holderSession,
    });
    if (!identity.ok) return identity.response;
    const writers = requireWriters(c);
    if (writers instanceof Response) return writers;
    try {
      return c.json(writers.release(body.leaseId ?? "", identity.session));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/revoke", async (c) => {
    const body = await c.req
      .json<{ leaseId?: string; bySession?: string; reason?: string }>()
      .catch(() => ({} as never));
    const identity = requireSenderIdentity(c, {
      verb: "writer revoke",
      bodyClaim: body.bySession,
    });
    if (!identity.ok) return identity.response;
    const writers = requireWriters(c);
    if (writers instanceof Response) return writers;
    try {
      return c.json(writers.revoke(body.leaseId ?? "", identity.session, body.reason));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/transfer", async (c) => {
    const body = await c.req
      .json<{ leaseId?: string; fromSession?: string; toSession?: string }>()
      .catch(() => ({} as never));
    const identity = requireSenderIdentity(c, {
      verb: "writer transfer",
      bodyClaim: body.fromSession,
    });
    if (!identity.ok) return identity.response;
    const writers = requireWriters(c);
    if (writers instanceof Response) return writers;
    try {
      return c.json(
        writers.transfer(body.leaseId ?? "", identity.session, body.toSession ?? ""),
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * First fenced product verb: publish onto the disposable publish_target
   * under a live writer lease. Requires `OPENRIG_PUBLISH_TARGET_ROOT` so a
   * FencedPublishTarget is wired at startup.
   */
  app.post("/publish", async (c) => {
    const body = await c.req
      .json<{
        holderSession?: string;
        generation?: number;
        judgmentId?: string;
        reason?: string;
        artifact?: ArtifactIdentity;
        candidateBody?: string;
      }>()
      .catch(() => ({} as never));
    const identity = requireSenderIdentity(c, {
      verb: "writer publish",
      bodyClaim: body.holderSession,
    });
    if (!identity.ok) return identity.response;
    const writers = requireWriters(c);
    if (writers instanceof Response) return writers;
    const target = getPublishTarget(c);
    if (!target) {
      return c.json(
        {
          error: "publish_target_unavailable",
          message:
            "FencedPublishTarget is not wired (set OPENRIG_PUBLISH_TARGET_ROOT). Without a target, publish is refused — never silent published=true.",
        },
        503,
      );
    }
    try {
      if (typeof body.generation !== "number") {
        return c.json({ error: "generation_required", message: "generation is required" }, 400);
      }
      if (body.candidateBody === undefined) {
        return c.json({ error: "body_required", message: "candidateBody is required" }, 400);
      }
      if (!body.artifact) {
        return c.json({ error: "artifact_required", message: "artifact is required" }, 400);
      }
      const acceptance = bindAcceptance({
        judgmentId: body.judgmentId ?? `judgment:${Date.now()}`,
        artifact: body.artifact,
        actor: identity.session,
        reason: body.reason ?? "accept",
      });
      const receipt = target.publish({
        holderSession: identity.session,
        generation: body.generation,
        acceptance,
        body: body.candidateBody,
      });
      return c.json({ published: true, simulation: false, receipt }, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Topic D — thin accept↔artifact + receipt↔operation.
   * Receipt is keyed by operationId (historical), not target latest.
   */
  app.post("/accept-publish", async (c) => {
    const body = await c.req
      .json<{
        operationId?: string;
        holderSession?: string;
        generation?: number;
        reason?: string;
        artifact?: ArtifactIdentity;
        candidateBody?: string;
      }>()
      .catch(() => ({} as never));
    const identity = requireSenderIdentity(c, {
      verb: "writer accept-publish",
      bodyClaim: body.holderSession,
    });
    if (!identity.ok) return identity.response;
    const writers = requireWriters(c);
    if (writers instanceof Response) return writers;
    const ops = getOperationPublish(c);
    if (!ops) {
      return c.json(
        {
          error: "operation_publish_unavailable",
          message: "OperationPublishService is not wired",
        },
        503,
      );
    }
    try {
      if (typeof body.generation !== "number") {
        return c.json({ error: "generation_required", message: "generation is required" }, 400);
      }
      if (!body.artifact) {
        return c.json({ error: "artifact_required", message: "artifact is required" }, 400);
      }
      const result = ops.acceptAndPublish({
        operationId: body.operationId ?? "",
        artifact: body.artifact,
        body: body.candidateBody,
        actor: identity.session,
        reason: body.reason ?? "accept",
        holderSession: identity.session,
        generation: body.generation,
      });
      return c.json(result, result.replayed ? 200 : 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/active", async (c) => {
    const writers = requireWriters(c);
    if (writers instanceof Response) return writers;
    const resourceKind = (c.req.query("resourceKind") ?? "publish_target") as WriterResourceKind;
    const resourceId = c.req.query("resourceId") ?? "";
    if (!(WRITER_RESOURCE_KINDS as readonly string[]).includes(resourceKind)) {
      return c.json({ error: "invalid_resource_kind", message: "invalid resourceKind" }, 400);
    }
    return c.json({ lease: writers.getActive(resourceKind, resourceId) });
  });

  return app;
}
