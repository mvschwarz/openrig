import type Database from "better-sqlite3";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { QueueRepository } from "../domain/queue-repository.js";
import { QueueTransferActivation } from "../domain/queue-transfer-activation.js";
import { QUEUE_TRANSFER_MAX_BYTES, QueueTransferError } from "../domain/queue-transfer-format.js";
import { assertTransferSchema, QueueTransferOperationError, type TransferActor } from "../domain/queue-transfer-operation.js";
import { isTransferObject, QueueTransferParseError } from "../domain/queue-transfer-parse.js";
import { isTransferDigest, parseActivationResult, parseAuthorization, parseReceipt, QueueTransferRecordError, RECEIPT_KIND } from "../domain/queue-transfer-records.js";
import { replayTransfer, transferStatus } from "../domain/queue-transfer-recovery.js";
import { QueueTransferSource } from "../domain/queue-transfer-relinquish.js";
import { QueueTransferStaging } from "../domain/queue-transfer-staging.js";
import { SelfHostIdentityStore } from "../domain/seat-identity-store.js";
import { authBearerTokenMiddleware, constantTimeEqual } from "../middleware/auth-bearer-token.js";
import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";

const invalidBody = () => new QueueTransferOperationError("invalid_body", 400);
async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    if (!isTransferObject(body)) throw invalidBody();
    return body;
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidBody();
    throw error;
  }
}

const writeOptions = ({ actor, dryRun }: Record<string, unknown>) => {
  if ((actor !== undefined && typeof actor !== "string") || (dryRun !== undefined && typeof dryRun !== "boolean")) throw invalidBody();
  return { actor, dryRun };
};
function relinquishBody(body: Record<string, unknown>) {
  const { archiveText, authorization, intervention, limits } = body;
  if (typeof archiveText !== "string" || !archiveText || authorization === undefined || typeof intervention !== "string" ||
      (limits !== undefined && typeof limits !== "string")) throw invalidBody();
  return { ...writeOptions(body), archiveText, authorization, intervention, limits };
}
function activateBody(body: Record<string, unknown>) {
  const { importId, authorization, receipt } = body;
  if (typeof importId !== "string" || !importId || authorization === undefined || receipt === undefined) throw invalidBody();
  return { ...writeOptions(body), importId, authorization, receipt };
}
function reconcileBody({ actor, archiveText, result }: Record<string, unknown>) {
  if ((actor !== undefined && typeof actor !== "string") || typeof archiveText !== "string" || !archiveText || result === undefined) throw invalidBody();
  return { actor, archiveText, result };
}

export function queueTransferRoutes({ db, repo, bearerToken }: {
  readonly db: Database.Database; readonly repo?: QueueRepository; readonly bearerToken: string | null;
}): Hono {
  const app = new Hono();
  const requireAuth = authBearerTokenMiddleware({ expectedToken: bearerToken });
  const limit = bodyLimit({ maxSize: 3 * QUEUE_TRANSFER_MAX_BYTES, onError: c => c.json({ error: "archive_too_large" }, 413) });
  app.on("POST", "*", requireAuth, limit);
  app.use("*", async (_c, next) => { assertTransferSchema(db); await next(); });

  app.onError((error, c) => {
    if (error instanceof QueueTransferOperationError) return c.json({ error: error.code, ...error.detail }, error.status);
    if (error instanceof QueueTransferRecordError || error instanceof QueueTransferParseError || error instanceof QueueTransferError) {
      return c.json({ error: error.code, message: error.message }, 400);
    }
    throw error;
  });

  app.get("/staging/:importId", c => {
    const stage = new QueueTransferStaging(db).manifest(c.req.param("importId"));
    if (!stage) return c.json({ error: "import_not_found" }, 404);
    const host = new SelfHostIdentityStore(db).get();
    if (!host) return c.json({ error: "destination_identity_missing" }, 409);
    return c.json({ stage, destinationHostId: host.hostId });
  });
  app.get("/status", c => {
    const digest = c.req.query("archiveDigest");
    if (digest !== undefined && !isTransferDigest(digest)) return c.json({ error: "invalid_archive_digest" }, 400);
    // The existing status summary is ungated; answer text follows the operator bearer boundary.
    const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1]?.trim();
    const includeHistory = bearerToken === null || (bearer !== undefined && constantTimeEqual(bearer, bearerToken));
    return c.json(transferStatus(db, digest, includeHistory));
  });

  function write<T extends { readonly actor?: string | undefined }>(verb: string, parseBody: (body: Record<string, unknown>) => T,
    run: (input: T, actor: TransferActor, queue: QueueRepository) => object | undefined) {
    app.post(`/${verb}`, async c => {
      const body = parseBody(await readBody(c));
      const identity = requireSenderIdentity(c, { verb: `queue transfer ${verb}`, bodyClaim: body.actor });
      if (!identity.ok) return identity.response;
      if (!repo) return c.json({ error: "queue_repository_unavailable" }, 500);
      return c.json(run(body, { actorSession: identity.session, identityProvenance: resolveRecordedProvenance(c, identity) }, repo));
    });
  }
  write("relinquish", relinquishBody, (body, actor, queue) => new QueueTransferSource(queue).relinquish({
    ...body, authorization: parseAuthorization(body.authorization), actor,
  }));
  write("activate", activateBody, (body, actor, queue) => new QueueTransferActivation(queue).activate({
    ...body, authorization: parseAuthorization(body.authorization), receipt: parseReceipt(body.receipt), actor,
  }));
  write("reconcile", reconcileBody, (body, actor, queue) => new QueueTransferSource(queue).reconcile({
    ...body, result: parseActivationResult(body.result), actor,
  }));
  app.post("/replay", async c => {
    const { record } = await readBody(c);
    if (!isTransferObject(record) || typeof record.kind !== "string") throw invalidBody();
    return c.json(replayTransfer(db, record.kind === RECEIPT_KIND ? parseReceipt(record) : parseActivationResult(record)));
  });
  return app;
}
