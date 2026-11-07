/**
 * Whole-Capability Production HTTP Integration Tests for Gateway Relay (Capability 3 / #2329)
 *
 * Justification for dedicated integration file:
 * Existing unit/route tests (`relay-config.test.ts`, `relay-outbound.test.ts`,
 * `gateway-relay-inbound.test.ts`) exercise individual layers or in-memory DBs.
 * This suite proves the whole-capability operational seam that unit tests lack:
 *   1. Production `createDaemon` composition over a file-backed SQLite DB (`dbPath`)
 *      with `test/hermetic-env.setup.ts` fixture-home isolation (`.openrig-fixture` preserved).
 *   2. Post-bind network discipline (`startServices()` after TCP bind) + real loopback
 *      Hono HTTP server (`127.0.0.1:0`) paired with `./fixtures/recording-relay.js`.
 *   3. Durable bridge custody before HTTP `2xx`, intentional lost-ACK fault injection,
 *      and actual daemon + bridge restart over the same SQLite DB and custody file.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { OPENRIG_HOME } from "../src/openrig-compat.js";
import { createDaemon } from "../src/startup.js";
import { parseRelayOwnerNotificationTransportFailed } from "../src/domain/queue-transition-log.js";
import {
  addHumanFragment,
  loadHumanRegistry,
  parseBindingSpec,
  setHumanField,
} from "../src/domain/gateway/human-registry.js";
import { setDefaultPerson } from "../src/domain/gateway/participants.js";
import { makeOperatorDeliveryEngine } from "../src/domain/gateway/operator-delivery-engine.js";
import { SlackOutboundDriver } from "../src/domain/gateway/slack/outbound-driver.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { loadConfig } from "../src/domain/gateway/slack/config.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { encodeRelayReplyRef } from "../src/domain/gateway/relay-outbound.js";
import {
  computeRelayEventKey,
  RELAY_INBOUND_SEEN_FILE,
} from "../src/domain/gateway/relay-inbound.js";
import {
  startRecordingRelay,
  type RecordingRelayHandle,
} from "./fixtures/recording-relay.js";

type DaemonInstance = Awaited<ReturnType<typeof createDaemon>>;

interface RunningDaemon {
  daemon: DaemonInstance;
  server: ServerType;
  baseUrl: string;
  dbPath: string;
  stop: () => Promise<void>;
}

const activeDaemons: RunningDaemon[] = [];
const activeBridges: RecordingRelayHandle[] = [];
let testScratchDir = "";

function cleanFixtureGatewayState(): void {
  // Preserve `.openrig-fixture` and runtime stubs established by `test/hermetic-env.setup.ts`
  for (const sub of ["gateway", "state"]) {
    rmSync(join(OPENRIG_HOME, sub), { recursive: true, force: true });
  }
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function writeRelaySecretsFile(
  filePath: string,
  vars: { url: string; outboundToken: string; inboundToken: string },
  mode = 0o600,
): string {
  const body = [
    `OPENRIG_RELAY_URL=${vars.url}`,
    `OPENRIG_RELAY_OUTBOUND_TOKEN=${vars.outboundToken}`,
    `OPENRIG_RELAY_INBOUND_TOKEN=${vars.inboundToken}`,
    "",
  ].join("\n");
  writeFileSync(filePath, body, { encoding: "utf8", mode });
  chmodSync(filePath, mode);
  return filePath;
}

function registerRelayPerson(opts: {
  entityId: string;
  displayName: string;
  connectorRef: string;
  envFilePath: string;
  handle: string;
}): void {
  const spec = `relay:${opts.connectorRef}:file:${opts.envFilePath}:primary:handle=${opts.handle}`;
  const parsed = parseBindingSpec(spec);
  expect(parsed.ok, `parseBindingSpec(${spec}) must succeed`).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error);

  const res = addHumanFragment(
    {
      entityId: opts.entityId,
      class: "human",
      displayName: opts.displayName,
      address: `${opts.entityId}@external`,
      connectorBindings: [
        {
          kind: "relay",
          connectorRef: parsed.binding.connectorRef,
          secretsRef: parsed.binding.secretsRef,
          role: "primary",
          handle: parsed.binding.handle,
        },
      ],
      prefs: { deliveryClass: "A" },
    },
    OPENRIG_HOME,
  );
  expect(res.ok, `addHumanFragment(${opts.entityId}) must succeed`).toBe(true);
}

async function bootProductionDaemon(opts?: {
  dbPath?: string;
  startPostBind?: boolean;
}): Promise<RunningDaemon> {
  const dbPath = opts?.dbPath ?? join(testScratchDir, "daemon-e2e.sqlite");
  const daemon = await createDaemon({
    dbPath,
    // Labeled fake terminal adapters: no live tmux/cmux server or native provider is touched.
    tmuxExec: async () => "",
    cmuxFactory: async () => {
      throw Object.assign(
        new Error("fake-cmux-adapter: no live terminal socket in relay integration test"),
        { code: "ENOENT" },
      );
    },
  });

  if (daemon.deps.sessionTransport) {
    daemon.deps.sessionTransport.send = async (sessionName: string) => ({
      ok: true,
      sessionName,
      sent: true,
      verified: true,
    });
  }

  let server!: ServerType;
  const port = await new Promise<number>((resolve) => {
    server = serve(
      { fetch: daemon.app.fetch, hostname: "127.0.0.1", port: 0 },
      (info: AddressInfo) => resolve(info.port),
    );
  });

  if (opts?.startPostBind !== false) {
    daemon.deps.gatewaySubsystem?.startServices();
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try { daemon.contextMonitor.stop(); } catch {}
    try { daemon.eventLoopMonitor.stop(); } catch {}
    try { daemon.deps.watchdogScheduler?.stop(); } catch {}
    try { daemon.deps.modelDivergenceMonitor?.stopPolling(); } catch {}
    try { daemon.deps.gatewaySubsystem?.stop(); } catch {}
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { daemon.db.close(); } catch {}
  };

  const handle: RunningDaemon = {
    daemon,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    dbPath,
    stop,
  };
  activeDaemons.push(handle);
  return handle;
}

async function sweepOutboundOnce(daemon: DaemonInstance): Promise<void> {
  const queueRepo = daemon.deps.queueRepo!;
  const subsystem = daemon.deps.gatewaySubsystem!;
  const cfg = loadConfig(OPENRIG_HOME);
  const seen = new SeenStore(
    join(OPENRIG_HOME, "state", "slack-outbound-seen.jsonl"),
  );
  const driver = new SlackOutboundDriver({
    home: OPENRIG_HOME,
    queue: makeQueuePorts(queueRepo, {
      loadHumanRegistry: () => loadHumanRegistry(OPENRIG_HOME),
    }),
    seen,
    filter: { minimumLevel: cfg.minimumLevelThatPosts },
    dispatch: (op, ref, payload) => subsystem.dispatch(op, ref, payload),
  });
  await driver.sweepOnce();
}

describe("Capability 3 gateway relay — whole-capability production HTTP integration", () => {
  beforeAll(() => {
    process.env.OPENRIG_NO_KERNEL = "1";
  });

  afterAll(() => {
    delete process.env.OPENRIG_NO_KERNEL;
    cleanFixtureGatewayState();
  });

  beforeEach(() => {
    cleanFixtureGatewayState();
    const userHome = process.env.HOME ?? OPENRIG_HOME;
    mkdirSync(userHome, { recursive: true });
    testScratchDir = mkdtempSync(join(userHome, "relay-int-"));
  });

  afterEach(async () => {
    while (activeDaemons.length > 0) {
      await activeDaemons.pop()!.stop();
    }
    while (activeBridges.length > 0) {
      await activeBridges.pop()!.stop();
    }
    if (testScratchDir) {
      rmSync(testScratchDir, { recursive: true, force: true });
      testScratchDir = "";
    }
    cleanFixtureGatewayState();
  });

  it(
    "proves post-bind network discipline, single-POST > 64 KiB CJK/emoji ordinary ask outbound custody via real daemon poller, probe filtering, and inbound reply with ignored proxy headers/extras and real attribution",
    async () => {
      const outboundToken = "sec-relay-out-integration-01";
      const inboundToken = "sec-relay-in-integration-01";
      const custodyFilePath = join(testScratchDir, "bridge-custody.jsonl");

      const bridge = await startRecordingRelay({
        custodyFilePath,
        outboundToken,
        inboundToken,
      });
      activeBridges.push(bridge);

      const envFilePath = writeRelaySecretsFile(
        join(testScratchDir, "relay-local.env"),
        { url: bridge.outboundUrl, outboundToken, inboundToken },
        0o600,
      );

      registerRelayPerson({
        entityId: "alice-ops",
        displayName: "Alice Ops",
        connectorRef: "local-bridge",
        envFilePath,
        handle: "alice_ops",
      });

      // Configure alice-ops's Slack subscription to urgent-only; primary binding stays relay
      const subRes = setHumanField("alice-ops", "slack-subscription", "urgent-only", OPENRIG_HOME);
      expect(subRes.ok, "setHumanField slack-subscription urgent-only must succeed").toBe(true);

      const running = await bootProductionDaemon({ startPostBind: false });
      const { daemon } = running;
      daemon.deps.rigRepo.createRig("ops-rig");

      const longSummary =
        "Production rollout gate — " +
        "日本語確認🧪".repeat(165) +
        " [SUMMARY-TAIL-MARKER-901]";
      expect(longSummary.length).toBeGreaterThan(1000);

      const longBody =
        "Confirm whether we should promote release candidate v2.4.\n" +
        "段落ブロック🚀漢字テスト-alpha-beta-gamma\n".repeat(2400) +
        "[BODY-TAIL-MARKER-902]";
      const longDetail =
        "Canary telemetry detail: p99=42ms, error_rate=0.00% 🛰️ [DETAIL-TAIL-MARKER-903]";

      const ask = await daemon.deps.queueRepo!.create({
        sourceSession: "planner@ops-rig",
        destinationSession: "alice-ops@external",
        summary: longSummary,
        body: longBody,
        humanIntent: "decision",
        humanDetail: longDetail,
        humanQuestions: [
          {
            id: "q-promote",
            question: "Promote release candidate v2.4? [QUESTION-TAIL-MARKER-904]",
            options: [
              {
                id: "yes",
                label: "Promote now [OPT-YES-TAIL-905]",
                recommended: true,
              },
              {
                id: "hold",
                label: "Hold [OPT-HOLD-TAIL-906]",
              },
            ],
          },
        ],
        nudge: false,
      });

      // Composition alone must never dial the bridge; GET / probes are ignored.
      expect(daemon.deps.gatewaySubsystem?.status().state).toBe("active");
      expect(bridge.getSanitizedStats().relayPostCount).toBe(0);
      const probeRes = await fetch(`${bridge.baseUrl}/`, { method: "GET" });
      expect(probeRes.status).toBe(404);
      // The bridge fixture ignores non-POST probes; assert own probe was 404,
      // zero actual relay POSTs before start, and ignoredProbeCount >= 1 in case
      // host/environment sends unrelated probes to the local port.
      expect(bridge.getSanitizedStats().ignoredProbeCount).toBeGreaterThanOrEqual(1);
      expect(bridge.getSanitizedStats().relayPostCount).toBe(0);

      // Start post-bind services: do NOT call manual sweepOutboundOnce for this first ask.
      // Wait for actual composition-owned default 30-second poller to produce the single complete > 64 KiB bridge custody record.
      // We budget 38,000ms (38s) for the ~30s production polling cadence to fire.
      daemon.deps.gatewaySubsystem?.startServices();
      await waitForCondition(
        () =>
          bridge.getCustodyRecords().length === 1 &&
          daemon.deps.queueRepo!.hasRelayOwnerNotificationReceipt(ask.qitemId),
        38_000,
      );

      const stats = bridge.getSanitizedStats();
      expect(stats.relayPostCount).toBe(1);
      expect(stats.acceptedCount).toBe(1);
      expect(stats.custodyCount).toBe(1);

      const custodyRecords = bridge.getCustodyRecords();
      expect(custodyRecords).toHaveLength(1);

      const receipt = daemon.deps.queueRepo!.getRelayOwnerNotificationReceipt(ask.qitemId);
      expect(receipt?.connectorRef).toBe("local-bridge");
      const parentDeliveryId = receipt!.deliveryId;

      const loneSurrogateRe =
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      const rec = custodyRecords[0]!;
      expect(Buffer.byteLength(JSON.stringify(rec.envelope), "utf8")).toBeGreaterThan(
        65_536,
      );
      expect(rec.deliveryId).toBe(parentDeliveryId);
      expect((rec.envelope as Record<string, unknown>).part).toBeUndefined();
      expect(rec.envelope.summary.length).toBeLessThanOrEqual(1000);
      expect(rec.envelope.summary).not.toMatch(loneSurrogateRe);
      expect(rec.envelope.body).not.toMatch(loneSurrogateRe);

      const deliveredEnvelope = rec.envelope;
      expect(deliveredEnvelope).toMatchObject({
        v: 1,
        deliveryId: parentDeliveryId,
        recipient: { handle: "alice_ops" },
        intent: "decision",
        outcome: "interrupt",
      });
      expect(typeof deliveredEnvelope.replyRef).toBe("string");
      expect(deliveredEnvelope.body).toContain(longSummary);
      expect(deliveredEnvelope.body).toContain("[SUMMARY-TAIL-MARKER-901]");
      expect(deliveredEnvelope.body).toContain(longBody);
      expect(deliveredEnvelope.body).toContain("[BODY-TAIL-MARKER-902]");
      expect(deliveredEnvelope.body).toContain(longDetail);
      expect(deliveredEnvelope.body).toContain("[DETAIL-TAIL-MARKER-903]");
      expect(deliveredEnvelope.body).toContain(
        "Promote release candidate v2.4? [QUESTION-TAIL-MARKER-904]",
      );
      expect(deliveredEnvelope.body).toContain(
        "- Promote now [OPT-YES-TAIL-905] (recommended)",
      );
      expect(deliveredEnvelope.body).toContain(
        "- Hold [OPT-HOLD-TAIL-906]",
      );
      // Receipt records bridge custody acceptance only; the ask remains pending until an inbound reply settles it.
      expect(daemon.deps.queueRepo!.getById(ask.qitemId)?.state).toBe("pending");

      // Custody log and sanitized diagnostics must never contain tokens.
      const rawCustody = readFileSync(custodyFilePath, "utf8");
      expect(rawCustody).not.toContain(outboundToken);
      expect(rawCustody).not.toContain(inboundToken);
      expect(JSON.stringify(stats)).not.toContain(outboundToken);
      expect(JSON.stringify(stats)).not.toContain(inboundToken);

      // Inbound reply with forwarding/proxy headers and harmless extra fields:
      // proxy headers are ignored, extra fields are ignored and cannot spoof sender/actor,
      // and event fingerprint is unchanged when replayed without extras.
      const rawInboundRes = await fetch(
        `${running.baseUrl}/api/gateway/relay/inbound`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${inboundToken}`,
            via: "1.1 local-bridge",
            "x-forwarded-for": "203.0.113.9",
            forwarded: "for=203.0.113.9;proto=http",
            "x-real-ip": "203.0.113.9",
          },
          body: JSON.stringify({
            eventId: "evt-ordinary-ask-1",
            sender: {
              handle: "alice_ops",
              displayName: "Spoofed Display Name",
              externalId: "ext-999",
            },
            replyRef: deliveredEnvelope.replyRef!,
            text: "Promote now — canary metrics are clean.",
            ordering: "after-question",
            actorSession: "spoofed-actor@external",
            bridgeMetadata: { traceId: "trace-001" },
          }),
        },
      );
      expect(rawInboundRes.status).toBe(200);
      const replyBody = (await rawInboundRes.json()) as Record<string, unknown>;
      expect(replyBody).toMatchObject({
        ok: true,
        qitemId: ask.qitemId,
        verb: "answer",
        actorSession: "alice-ops@external",
        deduplicated: false,
      });

      const replayWithoutExtras = await bridge.sendInboundReply(running.baseUrl, {
        eventId: "evt-ordinary-ask-1",
        sender: { handle: "alice_ops" },
        replyRef: deliveredEnvelope.replyRef!,
        text: "Promote now — canary metrics are clean.",
        ordering: "after-question",
      });
      expect(replayWithoutExtras.status).toBe(200);
      expect(replayWithoutExtras.body).toMatchObject({
        ok: true,
        qitemId: ask.qitemId,
        actorSession: "alice-ops@external",
        deduplicated: true,
      });

      const settledAsk = daemon.deps.queueRepo!.getById(ask.qitemId)!;
      expect(settledAsk.state).toBe("done");
      expect(settledAsk.humanAnswers).toEqual({
        "q-promote": {
          kind: "typed-reply",
          placement: "first-unanswered",
          text: "Promote now — canary metrics are clean.",
          unansweredCount: 0,
        },
      });

      const seenRaw = readFileSync(
        join(OPENRIG_HOME, "state", RELAY_INBOUND_SEEN_FILE),
        "utf8",
      );
      expect(seenRaw).not.toContain("Promote now — canary metrics are clean.");
      expect(seenRaw).not.toContain(inboundToken);
      expect(seenRaw).not.toContain(outboundToken);
    },
    50_000,
  );

  it("delivers operator notices without closing underlying blocked work, exposes accepted outcome on delivered human updates API, and rejects replies to informational updates", async () => {
    const outboundToken = "sec-relay-out-integration-02";
    const inboundToken = "sec-relay-in-integration-02";
    const custodyFilePath = join(testScratchDir, "bridge-custody-2.jsonl");

    const bridge = await startRecordingRelay({
      custodyFilePath,
      outboundToken,
      inboundToken,
    });
    activeBridges.push(bridge);

    const envFilePath = writeRelaySecretsFile(
      join(testScratchDir, "relay-local-2.env"),
      { url: bridge.outboundUrl, outboundToken, inboundToken },
      0o600,
    );

    registerRelayPerson({
      entityId: "alice-ops",
      displayName: "Alice Ops",
      connectorRef: "local-bridge",
      envFilePath,
      handle: "alice_ops",
    });
    setDefaultPerson("alice-ops", OPENRIG_HOME);

    const running = await bootProductionDaemon({ startPostBind: true });
    const { daemon } = running;
    daemon.deps.rigRepo.createRig("ops-rig");

    const stuckBaton = await daemon.deps.queueRepo!.create({
      sourceSession: "planner@ops-rig",
      destinationSession: "worker@ops-rig",
      summary: "Worker baton stuck on wake",
      body: "Need operator attention on worker@ops-rig.",
      nudge: false,
    });

    const operatorEngine = makeOperatorDeliveryEngine({
      home: OPENRIG_HOME,
      queueRepo: daemon.deps.queueRepo!,
      gatewayState: () =>
        String(daemon.deps.gatewaySubsystem?.status().state ?? "unavailable"),
      dispatch: (op, ref, payload, opts) =>
        daemon.deps.gatewaySubsystem!.dispatch(op, ref, payload, opts),
    });

    const opDispatch = await operatorEngine.dispatchEscalation(
      stuckBaton,
      "wake-ladder-exhausted",
    );
    expect(opDispatch.dispatched).toBe(true);

    await waitForCondition(() => bridge.getCustodyRecords().length === 1);
    const opRecord = bridge.getCustodyRecords()[0]!;
    expect(opRecord.envelope.recipient.handle).toBe("alice_ops");
    expect(opRecord.envelope.replyRef).toBeNull();

    await waitForCondition(() =>
      daemon.deps.queueRepo!.hasRelayOwnerNotificationReceipt(stuckBaton.qitemId),
    );
    expect(daemon.deps.queueRepo!.getById(stuckBaton.qitemId)?.state).toBe("pending");

    const infoUpdate = await daemon.deps.queueRepo!.create({
      sourceSession: "planner@ops-rig",
      destinationSession: "alice-ops@external",
      summary: "Deployment completed",
      body: "FYI: deployment finished with 0 errors.",
      humanIntent: "update",
      nudge: false,
    });

    await sweepOutboundOnce(daemon);
    await waitForCondition(() => bridge.getCustodyRecords().length === 2);

    const updateRecord = bridge.getCustodyRecords()[1]!;
    expect(updateRecord.envelope.intent).toBe("update");
    expect(updateRecord.envelope.replyRef).toBeNull();

    await waitForCondition(
      () => daemon.deps.queueRepo!.getById(infoUpdate.qitemId)?.state === "done",
    );

    // Real serialized delivered-updates HTTP endpoint exposes deliveryOutcome: "accepted" for relay-accepted updates
    const deliveredUpdatesRes = await fetch(
      `${running.baseUrl}/api/queue/human-updates`,
    );
    expect(deliveredUpdatesRes.status).toBe(200);
    const deliveredUpdatesJson = (await deliveredUpdatesRes.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const deliveredInfoItem = deliveredUpdatesJson.items.find(
      (it) => it.qitemId === infoUpdate.qitemId,
    );
    expect(deliveredInfoItem).toBeDefined();
    expect(deliveredInfoItem).toMatchObject({
      qitemId: infoUpdate.qitemId,
      summary: "Deployment completed",
      deliveryOutcome: "accepted",
    });
    expect(String(deliveredInfoItem?.deliveryReceipt ?? "")).toMatch(
      /^relay-owner-notification-accepted /,
    );

    const updateTransitions = daemon.deps.queueRepo!.listTransitions(infoUpdate.qitemId);
    const forgedUpdateRef = encodeRelayReplyRef({
      v: 1,
      qitemId: infoUpdate.qitemId,
      episodeKey: `${infoUpdate.qitemId}:${updateTransitions[0]!.transitionId}`,
      decisionRevision: daemon.deps.queueRepo!.decisionRevision(
        daemon.deps.queueRepo!.getById(infoUpdate.qitemId)!,
      ),
      decisionId: updateRecord.deliveryId,
      connectorRef: "local-bridge",
      mode: "ask",
    });

    const updateReplyRes = await bridge.sendInboundReply(running.baseUrl, {
      eventId: "evt-update-reply-attempt",
      sender: { handle: "alice_ops" },
      replyRef: forgedUpdateRef,
      text: "Approved!",
      ordering: "after-question",
    });
    expect(updateReplyRes.status).toBe(409);
  });

  it("survives bridge lost ACK after durable custody commit, records relay-specific transport-failed note, and replays stable deliveryId/bytes across actual daemon + bridge restart", async () => {
    const outboundToken = "sec-relay-out-integration-03";
    const inboundToken = "sec-relay-in-integration-03";
    const custodyFilePath = join(testScratchDir, "bridge-custody-restart.jsonl");
    const dbPath = join(testScratchDir, "daemon-restart.sqlite");

    const bridge = await startRecordingRelay({
      custodyFilePath,
      outboundToken,
      inboundToken,
    });
    activeBridges.push(bridge);

    const envFilePath = writeRelaySecretsFile(
      join(testScratchDir, "relay-restart.env"),
      { url: bridge.outboundUrl, outboundToken, inboundToken },
      0o600,
    );

    registerRelayPerson({
      entityId: "alice-ops",
      displayName: "Alice Ops",
      connectorRef: "local-bridge",
      envFilePath,
      handle: "alice_ops",
    });

    const daemon1 = await bootProductionDaemon({ dbPath, startPostBind: true });
    daemon1.daemon.deps.rigRepo.createRig("ops-rig");

    const ask = await daemon1.daemon.deps.queueRepo!.create({
      sourceSession: "planner@ops-rig",
      destinationSession: "alice-ops@external",
      summary: "Database migration approval",
      body: "Approve schema migration 150?",
      humanIntent: "decision",
      humanAlert: true,
      humanQuestions: [
        {
          id: "q-mig",
          header: "Migration",
          question: "Run migration now?",
          options: [
            { id: "run", label: "Run", description: "Execute migration" },
            { id: "defer", label: "Defer", description: "Hold until window" },
          ],
        },
      ],
      nudge: false,
    });

    bridge.setLoseNextAck(true);
    await sweepOutboundOnce(daemon1.daemon);
    await waitForCondition(() => bridge.getSanitizedStats().lostAckCount === 1);
    await waitForCondition(() =>
      daemon1.daemon.deps
        .queueRepo!.listTransitions(ask.qitemId)
        .some((t) =>
          (t.transitionNote ?? "").startsWith(
            "relay-owner-notification-transport-failed ",
          ),
        ),
    );

    const transitionNotes = daemon1.daemon.deps
      .queueRepo!.listTransitions(ask.qitemId)
      .map((t) => t.transitionNote ?? "");
    expect(
      transitionNotes.some(
        (n) =>
          n.startsWith("relay-owner-notification-transport-failed ") &&
          n.includes("connector_ref=local-bridge"),
      ),
    ).toBe(true);
    expect(
      transitionNotes
        .map((n) => parseRelayOwnerNotificationTransportFailed(n))
        .find((f) => f !== null),
    ).toMatchObject({
      connectorRef: "local-bridge",
      failureClass: "http-502",
    });
    expect(
      transitionNotes.some((n) =>
        n.startsWith("slack-owner-notification-transport-failed"),
      ),
    ).toBe(false);

    const firstCustody = bridge.getCustodyRecords();
    expect(firstCustody).toHaveLength(1);
    const firstDeliveryId = firstCustody[0]!.deliveryId;
    const firstPayloadSha = firstCustody[0]!.payloadSha256;
    const firstRawBytesSha = firstCustody[0]!.rawBytesSha256;

    expect(
      new DispatchBuffer(OPENRIG_HOME).pending().map((d) => d.decisionId),
    ).toContain(firstDeliveryId);
    expect(
      daemon1.daemon.deps.queueRepo!.hasRelayOwnerNotificationReceipt(ask.qitemId),
    ).toBe(false);

    // Bridge rejects changed payload under the same deliveryId (409 conflict).
    const mutatedRes = await fetch(bridge.outboundUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${outboundToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...firstCustody[0]!.envelope,
        body: "Mutated body under same deliveryId",
      }),
    });
    expect(mutatedRes.status).toBe(409);
    expect(bridge.getSanitizedStats().conflictCount).toBe(1);

    // Shut down Daemon 1 AND restart the bridge server over the SAME custody file and port.
    await daemon1.stop();
    activeDaemons.pop();
    await bridge.restart();

    const daemon2 = await bootProductionDaemon({ dbPath, startPostBind: false });
    expect(bridge.getSanitizedStats().deduplicatedCount).toBe(0);

    daemon2.daemon.deps.gatewaySubsystem?.startServices();
    await waitForCondition(() => bridge.getSanitizedStats().deduplicatedCount === 1);
    await waitForCondition(() => new DispatchBuffer(OPENRIG_HOME).pending().length === 0);

    const afterCustody = bridge.getCustodyRecords();
    expect(afterCustody).toHaveLength(1);
    expect(afterCustody[0]!.deliveryId).toBe(firstDeliveryId);
    expect(afterCustody[0]!.payloadSha256).toBe(firstPayloadSha);
    expect(afterCustody[0]!.rawBytesSha256).toBe(firstRawBytesSha);
    expect(
      daemon2.daemon.deps.queueRepo!.hasRelayOwnerNotificationReceipt(ask.qitemId),
    ).toBe(true);
  });

  it("enforces inbound idempotency, equivocation conflict, stale episode/repark rejection, second-person attribution, uncertain ordering context, atomic close+audit recovery, and scoped seen-ledger handling", async () => {
    const outboundToken = "sec-relay-out-integration-04";
    const inboundToken = "sec-relay-in-integration-04";
    const custodyFilePath = join(testScratchDir, "bridge-custody-inbound.jsonl");

    const bridge = await startRecordingRelay({
      custodyFilePath,
      outboundToken,
      inboundToken,
    });
    activeBridges.push(bridge);

    const envFilePath = writeRelaySecretsFile(
      join(testScratchDir, "relay-inbound-matrix.env"),
      { url: bridge.outboundUrl, outboundToken, inboundToken },
      0o600,
    );

    registerRelayPerson({
      entityId: "alice-ops",
      displayName: "Alice Ops",
      connectorRef: "local-bridge",
      envFilePath,
      handle: "alice_ops",
    });
    registerRelayPerson({
      entityId: "bob-peer",
      displayName: "Bob Peer",
      connectorRef: "local-bridge",
      envFilePath,
      handle: "bob_peer",
    });

    const running = await bootProductionDaemon({ startPostBind: true });
    const { daemon } = running;
    daemon.deps.rigRepo.createRig("ops-rig");

    const parked = await daemon.deps.queueRepo!.create({
      sourceSession: "architect@ops-rig",
      destinationSession: "builder@ops-rig",
      summary: "Cutover verification gate",
      body: "Waiting on human confirmation before cutover.",
      evidenceRef: "docs/cutover.md",
      nudge: false,
    });
    daemon.deps.queueRepo!.claim({
      qitemId: parked.qitemId,
      destinationSession: "builder@ops-rig",
      actorSession: "builder@ops-rig",
    });
    daemon.deps.queueRepo!.update({
      qitemId: parked.qitemId,
      actorSession: "builder@ops-rig",
      state: "blocked",
      closureReason: "blocked_on",
      closureTarget: "alice-ops@external",
      blockedOn: "alice-ops@external",
      transitionNote: "Parked on alice-ops for Episode 1",
      ownerNotificationLevel: "ALERT",
      ownerNotificationKind: "human-required",
    });

    await sweepOutboundOnce(daemon);
    await waitForCondition(() => bridge.getCustodyRecords().length === 1);
    const parkEp1Record = bridge.getCustodyRecords()[0]!;
    expect(parkEp1Record.envelope.replyRef).not.toBeNull();

    const uncertainRes = await bridge.sendInboundReply(running.baseUrl, {
      eventId: "evt-park-uncertain-1",
      sender: { handle: "alice_ops" },
      replyRef: parkEp1Record.envelope.replyRef!,
      text: "Check staging logs first, then proceed.",
      ordering: "uncertain",
    });
    expect(uncertainRes.status).toBe(200);

    const resumedPark = daemon.deps.queueRepo!.getById(parked.qitemId)!;
    expect(resumedPark.state).toBe("in-progress");
    const latestParkNote =
      daemon.deps.queueRepo!.listTransitions(parked.qitemId).at(-1)?.transitionNote ?? "";
    expect(latestParkNote).toContain("Check staging logs first, then proceed.");
    expect(latestParkNote).toMatch(/ordering=uncertain/i);

    // Re-park into Episode 2 -> Episode 1 replyRef rejected (409)
    daemon.deps.queueRepo!.update({
      qitemId: parked.qitemId,
      actorSession: "builder@ops-rig",
      state: "blocked",
      closureReason: "blocked_on",
      closureTarget: "alice-ops@external",
      blockedOn: "alice-ops@external",
      transitionNote: "Re-parked on alice-ops for Episode 2",
      ownerNotificationLevel: "ALERT",
      ownerNotificationKind: "human-required",
    });

    const staleEp1Res = await bridge.sendInboundReply(running.baseUrl, {
      eventId: "evt-park-stale-ep1",
      sender: { handle: "alice_ops" },
      replyRef: parkEp1Record.envelope.replyRef!,
      text: "Late reply to Episode 1",
      ordering: "after-question",
    });
    expect(staleEp1Res.status).toBe(409);
    expect(daemon.deps.queueRepo!.getById(parked.qitemId)?.state).toBe("blocked");

    // Second registered person (`bob_peer`) answers `alice_ops`'s ask with real attribution
    const ask1 = await daemon.deps.queueRepo!.create({
      sourceSession: "architect@ops-rig",
      destinationSession: "alice-ops@external",
      summary: "Primary ask for Alice",
      body: "Which region should we drain first?",
      humanIntent: "decision",
      humanAlert: true,
      humanQuestions: [
        {
          id: "q-region",
          header: "Region",
          question: "Which region?",
          options: [
            { id: "us-east", label: "us-east", description: "East" },
            { id: "eu-west", label: "eu-west", description: "West" },
          ],
        },
      ],
      nudge: false,
    });

    const askAtomic = await daemon.deps.queueRepo!.create({
      sourceSession: "architect@ops-rig",
      destinationSession: "alice-ops@external",
      summary: "Atomic close+audit ask",
      body: "Confirm atomic close and audit recovery?",
      humanIntent: "decision",
      humanAlert: true,
      nudge: false,
    });

    const askLedger = await daemon.deps.queueRepo!.create({
      sourceSession: "architect@ops-rig",
      destinationSession: "alice-ops@external",
      summary: "Scoped seen-ledger ask",
      body: "Confirm healthy key works alongside keyed suspect entry?",
      humanIntent: "decision",
      humanAlert: true,
      nudge: false,
    });

    await sweepOutboundOnce(daemon);
    await waitForCondition(() => {
      const summaries = new Set(
        bridge.getCustodyRecords().map((r) => r.envelope.summary),
      );
      return (
        summaries.has("Primary ask for Alice") &&
        summaries.has("Atomic close+audit ask") &&
        summaries.has("Scoped seen-ledger ask")
      );
    });
    const ask1Record = bridge
      .getCustodyRecords()
      .find((r) => r.envelope.summary === "Primary ask for Alice")!;
    const askAtomicRecord = bridge
      .getCustodyRecords()
      .find((r) => r.envelope.summary === "Atomic close+audit ask")!;
    const askLedgerRecord = bridge
      .getCustodyRecords()
      .find((r) => r.envelope.summary === "Scoped seen-ledger ask")!;

    const bobRes = await bridge.sendInboundReply(running.baseUrl, {
      eventId: "evt-bob-answer-1",
      sender: { handle: "bob_peer" },
      replyRef: ask1Record.envelope.replyRef!,
      text: "Drain us-east first.",
      ordering: "after-question",
    });
    expect(bobRes.status).toBe(200);
    expect(bobRes.body).toMatchObject({
      ok: true,
      qitemId: ask1.qitemId,
      actorSession: "bob-peer@external",
      deduplicated: false,
    });

    const bobAnswerRow = daemon.deps.queueRepo!.getHumanAnswer(
      ask1.qitemId,
      "bob-peer@external",
    );
    expect(bobAnswerRow?.sourceSession).toBe("bob-peer@external");
    expect(bobAnswerRow?.body).toContain(
      "Answered by bob-peer@external, a registered person, on alice-ops@external's ask",
    );

    const bobDupRes = await bridge.sendInboundReply(running.baseUrl, {
      eventId: "evt-bob-answer-1",
      sender: { handle: "bob_peer" },
      replyRef: ask1Record.envelope.replyRef!,
      text: "Drain us-east first.",
      ordering: "after-question",
    });
    expect(bobDupRes.status).toBe(200);
    expect(bobDupRes.body.deduplicated).toBe(true);

    const eqTextRes = await bridge.sendInboundReply(running.baseUrl, {
      eventId: "evt-bob-answer-1",
      sender: { handle: "bob_peer" },
      replyRef: ask1Record.envelope.replyRef!,
      text: "Drain eu-west instead.",
      ordering: "after-question",
    });
    expect(eqTextRes.status).toBe(409);

    // Atomic close+audit recovery: simulated audit write throw rolls back ask close while preserving
    // the reply row and received:<fp>; retry under the original replyRef succeeds without duplicate reply rows.
    const actionLog = daemon.deps.missionControlActionLog!;
    const origRecord = actionLog.record.bind(actionLog);
    let threwOnce = false;
    actionLog.record = ((entry: Parameters<typeof origRecord>[0]) => {
      if (!threwOnce) {
        threwOnce = true;
        throw new Error("simulated audit failure inside atomic close+audit transaction");
      }
      return origRecord(entry);
    }) as typeof actionLog.record;

    try {
      const crashRes = await bridge.sendInboundReply(running.baseUrl, {
        eventId: "evt-atomic-crash-1",
        sender: { handle: "alice_ops" },
        replyRef: askAtomicRecord.envelope.replyRef!,
        text: "Approve atomic close.",
        ordering: "after-question",
      });
      expect(crashRes.status).toBe(500);
      expect(daemon.deps.queueRepo!.getById(askAtomic.qitemId)?.state).toBe("pending");
      expect(
        daemon.deps.queueRepo!.listHumanAnswers(askAtomic.qitemId, "alice-ops@external"),
      ).toHaveLength(1);
    } finally {
      actionLog.record = origRecord;
    }

    const recoveredRes = await bridge.sendInboundReply(running.baseUrl, {
      eventId: "evt-atomic-crash-1",
      sender: { handle: "alice_ops" },
      replyRef: askAtomicRecord.envelope.replyRef!,
      text: "Approve atomic close.",
      ordering: "after-question",
    });
    expect(recoveredRes.status).toBe(200);
    expect(recoveredRes.body).toMatchObject({
      ok: true,
      qitemId: askAtomic.qitemId,
      actorSession: "alice-ops@external",
      deduplicated: false,
    });
    expect(daemon.deps.queueRepo!.getById(askAtomic.qitemId)?.state).toBe("done");
    expect(
      daemon.deps.queueRepo!.listHumanAnswers(askAtomic.qitemId, "alice-ops@external"),
    ).toHaveLength(1);

    const postRecoveryDupRes = await bridge.sendInboundReply(running.baseUrl, {
      eventId: "evt-atomic-crash-1",
      sender: { handle: "alice_ops" },
      replyRef: askAtomicRecord.envelope.replyRef!,
      text: "Approve atomic close.",
      ordering: "after-question",
    });
    expect(postRecoveryDupRes.status).toBe(200);
    expect(postRecoveryDupRes.body.deduplicated).toBe(true);

    // Scoped seen-ledger handling: keyed suspect record scopes 503 to that eventId only;
    // unrelated keys still succeed; unkeyable/corrupt JSONL returns 503.
    const seenFilePath = join(OPENRIG_HOME, "state", RELAY_INBOUND_SEEN_FILE);
    const suspectKey = computeRelayEventKey("local-bridge", "evt-suspect-only");
    writeFileSync(
      seenFilePath,
      `${readFileSync(seenFilePath, "utf8")}${JSON.stringify({ id: suspectKey, status: "corrupt-status" })}\n`,
      "utf8",
    );

    const suspectRes = await bridge.sendInboundReply(running.baseUrl, {
      eventId: "evt-suspect-only",
      sender: { handle: "alice_ops" },
      replyRef: askLedgerRecord.envelope.replyRef!,
      text: "Blocked by suspect record",
      ordering: "after-question",
    });
    expect(suspectRes.status).toBe(503);
    expect(daemon.deps.queueRepo!.getById(askLedger.qitemId)?.state).toBe("pending");

    const healthyRes = await bridge.sendInboundReply(running.baseUrl, {
      eventId: "evt-ledger-healthy-1",
      sender: { handle: "alice_ops" },
      replyRef: askLedgerRecord.envelope.replyRef!,
      text: "Healthy event settles askLedger.",
      ordering: "after-question",
    });
    expect(healthyRes.status).toBe(200);
    expect(healthyRes.body).toMatchObject({
      ok: true,
      qitemId: askLedger.qitemId,
      deduplicated: false,
    });
    expect(daemon.deps.queueRepo!.getById(askLedger.qitemId)?.state).toBe("done");

    writeFileSync(
      seenFilePath,
      `${readFileSync(seenFilePath, "utf8")}{corrupt-unparseable-jsonl\n`,
      "utf8",
    );
    const corruptLedgerRes = await bridge.sendInboundReply(running.baseUrl, {
      eventId: "evt-ledger-after-corrupt",
      sender: { handle: "alice_ops" },
      replyRef: askLedgerRecord.envelope.replyRef!,
      text: "Refused due to corrupt ledger",
      ordering: "after-question",
    });
    expect(corruptLedgerRes.status).toBe(503);
  });

  it("warns on permissive 0644/shared-token relay config while remaining ready, localizes missing/ambiguous/invalid auth without secret leaks, and preserves default no-relay/Slack behavior", async () => {
    const outboundToken = "sec-relay-out-integration-05";
    const inboundToken = "sec-relay-in-integration-05";
    const sharedToken = "sec-relay-shared-integration-05";
    const custodyFilePath = join(testScratchDir, "bridge-custody-auth.jsonl");

    const bridge = await startRecordingRelay({
      custodyFilePath,
      outboundToken,
      inboundToken,
    });
    activeBridges.push(bridge);

    // Default no-relay daemon boots with active subsystem and inert Slack connector (see slack-subsystem-cutover.test.ts).
    const defaultDaemon = await bootProductionDaemon({ startPostBind: true });
    const healthRes = await fetch(`${defaultDaemon.baseUrl}/api/health-summary/gateway`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toMatchObject({
      state: "active",
      connector: { platform: "slack", outboundReady: false },
    });
    await defaultDaemon.stop();
    activeDaemons.pop();

    // Provision relay with 0644 permissions + shared directional token -> ready: true with redacted warnings, no secret leak.
    const envPath = writeRelaySecretsFile(
      join(testScratchDir, "relay-permissive.env"),
      { url: bridge.outboundUrl, outboundToken: sharedToken, inboundToken: sharedToken },
      0o644,
    );
    registerRelayPerson({
      entityId: "alice-ops",
      displayName: "Alice Ops",
      connectorRef: "local-bridge",
      envFilePath: envPath,
      handle: "alice_ops",
    });

    const running = await bootProductionDaemon({ startPostBind: true });
    const permissiveRes = await fetch(
      `${running.baseUrl}/api/gateway/human/alice-ops/readiness`,
    );
    expect(permissiveRes.status).toBe(200);
    const permissiveJson = (await permissiveRes.json()) as {
      ok: boolean;
      readiness: { state: string; ready: boolean; reason?: string };
    };
    expect(permissiveJson).toMatchObject({
      ok: true,
      readiness: { state: "ready", ready: true },
    });
    expect(permissiveJson.readiness.reason ?? "").toMatch(/warning/i);
    expect(permissiveJson.readiness.reason ?? "").toMatch(/0644/);
    expect(permissiveJson.readiness.reason ?? "").toMatch(/same token|separate tokens/i);
    expect(JSON.stringify(permissiveJson)).not.toContain(sharedToken);

    // Strict 0400 permissions + distinct tokens -> ready: true with no warning.
    writeRelaySecretsFile(
      envPath,
      { url: bridge.outboundUrl, outboundToken, inboundToken },
      0o400,
    );
    const strict0400Res = await fetch(
      `${running.baseUrl}/api/gateway/human/alice-ops/readiness`,
    );
    expect(strict0400Res.status).toBe(200);
    const strict0400Json = (await strict0400Res.json()) as {
      ok: boolean;
      readiness: { state: string; ready: boolean; reason?: string };
    };
    expect(strict0400Json).toMatchObject({
      ok: true,
      readiness: { state: "ready", ready: true },
    });
    expect(strict0400Json.readiness.reason ?? "").not.toMatch(/warning/i);

    // Missing required credential key -> localized not-ready, no secret leak.
    chmodSync(envPath, 0o600);
    writeFileSync(
      envPath,
      `OPENRIG_RELAY_URL=${bridge.outboundUrl}\nOPENRIG_RELAY_OUTBOUND_TOKEN=${outboundToken}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const missingKeyRes = await fetch(
      `${running.baseUrl}/api/gateway/human/alice-ops/readiness`,
    );
    expect(missingKeyRes.status).toBe(200);
    const missingKeyJson = (await missingKeyRes.json()) as Record<string, unknown>;
    expect(missingKeyJson).toMatchObject({
      ok: true,
      readiness: { state: "not-ready", ready: false },
    });
    expect(JSON.stringify(missingKeyJson)).not.toContain(outboundToken);

    // Restore valid distinct credentials on local-bridge; register second connector profile reusing the same inbound token -> ambiguous not-ready + 401.
    writeRelaySecretsFile(
      envPath,
      { url: bridge.outboundUrl, outboundToken, inboundToken },
      0o600,
    );
    const dupEnvPath = writeRelaySecretsFile(
      join(testScratchDir, "relay-second-profile.env"),
      {
        url: bridge.outboundUrl,
        outboundToken: "sec-relay-out-second-05",
        inboundToken,
      },
      0o600,
    );
    registerRelayPerson({
      entityId: "bob-dup",
      displayName: "Bob Dup",
      connectorRef: "second-bridge",
      envFilePath: dupEnvPath,
      handle: "bob_dup",
    });

    const ambigReadinessRes = await fetch(
      `${running.baseUrl}/api/gateway/human/alice-ops/readiness`,
    );
    expect(ambigReadinessRes.status).toBe(200);
    expect(await ambigReadinessRes.json()).toMatchObject({
      ok: true,
      readiness: { state: "not-ready", ready: false },
    });

    const ambigInboundRes = await bridge.sendInboundReply(running.baseUrl, {
      eventId: "evt-ambig-1",
      sender: { handle: "alice_ops" },
      replyRef: "forged",
      text: "Ambiguous inbound token must fail",
    });
    expect(ambigInboundRes.status).toBe(401);

    // Give second-bridge its own distinct inbound token so local-bridge is unambiguous again.
    writeRelaySecretsFile(
      dupEnvPath,
      {
        url: bridge.outboundUrl,
        outboundToken: "sec-relay-out-second-05",
        inboundToken: "sec-relay-in-second-05",
      },
      0o600,
    );

    const unauthRes = await bridge.sendInboundReply(
      running.baseUrl,
      {
        eventId: "evt-unauth-1",
        sender: { handle: "alice_ops" },
        replyRef: "forged",
        text: "Should fail",
      },
      { tokenOverride: null },
    );
    expect(unauthRes.status).toBe(401);

    const wrongTokenRes = await bridge.sendInboundReply(
      running.baseUrl,
      {
        eventId: "evt-unauth-2",
        sender: { handle: "alice_ops" },
        replyRef: "forged",
        text: "Should fail",
      },
      { tokenOverride: outboundToken },
    );
    expect(wrongTokenRes.status).toBe(401);
    expect(JSON.stringify(wrongTokenRes.body)).not.toContain(outboundToken);
    expect(JSON.stringify(wrongTokenRes.body)).not.toContain(inboundToken);

    const badBridgePost = await fetch(bridge.outboundUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${inboundToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        v: 1,
        deliveryId: "dec-unauth",
        recipient: { handle: "alice_ops" },
        intent: "decision",
        outcome: "interrupt",
        summary: "Test",
        body: "Test",
        replyRef: null,
      }),
    });
    expect(badBridgePost.status).toBe(401);
    expect(bridge.getSanitizedStats().unauthorizedCount).toBe(1);
    expect(bridge.getCustodyRecords()).toHaveLength(0);
  });
});
