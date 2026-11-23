import type Database from "better-sqlite3";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { QueueRepository } from "../domain/queue-repository.js";
import { QueueTransferActivation } from "../domain/queue-transfer-activation.js";
import { QUEUE_TRANSFER_MAX_BYTES, QueueTransferError } from "../domain/queue-transfer-format.js";
import { assertTransferSchema, QueueTransferOperationError, type TransferActor } from "../domain/queue-transfer-operation.js";
import { QueueTransferParseError } from "../domain/queue-transfer-parse.js";
import { parseActivationResult, parseAuthorization, parseReceipt, QueueTransferRecordError, RECEIPT_KIND } from "../domain/queue-transfer-records.js";
import { replayTransfer, transferStatus } from "../domain/queue-transfer-recovery.js";
import { QueueTransferSource } from "../domain/queue-transfer-relinquish.js";
import { QueueTransferStaging } from "../domain/queue-transfer-staging.js";
import { SelfHostIdentityStore } from "../domain/seat-identity-store.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";

const writeBody = z.object({ actor: z.string().optional() });
const archiveText = z.string().min(1);
const dryRun = z.boolean().optional();
const relinquishBody = writeBody.extend({ archiveText, authorization: z.json(), intervention: z.string(), limits: z.string().optional(), dryRun });
const activateBody = writeBody.extend({ importId: z.string().min(1), authorization: z.json(), receipt: z.json(), dryRun });
const reconcileBody = writeBody.extend({ archiveText, result: z.json() });
const replayBody = z.object({ record: z.looseObject({ kind: z.string() }) });
const digest = z.string().regex(/^[0-9a-f]{64}$/).optional();

async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  try {
    return schema.parse(await c.req.json());
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new QueueTransferOperationError("invalid_body", 400);
    throw error;
  }
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
    const parsed = digest.safeParse(c.req.query("archiveDigest"));
    if (!parsed.success) return c.json({ error: "invalid_archive_digest" }, 400);
    return c.json(transferStatus(db, parsed.data));
  });

  function write<T extends { readonly actor?: string | undefined }>(verb: string, schema: z.ZodType<T>,
    run: (input: T, actor: TransferActor, queue: QueueRepository) => object | undefined) {
    app.post(`/${verb}`, async c => {
      const body = await readBody(c, schema);
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
    const { record } = await readBody(c, replayBody);
    return c.json(replayTransfer(db, record.kind === RECEIPT_KIND ? parseReceipt(record) : parseActivationResult(record)));
  });
  return app;
}
