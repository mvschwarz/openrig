import { afterEach, describe, expect, it, vi } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { createTestApp } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { GatewaySubsystem } from "../src/domain/gateway/gateway-subsystem.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { addHumanFragment, loadHumanRegistry, resolveSlackHandle, setHumanField } from "../src/domain/gateway/human-registry.js";
import { HumanQuietStore } from "../src/domain/gateway/human-quiet-windows.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { QUIET_RELEASE_POLICY, runQuietRelease } from "../src/domain/policies/quiet-release.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";
import {
  encodeRelayReplyRef,
  hashRelayReplyRef,
  prepareRelayDecision,
  relayStatePaths,
  type RelayReplyRefPayload,
} from "../src/domain/gateway/relay-outbound.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { nodeSecretFs } from "../src/domain/gateway/slack/secrets.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import {
  RELAY_INBOUND_SEEN_FILE,
  computeRelayEventFingerprint,
  computeRelayEventKey,
  createRelayInboundHandler,
} from "../src/domain/gateway/relay-inbound.js";

interface DaemonHandles {
  app: Hono;
  db: Database.Database;
  queueRepo: QueueRepository;
  missionControlActionLog: MissionControlActionLog;
  missionControlWriteContract: MissionControlWriteContract;
  gatewaySubsystem: GatewaySubsystem;
}

interface RelayFixture {
  home: string;
  db: Database.Database;
  daemon: DaemonHandles;
  server: ServerType;
  baseUrl: string;
  inboundTokenMain: string;
  outboundTokenMain: string;
  inboundTokenSecondary: string;
  outboundTokenSecondary: string;
}

const fixtures: RelayFixture[] = [];
const savedOpenRigHome = process.env.OPENRIG_HOME;

afterEach(async () => {
  if (savedOpenRigHome === undefined) {
    delete process.env.OPENRIG_HOME;
  } else {
    process.env.OPENRIG_HOME = savedOpenRigHome;
  }
  while (fixtures.length > 0) {
    const f = fixtures.pop()!;
    f.daemon.gatewaySubsystem.stop();
    await new Promise<void>((resolve) => f.server.close(() => resolve()));
    f.db.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

function writeRelayEnvFile(
  home: string,
  fileName: string,
  vars: Record<string, string>,
  mode = 0o600,
): string {
  const secretsDir = join(home, "secrets");
  mkdirSync(secretsDir, { recursive: true });
  const filePath = join(secretsDir, fileName);
  const content = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
  writeFileSync(filePath, content, { mode });
  chmodSync(filePath, mode);
  return filePath;
}

async function createRelayFixture(opts?: {
  configureMainSecret?: boolean;
  mainSecretMode?: number;
  mainVars?: Record<string, string>;
  registerPartner?: boolean;
  registerSecondaryRelay?: boolean;
  secondaryVars?: Record<string, string>;
  missionControlBearerToken?: string | null;
}): Promise<RelayFixture> {
  const home = mkdtempSync(join(tmpdir(), "relay-inbound-test-"));
  writeFileSync(join(home, ".openrig-fixture"), "");
  process.env.OPENRIG_HOME = home;

  const inboundTokenMain = "relay-in-secret-main-token-001";
  const outboundTokenMain = "relay-out-secret-main-token-001";
  const inboundTokenSecondary = "relay-in-secret-sec-token-002";
  const outboundTokenSecondary = "relay-out-secret-sec-token-002";
  const mainEnvPath = join(home, "secrets", "relay-main.env");
  const secEnvPath = join(home, "secrets", "relay-sec.env");

  if (opts?.configureMainSecret !== false) {
    writeRelayEnvFile(
      home,
      "relay-main.env",
      opts?.mainVars ?? {
        OPENRIG_RELAY_URL: "http://127.0.0.1:19876/outbound",
        OPENRIG_RELAY_OUTBOUND_TOKEN: outboundTokenMain,
        OPENRIG_RELAY_INBOUND_TOKEN: inboundTokenMain,
      },
      opts?.mainSecretMode ?? 0o600,
    );
  }

  addHumanFragment(
    {
      entityId: "founder",
      class: "human",
      displayName: "Founder",
      address: "founder@external",
      connectorBindings: [
        {
          kind: "relay",
          connectorRef: "relay-main",
          handle: "founder-handle",
          secretsRef: `file:${mainEnvPath}`,
          role: "primary",
        },
      ],
      prefs: { deliveryClass: "A" },
    },
    home,
  );

  if (opts?.registerPartner !== false) {
    addHumanFragment(
      {
        entityId: "partner",
        class: "human",
        displayName: "Partner",
        address: "partner@external",
        connectorBindings: [
          {
            kind: "relay",
            connectorRef: "relay-main",
            handle: "partner-handle",
            secretsRef: `file:${mainEnvPath}`,
            role: "primary",
          },
        ],
        prefs: { deliveryClass: "A" },
      },
      home,
    );
  }

  if (opts?.registerSecondaryRelay) {
    writeRelayEnvFile(
      home,
      "relay-sec.env",
      opts.secondaryVars ?? {
        OPENRIG_RELAY_URL: "http://127.0.0.1:19877/outbound",
        OPENRIG_RELAY_OUTBOUND_TOKEN: outboundTokenSecondary,
        OPENRIG_RELAY_INBOUND_TOKEN: inboundTokenSecondary,
      },
      0o600,
    );
    addHumanFragment(
      {
        entityId: "ops",
        class: "human",
        displayName: "Ops",
        address: "ops@external",
        connectorBindings: [
          {
            kind: "relay",
            connectorRef: "relay-sec",
            handle: "ops-handle",
            secretsRef: `file:${secEnvPath}`,
            role: "primary",
          },
        ],
        prefs: { deliveryClass: "A" },
      },
      home,
    );
  }

  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const eventBus = new EventBus(db);
  const queueRepo = new QueueRepository(db, eventBus, {
    validateRig: () => true,
    loadHumanRegistry: () => loadHumanRegistry(home),
  });
  const outbox = new OutboxHandler(db);
  queueRepo.attachOutbox(outbox);
  const missionControlActionLog = new MissionControlActionLog(db);
  const missionControlWriteContract = new MissionControlWriteContract({
    db,
    eventBus,
    queueRepo,
    actionLog: missionControlActionLog,
  });
  const gatewaySubsystem = new GatewaySubsystem({
    home,
    wire: () =>
      buildSlackGatewayWire({
        home,
        queueRepo,
        resolveHumanReply: makeHumanReplyResolver(queueRepo, missionControlWriteContract, home),
      }),
  });
  gatewaySubsystem.start();
  const relayInboundHandler = createRelayInboundHandler({
    home,
    queueRepo,
    missionControlWriteContract,
    missionControlActionLog,
  });
  const { app } = createTestApp(db, {
    appDeps: {
      queueRepo,
      outboxHandler: outbox,
      missionControlActionLog,
      missionControlWriteContract,
      gatewaySubsystem,
      relayInboundHandler,
      missionControlBearerToken: opts?.missionControlBearerToken ?? null,
    },
  });
  const daemon: DaemonHandles = {
    app,
    db,
    queueRepo,
    missionControlActionLog,
    missionControlWriteContract,
    gatewaySubsystem,
  };

  let server!: ServerType;
  const port = await new Promise<number>((resolve) => {
    server = serve(
      {
        fetch: daemon.app.fetch,
        hostname: "127.0.0.1",
        port: 0,
      },
      (info: AddressInfo) => resolve(info.port),
    );
  });

  const fixture: RelayFixture = {
    home,
    db,
    daemon,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    inboundTokenMain,
    outboundTokenMain,
    inboundTokenSecondary,
    outboundTokenSecondary,
  };
  fixtures.push(fixture);
  return fixture;
}

async function createAskWithAcceptedRelayRef(
  f: RelayFixture,
  opts?: {
    destinationSession?: string;
    connectorRef?: string;
    summary?: string;
    body?: string;
    humanIntent?: "decision" | "update";
    recordViaPendingBufferOnly?: boolean;
    markAttempted?: boolean;
  },
): Promise<{ qitemId: string; replyRef: string; payload: RelayReplyRefPayload }> {
  const destinationSession = opts?.destinationSession ?? "founder@external";
  const connectorRef = opts?.connectorRef ?? "relay-main";
  const isUpdate = opts?.humanIntent === "update";
  const created = await f.daemon.queueRepo.create({
    sourceSession: "architect@rig",
    destinationSession,
    summary: opts?.summary ?? "Architecture sign-off needed",
    body: opts?.body ?? "Should we proceed with Option A or Option B?",
    evidenceRef: "docs/arch-decision.md",
    humanIntent: opts?.humanIntent ?? "decision",
    ...(isUpdate
      ? {}
      : {
          humanAlert: true,
          humanQuestions: [
            {
              id: "q-arch",
              header: "Architecture",
              question: "Which option should we ship?",
              options: [
                { id: "opt-a", label: "Option A", description: "Strict local boundary" },
                { id: "opt-b", label: "Option B", description: "Deferred boundary" },
              ],
            },
          ],
        }),
    nudge: false,
  });

  const item = f.daemon.queueRepo.getById(created.qitemId)!;
  const transitions = f.daemon.queueRepo.listTransitions(created.qitemId);
  const fallbackTransition = transitions[transitions.length - 1]!;
  const episodeKey = isUpdate
    ? `${created.qitemId}:${fallbackTransition.transitionId}`
    : f.daemon.queueRepo.currentHumanRequiredEpisode(created.qitemId)!.key;
  const decisionRevision = f.daemon.queueRepo.decisionRevision(item);
  const decisionId = `dec-${episodeKey.replace(":", "-")}`;

  const payload: RelayReplyRefPayload = {
    v: 1,
    qitemId: created.qitemId,
    episodeKey,
    decisionRevision,
    decisionId,
    connectorRef,
    mode: "ask",
  };
  const replyRef = encodeRelayReplyRef(payload);

  if (opts?.recordViaPendingBufferOnly) {
    const buffer = new DispatchBuffer(f.home);
    const prepared = prepareRelayDecision(
      {
        kind: "outbound_decision",
        decisionId,
        op: OUTBOUND_OP,
        entityBindingRef: destinationSession,
        payload: {
          qitemId: created.qitemId,
          notificationKey: episodeKey,
          destinationSession,
          summary: item.summary,
          body: item.body,
          humanIntent: item.humanIntent,
          ownerNotificationKind: isUpdate ? "human-update" : "human-required",
          ownerNotificationLevel: "ALERT",
        },
        enqueuedAt: new Date().toISOString(),
      },
      {
        loadHumanRegistry: () => loadHumanRegistry(f.home),
        queueRepo: f.daemon.queueRepo,
        resolveOutcome: () => "interrupt",
      },
    );
    buffer.enqueue(prepared);
    if (opts?.markAttempted !== false) {
      new SeenStore(relayStatePaths(f.home).attemptedPath).mark(
        decisionId,
        `attempted:${connectorRef}:interrupt`,
      );
    }
  } else {
    f.daemon.queueRepo.recordRelayOwnerNotificationAccepted({
      qitemId: created.qitemId,
      actorSession: "relay-connector",
      notificationKey: episodeKey,
      connectorRef,
      deliveryId: decisionId,
      replyRef,
      replyRefHash: hashRelayReplyRef(replyRef),
      revision: decisionRevision,
      level: "ALERT",
      kind: isUpdate ? "human-update" : "human-required",
      closeUpdate: false,
    });
  }

  return { qitemId: created.qitemId, replyRef, payload };
}

async function createParkedItemWithAcceptedRelayRef(
  f: RelayFixture,
  opts?: {
    blockedOn?: string;
    connectorRef?: string;
    summary?: string;
    body?: string;
    withHumanQuestions?: boolean;
  },
): Promise<{ qitemId: string; replyRef: string; payload: RelayReplyRefPayload }> {
  const blockedOn = opts?.blockedOn ?? "founder@external";
  const connectorRef = opts?.connectorRef ?? "relay-main";
  const created = await f.daemon.queueRepo.create({
    sourceSession: "architect@rig",
    destinationSession: "builder@rig",
    summary: opts?.summary ?? "Release approval gate",
    body: opts?.body ?? "Waiting on founder sign-off for release cut.",
    evidenceRef: "docs/release-plan.md",
    nudge: false,
  });

  if (opts?.withHumanQuestions) {
    f.daemon.db
      .prepare("UPDATE queue_items SET human_questions = ? WHERE qitem_id = ?")
      .run(
        JSON.stringify([
          {
            id: "q-release",
            header: "Release",
            question: "Can we cut the release?",
            options: [{ id: "yes", label: "Yes", description: "Cut now" }],
          },
        ]),
        created.qitemId,
      );
  }

  f.daemon.queueRepo.claim({
    qitemId: created.qitemId,
    destinationSession: "builder@rig",
  });
  f.daemon.queueRepo.update({
    qitemId: created.qitemId,
    actorSession: "builder@rig",
    state: "blocked",
    closureReason: "blocked_on",
    closureTarget: blockedOn,
    blockedOn,
    transitionNote: "Parked on founder for release sign-off",
  });

  const item = f.daemon.queueRepo.getById(created.qitemId)!;
  const episodeKey = f.daemon.queueRepo.currentHumanRequiredEpisode(created.qitemId)!.key;
  const decisionRevision = f.daemon.queueRepo.decisionRevision(item);
  const decisionId = `dec-${episodeKey.replace(":", "-")}`;

  const payload: RelayReplyRefPayload = {
    v: 1,
    qitemId: created.qitemId,
    episodeKey,
    decisionRevision,
    decisionId,
    connectorRef,
    mode: "park",
  };
  const replyRef = encodeRelayReplyRef(payload);

  f.daemon.queueRepo.recordRelayOwnerNotificationAccepted({
    qitemId: created.qitemId,
    actorSession: "relay-connector",
    notificationKey: episodeKey,
    connectorRef,
    deliveryId: decisionId,
    replyRef,
    replyRefHash: hashRelayReplyRef(replyRef),
    revision: decisionRevision,
    level: "ALERT",
    kind: "human-required",
  });

  return { qitemId: created.qitemId, replyRef, payload };
}

describe("POST /api/gateway/relay/inbound — boundary, auth, semantics, durability & composition", () => {
  it("enforces real TCP loopback peer and rejects in-process requests without a socket, non-loopback peers, forwarding headers, and browser origins", async () => {
    const f = await createRelayFixture();
    const { qitemId, replyRef } = await createAskWithAcceptedRelayRef(f);
    const validBody = {
      eventId: "evt-loopback-1",
      sender: { handle: "founder-handle" },
      replyRef,
      text: "Approve Option A",
      ordering: "after-question",
    };

    // 1. In-process app.request has no real TCP socket remoteAddress -> must be rejected (403)
    const inMemoryRes = await f.daemon.app.request("/api/gateway/relay/inbound", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:7433",
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody),
    });
    expect(inMemoryRes.status).toBe(403);

    // 2. Non-loopback TCP socket peer is rejected even if Host claims 127.0.0.1
    const nonLoopbackRes = await f.daemon.app.fetch(
      new Request("http://127.0.0.1:7433/api/gateway/relay/inbound", {
        method: "POST",
        headers: {
          Host: "127.0.0.1:7433",
          Authorization: `Bearer ${f.inboundTokenMain}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(validBody),
      }),
      { incoming: { socket: { remoteAddress: "100.64.0.12" } } } as never,
    );
    expect(nonLoopbackRes.status).toBe(403);

    // 3. Browser boundary rejects cross-origin and untrusted Host requests (403)
    const crossOriginRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        Origin: "http://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody),
    });
    expect(crossOriginRes.status).toBe(403);

    // Verify qitem is still untouched (pending) after all boundary rejections
    expect(f.daemon.queueRepo.getById(qitemId)?.state).toBe("pending");

    // 4. Forwarding / proxy headers (Via, X-Forwarded-*, Forwarded, X-Real-Ip) over a direct loopback TCP peer are ignored
    const withForwardingHeadersRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
        Via: "1.1 local-bridge",
        "X-Forwarded-For": "203.0.113.9",
        "X-Forwarded-Host": "relay.example",
        "X-Forwarded-Proto": "https",
        Forwarded: "for=203.0.113.9;proto=https",
        "X-Real-Ip": "203.0.113.9",
      },
      body: JSON.stringify(validBody),
    });
    expect(withForwardingHeadersRes.status).toBe(200);
    expect(f.daemon.queueRepo.getById(qitemId)?.state).toBe("done");
  });

  it("enforces explicit relay bearer token authentication and never allows null-token bypass when unready", async () => {
    // Unconfigured secret file -> unready profile, never bypasses auth
    const unconfigured = await createRelayFixture({ configureMainSecret: false });
    const { qitemId: unreadyQitem, replyRef: unreadyRef } = await createAskWithAcceptedRelayRef(unconfigured);

    const noHeaderOnUnready = await fetch(`${unconfigured.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: "evt-auth-1",
        sender: { handle: "founder-handle" },
        replyRef: unreadyRef,
        text: "Bypass attempt",
      }),
    });
    expect(noHeaderOnUnready.status).toBe(401);
    expect(unconfigured.daemon.queueRepo.getById(unreadyQitem)?.state).toBe("pending");

    // Missing inbound token in env file -> unready profile, rejects and never leaks outbound secret
    const missingInbound = await createRelayFixture({
      mainVars: {
        OPENRIG_RELAY_URL: "http://127.0.0.1:19876/outbound",
        OPENRIG_RELAY_OUTBOUND_TOKEN: "relay-out-secret-main-token-001",
      },
    });
    const { replyRef: missingInboundRef } = await createAskWithAcceptedRelayRef(missingInbound);
    const missingInboundRes = await fetch(`${missingInbound.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${missingInbound.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-auth-2",
        sender: { handle: "founder-handle" },
        replyRef: missingInboundRef,
        text: "Should fail due to missing inbound token",
      }),
    });
    expect(missingInboundRes.status).toBe(401);
    const missingInboundBodyText = await missingInboundRes.text();
    expect(missingInboundBodyText).not.toContain(missingInbound.inboundTokenMain);
    expect(missingInboundBodyText).not.toContain(missingInbound.outboundTokenMain);

    // Configured ready profile: test missing bearer, wrong bearer, and outbound token used on inbound
    const f = await createRelayFixture({
      registerSecondaryRelay: true,
      // Duplicate inbound token on secondary profile to test ambiguous token rejection
      secondaryVars: {
        OPENRIG_RELAY_URL: "http://127.0.0.1:19877/outbound",
        OPENRIG_RELAY_OUTBOUND_TOKEN: "unique-out-sec",
        OPENRIG_RELAY_INBOUND_TOKEN: "relay-in-secret-main-token-001",
      },
    });
    const { replyRef: dupRef } = await createAskWithAcceptedRelayRef(f);
    const ambiguousRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-auth-ambiguous",
        sender: { handle: "founder-handle" },
        replyRef: dupRef,
        text: "Ambiguous token",
      }),
    });
    expect(ambiguousRes.status).toBe(401);

    const ready = await createRelayFixture();
    const { replyRef: readyRef } = await createAskWithAcceptedRelayRef(ready);
    for (const badAuth of [
      undefined,
      "Basic Zm9vOmJhcg==",
      "Bearer ",
      "Bearer wrong-token",
      `Bearer ${ready.outboundTokenMain}`, // Outbound token must be rejected on inbound
    ]) {
      const res = await fetch(`${ready.baseUrl}/api/gateway/relay/inbound`, {
        method: "POST",
        headers: {
          ...(badAuth ? { Authorization: badAuth } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          eventId: "evt-auth-3",
          sender: { handle: "founder-handle" },
          replyRef: readyRef,
          text: "Attempt",
        }),
      });
      expect(res.status, `auth=${String(badAuth)}`).toBe(401);
      const errText = await res.text();
      expect(errText).not.toContain(ready.inboundTokenMain);
      expect(errText).not.toContain(ready.outboundTokenMain);
    }
  });

  it("preserves existing /api/gateway/slack/forwarded hub protocol alongside /api/gateway/relay/inbound", async () => {
    const f = await createRelayFixture({ missionControlBearerToken: "hub-forward-token-999" });

    const unauthForward = await fetch(`${f.baseUrl}/api/gateway/slack/forwarded`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "event_callback" }),
    });
    expect(unauthForward.status).toBe(401);

    const authForward = await fetch(`${f.baseUrl}/api/gateway/slack/forwarded`, {
      method: "POST",
      headers: {
        Authorization: "Bearer hub-forward-token-999",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ envelope: { type: "event_callback" } }),
    });
    // Slack forwarding isn't active in a relay-only fixture so subsystem returns 503 not-active, proving route & token still work
    expect(authForward.status).toBe(503);
  });

  it("validates bounded JSON schema and size limits while accepting and ignoring harmless extra top-level and sender fields", async () => {
    const f = await createRelayFixture();
    const { qitemId, replyRef } = await createAskWithAcceptedRelayRef(f);

    // Malformed JSON
    const malformed = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: "{bad json",
    });
    expect(malformed.status).toBe(400);

    // Invalid ordering value
    const badOrdering = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-schema-3",
        sender: { handle: "founder-handle" },
        replyRef,
        text: "Hello",
        ordering: "verified",
      }),
    });
    expect(badOrdering.status).toBe(400);

    // Oversized body (> 64 KiB)
    const oversized = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-schema-big",
        sender: { handle: "founder-handle" },
        replyRef,
        text: "x".repeat(70_000),
      }),
    });
    expect(oversized.status).toBe(413);

    // Harmless extra top-level and sender fields are accepted and ignored (never overriding handle attribution)
    const withExtras = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-schema-extras-ok",
        sender: {
          handle: "founder-handle",
          displayName: "Founder Extra",
          entityId: "partner",
        },
        replyRef,
        text: "Approve Option A with extra fields ignored",
        ordering: "after-question",
        actorSession: "partner@external",
        bridgeMeta: { bridgeVersion: "1.0.0" },
      }),
    });
    expect(withExtras.status).toBe(200);
    expect(await withExtras.json()).toMatchObject({
      ok: true,
      qitemId,
      actorSession: "founder@external",
      deduplicated: false,
    });
    expect(f.daemon.queueRepo.getById(qitemId)?.state).toBe("done");
  });

  it("answers a direct ask and resolves a parked item with after-question ordering, including pending-buffer replyRef acceptance", async () => {
    const f = await createRelayFixture();

    // 1. Direct ask whose outbound decision is still in the pending DispatchBuffer (race before ack)
    const ask = await createAskWithAcceptedRelayRef(f, { recordViaPendingBufferOnly: true });
    const askRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-ask-1",
        sender: { handle: "founder-handle" },
        replyRef: ask.replyRef,
        text: "We should ship Option A with strict local boundaries.",
        ordering: "after-question",
      }),
    });
    expect(askRes.status).toBe(200);
    const askJson = (await askRes.json()) as Record<string, unknown>;
    expect(askJson).toMatchObject({
      ok: true,
      qitemId: ask.qitemId,
      verb: "answer",
      actorSession: "founder@external",
      deduplicated: false,
    });

    const updatedAsk = f.daemon.queueRepo.getById(ask.qitemId)!;
    expect(updatedAsk.state).toBe("done");
    expect(updatedAsk.humanAnswers).toEqual({
      "q-arch": {
        kind: "typed-reply",
        placement: "first-unanswered",
        text: "We should ship Option A with strict local boundaries.",
        unansweredCount: 0,
      },
    });
    const replyItem = f.daemon.queueRepo.getHumanAnswer(ask.qitemId, "founder@external");
    expect(replyItem).not.toBeNull();
    expect(replyItem?.sourceSession).toBe("founder@external");
    expect(replyItem?.destinationSession).toBe("architect@rig");

    // 2. Parked item resolved with ordering="after-question" records typed answer and transitions blocked -> in-progress
    const park = await createParkedItemWithAcceptedRelayRef(f);
    const parkRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-park-1",
        sender: { handle: "founder-handle" },
        replyRef: park.replyRef,
        text: "Release approved; proceed with tag v1.2.0.",
        ordering: "after-question",
      }),
    });
    expect(parkRes.status).toBe(200);
    const parkJson = (await parkRes.json()) as Record<string, unknown>;
    expect(parkJson).toMatchObject({
      ok: true,
      qitemId: park.qitemId,
      verb: "resolve",
      actorSession: "founder@external",
      deduplicated: false,
    });

    const updatedPark = f.daemon.queueRepo.getById(park.qitemId)!;
    expect(updatedPark.state).toBe("in-progress");
    expect(updatedPark.blockedOn).toBeNull();
  });

  it("allows another registered person on the same relay to answer with real attribution and preserves first-responder winner finality", async () => {
    const f = await createRelayFixture({ registerSecondaryRelay: true });
    const ask = await createAskWithAcceptedRelayRef(f, { destinationSession: "founder@external" });

    // Cross-profile handle (ops-handle is bound to relay-sec, not relay-main) -> rejected (403)
    const crossHandleRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-cross-handle",
        sender: { handle: "ops-handle" },
        replyRef: ask.replyRef,
        text: "Cross profile attempt",
        ordering: "after-question",
      }),
    });
    expect(crossHandleRes.status).toBe(403);

    // Cross-profile token (relay-sec token trying to answer a relay-main replyRef) -> rejected (403)
    const crossRefRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenSecondary}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-cross-ref",
        sender: { handle: "ops-handle" },
        replyRef: ask.replyRef,
        text: "Cross profile ref attempt",
        ordering: "after-question",
      }),
    });
    expect(crossRefRes.status).toBe(403);

    // Partner on the SAME relay-main answers founder's ask -> succeeds with partner@external attribution
    const partnerRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-partner-answer",
        sender: { handle: "partner-handle" },
        replyRef: ask.replyRef,
        text: "Partner stepping in: use Option A.",
        ordering: "after-question",
      }),
    });
    expect(partnerRes.status).toBe(200);
    expect(await partnerRes.json()).toMatchObject({
      ok: true,
      actorSession: "partner@external",
      qitemId: ask.qitemId,
    });

    const auditActions = f.daemon.missionControlActionLog.listForQitem(ask.qitemId, 5);
    expect(auditActions[0]?.actorSession).toBe("partner@external");
    expect(auditActions[0]?.auditNotes).toMatchObject({
      asked: "founder@external",
    });
    const partnerReply = f.daemon.queueRepo.getHumanAnswer(ask.qitemId, "partner@external");
    expect(partnerReply?.sourceSession).toBe("partner@external");
    expect(partnerReply?.body).toContain("Answered by partner@external, a registered person, on founder@external's ask");

    // Founder replies later to the same ask -> rejected (409), partner's winning answer stands
    const lateFounderRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-late-founder",
        sender: { handle: "founder-handle" },
        replyRef: ask.replyRef,
        text: "Founder late answer: Option B.",
        ordering: "after-question",
      }),
    });
    expect(lateFounderRes.status).toBe(409);
    expect(f.daemon.queueRepo.getById(ask.qitemId)?.humanAnswers).toEqual({
      "q-arch": {
        kind: "typed-reply",
        placement: "first-unanswered",
        text: "Partner stepping in: use Option A.",
        unansweredCount: 0,
      },
    });
  });

  it("rejects forged replyRefs, update/notice replies, and stale revision or re-parked episode references", async () => {
    const f = await createRelayFixture();

    // 1. Forged replyRef that was never offered in DispatchBuffer or queue_transitions
    const ask = await createAskWithAcceptedRelayRef(f);
    const forgedPayload: RelayReplyRefPayload = {
      ...ask.payload,
      decisionId: "dec-forged-never-offered",
    };
    const forgedRef = encodeRelayReplyRef(forgedPayload);
    const forgedRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-forged-1",
        sender: { handle: "founder-handle" },
        replyRef: forgedRef,
        text: "Forged reply",
        ordering: "after-question",
      }),
    });
    expect(forgedRes.status).toBe(409);
    expect(f.daemon.queueRepo.getById(ask.qitemId)?.state).toBe("pending");

    // 2. Informational update item cannot be answered even if a receipt is present
    const updateItem = await createAskWithAcceptedRelayRef(f, { humanIntent: "update" });
    const updateRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-update-1",
        sender: { handle: "founder-handle" },
        replyRef: updateItem.replyRef,
        text: "Trying to answer an update notice",
        ordering: "after-question",
      }),
    });
    expect(updateRes.status).toBe(409);

    // 3. Stale park episode: item is resolved via terminal, then re-parked on founder in a new episode
    const park = await createParkedItemWithAcceptedRelayRef(f);
    await f.daemon.missionControlWriteContract.act({
      verb: "resolve",
      qitemId: park.qitemId,
      actorSession: "founder@external",
      decision: "Resolved episode 1 via CLI",
      identityProvenance: "transport:v1",
      notify: false,
    });
    // Re-park into episode 2
    f.daemon.queueRepo.update({
      qitemId: park.qitemId,
      actorSession: "builder@rig",
      state: "blocked",
      closureReason: "blocked_on",
      closureTarget: "founder@external",
      blockedOn: "founder@external",
      transitionNote: "Parked again for episode 2 question",
    });

    // Stale replyRef from episode 1 must NOT resolve episode 2!
    const staleParkRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-stale-park-ep1",
        sender: { handle: "founder-handle" },
        replyRef: park.replyRef,
        text: "Late reply to episode 1",
        ordering: "after-question",
      }),
    });
    expect(staleParkRes.status).toBe(409);
    expect(f.daemon.queueRepo.getById(park.qitemId)?.state).toBe("blocked");

    // 4. Verification that receipt matching requires canonical full 64-hex SHA256 when replyRef is omitted from receipt
    const askHashMatch = await createAskWithAcceptedRelayRef(f, { recordViaPendingBufferOnly: true });
    // Record receipt with replyRef = null and only canonical full 64-hex replyRefHash for this actual current episode
    f.daemon.queueRepo.recordRelayOwnerNotificationAccepted({
      qitemId: askHashMatch.qitemId,
      actorSession: "relay-connector",
      notificationKey: askHashMatch.payload.episodeKey,
      connectorRef: askHashMatch.payload.connectorRef,
      deliveryId: askHashMatch.payload.decisionId,
      replyRef: null,
      replyRefHash: hashRelayReplyRef(askHashMatch.replyRef),
      revision: askHashMatch.payload.decisionRevision,
      level: "ALERT",
      kind: "human-required",
    });
    // Drain/ack dispatch buffer so the hash-only receipt is the sole offer path
    new DispatchBuffer(f.home).ack(askHashMatch.payload.decisionId);

    // Inbound reply with original askHashMatch.replyRef succeeds matching canonical full SHA-256
    const hashMatchRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-hash-match-1",
        sender: { handle: "founder-handle" },
        replyRef: askHashMatch.replyRef,
        text: "Answered via full-hash receipt match",
        ordering: "after-question",
      }),
    });
    expect(hashMatchRes.status, `unexpected status for full-hash match`).toBe(200);
    expect(f.daemon.queueRepo.getById(askHashMatch.qitemId)?.state).toBe("done");

    // If receipt has a truncated 24-hex hash on a fresh active ask, inbound reply is rejected (409)
    const askTruncated = await createAskWithAcceptedRelayRef(f, { recordViaPendingBufferOnly: true });
    f.daemon.queueRepo.recordRelayOwnerNotificationAccepted({
      qitemId: askTruncated.qitemId,
      actorSession: "relay-connector",
      notificationKey: askTruncated.payload.episodeKey,
      connectorRef: askTruncated.payload.connectorRef,
      deliveryId: askTruncated.payload.decisionId,
      replyRef: null,
      replyRefHash: hashRelayReplyRef(askTruncated.replyRef).slice(0, 24), // truncated 24 hex
      revision: askTruncated.payload.decisionRevision,
      level: "ALERT",
      kind: "human-required",
    });
    new DispatchBuffer(f.home).ack(askTruncated.payload.decisionId);

    const truncatedRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-hash-truncated-1",
        sender: { handle: "founder-handle" },
        replyRef: askTruncated.replyRef,
        text: "Should fail because 24-hex shortHash compatibility is removed",
        ordering: "after-question",
      }),
    });
    expect(truncatedRes.status).toBe(409);
    const truncatedBody = (await truncatedRes.json()) as { error?: string };
    expect(truncatedBody.error).toBe("unrecognized_reply_ref");
    expect(f.daemon.queueRepo.getById(askTruncated.qitemId)?.state).toBe("pending");
  });

  it("records uncertain ordering with explicit timing uncertainty context and never populates verified answerText on blocked items", async () => {
    const f = await createRelayFixture();
    const park = await createParkedItemWithAcceptedRelayRef(f, { withHumanQuestions: true });

    const res = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-uncertain-1",
        sender: { handle: "founder-handle" },
        replyRef: park.replyRef,
        text: "Hold until staging smoke tests finish.",
        // ordering omitted -> defaults to "uncertain"
      }),
    });
    expect(res.status).toBe(200);

    const afterItem = f.daemon.queueRepo.getById(park.qitemId)!;
    expect(afterItem.state).toBe("in-progress");
    // Must NOT populate verified humanAnswers on blocked item when ordering is uncertain
    expect(afterItem.humanAnswers ?? null).toBeNull();

    const transitions = f.daemon.queueRepo.listTransitions(park.qitemId);
    const resolveTransition = transitions[transitions.length - 1]!;
    expect(resolveTransition.transitionNote).toContain("Hold until staging smoke tests finish.");
    expect(resolveTransition.transitionNote).toMatch(/ordering=uncertain/i);
  });

  it("enforces SeenStore event idempotency, rejects equivocation across text/ref/handle/qitem, and stores no plaintext reply text in the seen ledger", async () => {
    const f = await createRelayFixture();
    const ask1 = await createAskWithAcceptedRelayRef(f);
    const ask2 = await createAskWithAcceptedRelayRef(f);
    const secretReplyText = "CONFIDENTIAL-DECISION-TEXT-DO-NOT-LOG-IN-SEEN-STORE";

    // First delivery
    const first = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-idem-1",
        sender: { handle: "founder-handle" },
        replyRef: ask1.replyRef,
        text: secretReplyText,
        ordering: "after-question",
      }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, deduplicated: false });

    // Exact duplicate delivery -> 200 idempotent no-op
    const second = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-idem-1",
        sender: { handle: "founder-handle" },
        replyRef: ask1.replyRef,
        text: secretReplyText,
        ordering: "after-question",
      }),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, deduplicated: true });

    // Only one audit action recorded
    expect(f.daemon.missionControlActionLog.listForQitem(ask1.qitemId, 10)).toHaveLength(1);

    // SeenStore file contains only hashed metadata, never plaintext reply text or raw tokens
    const seenRaw = readFileSync(join(f.home, "state", RELAY_INBOUND_SEEN_FILE), "utf8");
    expect(seenRaw).not.toContain(secretReplyText);
    expect(seenRaw).not.toContain(f.inboundTokenMain);

    // Equivocation 1: same eventId with different text -> 409 conflict
    const diffText = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-idem-1",
        sender: { handle: "founder-handle" },
        replyRef: ask1.replyRef,
        text: "Changed text under same eventId",
        ordering: "after-question",
      }),
    });
    expect(diffText.status).toBe(409);

    // Equivocation 2: same eventId with different sender handle -> 409 conflict
    const diffSender = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-idem-1",
        sender: { handle: "partner-handle" },
        replyRef: ask1.replyRef,
        text: secretReplyText,
        ordering: "after-question",
      }),
    });
    expect(diffSender.status).toBe(409);

    // Equivocation 3: same eventId reused on a DIFFERENT qitem's replyRef -> 409 conflict
    const diffQitem = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-idem-1",
        sender: { handle: "founder-handle" },
        replyRef: ask2.replyRef,
        text: secretReplyText,
        ordering: "after-question",
      }),
    });
    expect(diffQitem.status).toBe(409);
    expect(f.daemon.queueRepo.getById(ask2.qitemId)?.state).toBe("pending");
  });

  it("recovers cleanly from mid-flight crashes (received-before-effect, answer-row-before-audit, and resolve-before-processed even after re-park) and refuses 2xx when seen-store is unreadable", async () => {
    const f = await createRelayFixture();
    const seenPath = join(f.home, "state", RELAY_INBOUND_SEEN_FILE);
    const seen = new SeenStore(seenPath);

    // Case A: Crash after 'received' reservation before any Mission Control effect
    const askA = await createAskWithAcceptedRelayRef(f);
    const bodyA = {
      eventId: "evt-crash-a",
      sender: { handle: "founder-handle" },
      replyRef: askA.replyRef,
      text: "Recovered answer A",
      ordering: "after-question" as const,
    };
    const origAct = f.daemon.missionControlWriteContract.act.bind(f.daemon.missionControlWriteContract);
    let failOnce = true;
    f.daemon.missionControlWriteContract.act = async (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated crash before MC effect");
      }
      return origAct(input);
    };

    const failedAttemptA = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyA),
    });
    expect(failedAttemptA.status).toBe(500);
    const keyA = computeRelayEventKey("relay-main", "evt-crash-a");
    expect(seen.statuses().get(keyA)).toMatch(/^received:/);

    const retryA = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyA),
    });
    expect(retryA.status).toBe(200);
    expect(seen.statuses().get(keyA)).toMatch(/^processed:/);
    expect(f.daemon.queueRepo.getById(askA.qitemId)?.state).toBe("done");

    // Case B: Crash after createHumanAnswer (reply row created) before resolveDirectHumanReply & audit commit
    const askB = await createAskWithAcceptedRelayRef(f);
    const bodyB = {
      eventId: "evt-crash-b",
      sender: { handle: "founder-handle" },
      replyRef: askB.replyRef,
      text: "Recovered answer B after partial write",
      ordering: "after-question" as const,
    };
    const origCreateHumanAnswer = f.daemon.queueRepo.createHumanAnswer.bind(f.daemon.queueRepo);
    let failAfterCreateReplyForQitem: string | null = askB.qitemId;
    f.daemon.queueRepo.createHumanAnswer = async (input) => {
      const createdReply = await origCreateHumanAnswer(input);
      if (failAfterCreateReplyForQitem && input.inboundReplyTo === failAfterCreateReplyForQitem) {
        failAfterCreateReplyForQitem = null;
        throw new Error("simulated crash after createHumanAnswer before resolveDirectHumanReply");
      }
      return createdReply;
    };

    const failedAttemptB = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyB),
    });
    expect(failedAttemptB.status).toBe(409);
    expect(await failedAttemptB.json()).toMatchObject({
      error: "answer_not_closed",
    });
    // Reply row was already created on first attempt, but askB is still pending and no audit row committed yet
    expect(f.daemon.queueRepo.getHumanAnswer(askB.qitemId, "founder@external")).not.toBeNull();
    expect(f.daemon.queueRepo.getById(askB.qitemId)?.state).toBe("pending");
    expect(f.daemon.missionControlActionLog.listForQitem(askB.qitemId, 5)).toHaveLength(0);

    const retryB = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyB),
    });
    expect(retryB.status).toBe(200);
    expect(f.daemon.queueRepo.getById(askB.qitemId)?.state).toBe("done");
    expect(f.daemon.missionControlActionLog.listForQitem(askB.qitemId, 5)).toHaveLength(1);
    const keyB = computeRelayEventKey("relay-main", "evt-crash-b");
    expect(seen.statuses().get(keyB)).toMatch(/^processed:/);

    // Case B-negative: Crash after createHumanAnswer AND another edit/question mutation happens before retry -> MUST reject (409)
    const askBNeg = await createAskWithAcceptedRelayRef(f);
    const bodyBNeg = {
      eventId: "evt-crash-b-neg",
      sender: { handle: "founder-handle" },
      replyRef: askBNeg.replyRef,
      text: "Partial answer before concurrent question edit",
      ordering: "after-question" as const,
    };
    failAfterCreateReplyForQitem = askBNeg.qitemId;
    const failedAttemptBNeg = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyBNeg),
    });
    expect(failedAttemptBNeg.status).toBe(409);
    expect(await failedAttemptBNeg.json()).toMatchObject({
      error: "answer_not_closed",
    });
    expect(f.daemon.queueRepo.getHumanAnswer(askBNeg.qitemId, "founder@external")).not.toBeNull();

    // Concurrent edit to askBNeg's question body before retry arrives
    f.daemon.db
      .prepare("UPDATE queue_items SET body = ? WHERE qitem_id = ?")
      .run("Edited question after partial reply — old revision must not close this", askBNeg.qitemId);

    const retryBNeg = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyBNeg),
    });
    expect(retryBNeg.status).toBe(409);
    expect(await retryBNeg.json()).toMatchObject({
      error: "decision_revision_changed",
    });
    expect(f.daemon.queueRepo.getById(askBNeg.qitemId)?.state).toBe("pending");
    const keyBNeg = computeRelayEventKey("relay-main", "evt-crash-b-neg");
    expect(seen.statuses().get(keyBNeg)).toMatch(/^received:/);
    f.daemon.queueRepo.createHumanAnswer = origCreateHumanAnswer;

    // Case B2: Crash between ask close (resolveDirectHumanReply) and audit record (missionControlActionLog.record),
    // then retry the same received event through a fresh handler -> one answer, one close/resume transition, one audit row.
    const askB2 = await createAskWithAcceptedRelayRef(f);
    const bodyB2 = {
      eventId: "evt-crash-b2-close-before-audit",
      sender: { handle: "founder-handle" },
      replyRef: askB2.replyRef,
      text: "Recovered answer B2 after close-before-audit crash",
      ordering: "after-question" as const,
    };
    const origRecord = f.daemon.missionControlActionLog.record.bind(f.daemon.missionControlActionLog);
    let failAuditOnce = true;
    f.daemon.missionControlActionLog.record = (entry) => {
      if (failAuditOnce && entry.qitemId === askB2.qitemId) {
        failAuditOnce = false;
        throw new Error("simulated crash after ask close before audit record");
      }
      return origRecord(entry);
    };

    const failedAttemptB2 = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyB2),
    });
    expect(failedAttemptB2.status).toBe(500);
    f.daemon.missionControlActionLog.record = origRecord;

    const keyB2 = computeRelayEventKey("relay-main", "evt-crash-b2-close-before-audit");
    expect(seen.statuses().get(keyB2)).toMatch(/^received:/);
    // Close rolled back atomically with the failed audit; only the 1 reply row is present
    expect(f.daemon.queueRepo.getById(askB2.qitemId)?.state).toBe("pending");
    expect(f.daemon.missionControlActionLog.listForQitem(askB2.qitemId, 5)).toHaveLength(0);

    // Retry the same received event through a freshly constructed RelayInboundHandler
    const freshHandler = createRelayInboundHandler({
      home: f.home,
      queueRepo: f.daemon.queueRepo,
      missionControlWriteContract: f.daemon.missionControlWriteContract,
      missionControlActionLog: f.daemon.missionControlActionLog,
    });
    const retryB2 = await freshHandler.handle({
      authorizationHeader: `Bearer ${f.inboundTokenMain}`,
      rawBody: JSON.stringify(bodyB2),
    });
    expect(retryB2.status).toBe(200);
    expect(seen.statuses().get(keyB2)).toMatch(/^processed:/);
    expect(f.daemon.queueRepo.getById(askB2.qitemId)?.state).toBe("done");
    expect(f.daemon.missionControlActionLog.listForQitem(askB2.qitemId, 5)).toHaveLength(1);
    const b2Replies = f.daemon.db
      .prepare("SELECT count(*) as n FROM queue_items WHERE reply_to = ?")
      .get(askB2.qitemId) as { n: number };
    expect(b2Replies.n).toBe(1);
    const b2CloseTransitions = f.daemon.queueRepo
      .listTransitions(askB2.qitemId)
      .filter((t) => t.ownerNotificationKind === "human-decision-resolved");
    expect(b2CloseTransitions).toHaveLength(1);

    // Case C: Crash after resolve commit before processed mark, AND qitem is subsequently re-parked in a new episode!
    // Retry of the original event must reconcile its OWN committed resolve and mark processed without unparking the new episode.
    const parkC = await createParkedItemWithAcceptedRelayRef(f);
    const bodyC = {
      eventId: "evt-crash-c",
      sender: { handle: "founder-handle" },
      replyRef: parkC.replyRef,
      text: "Approved episode 1 before crash",
      ordering: "after-question" as const,
    };
    // Simulate that attempt 1 reserved 'received' and committed MC resolve, then crashed before marking 'processed'
    f.daemon.missionControlWriteContract.act = async (input) => {
      const res = await origAct(input);
      throw new Error("simulated crash after MC resolve commit before processed mark");
      return res;
    };
    const failedAttemptC = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyC),
    });
    expect(failedAttemptC.status).toBe(500);
    expect(f.daemon.queueRepo.getById(parkC.qitemId)?.state).toBe("in-progress");

    // Restore normal act() and re-park the item into Episode 2
    f.daemon.missionControlWriteContract.act = origAct;
    f.daemon.queueRepo.update({
      qitemId: parkC.qitemId,
      actorSession: "builder@rig",
      state: "blocked",
      closureReason: "blocked_on",
      closureTarget: "founder@external",
      blockedOn: "founder@external",
      transitionNote: "Re-parked into episode 2 while retry of episode 1 is in flight",
    });

    // Retry of bodyC reconciles its own episode 1 operation, marks processed, returns 200, and leaves Episode 2 blocked!
    const retryC = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyC),
    });
    expect(retryC.status).toBe(200);
    const keyC = computeRelayEventKey("relay-main", "evt-crash-c");
    expect(seen.statuses().get(keyC)).toMatch(/^processed:/);
    expect(f.daemon.queueRepo.getById(parkC.qitemId)?.state).toBe("blocked");

    // Case D: Seen-ledger scoping:
    // D1. Keyed records with valid received:/processed:<fingerprint> still vouch for identity/result even with
    // missing/invalid ts or extra diagnostic metadata; truly missing/unknown status or conflicting fingerprints
    // refuse ONLY that key (503, never unseen), while unrelated keys remain available.
    const askProcessedNoTs = await createAskWithAcceptedRelayRef(f);
    const eventProcessedNoTs = "evt-processed-missing-ts";
    const keyProcessedNoTs = computeRelayEventKey("relay-main", eventProcessedNoTs);
    const fpProcessedNoTs = computeRelayEventFingerprint({
      connectorRef: "relay-main",
      eventId: eventProcessedNoTs,
      senderHandle: "founder-handle",
      actorSession: "founder@external",
      replyRef: askProcessedNoTs.replyRef,
      qitemId: askProcessedNoTs.qitemId,
      episodeKey: askProcessedNoTs.payload.episodeKey,
      decisionRevision: askProcessedNoTs.payload.decisionRevision,
      mode: askProcessedNoTs.payload.mode,
      ordering: "after-question",
      text: "Already processed with missing ts",
    });

    const askReceivedNoTs = await createAskWithAcceptedRelayRef(f);
    const eventReceivedNoTs = "evt-received-missing-ts";
    const keyReceivedNoTs = computeRelayEventKey("relay-main", eventReceivedNoTs);
    const fpReceivedNoTs = computeRelayEventFingerprint({
      connectorRef: "relay-main",
      eventId: eventReceivedNoTs,
      senderHandle: "founder-handle",
      actorSession: "founder@external",
      replyRef: askReceivedNoTs.replyRef,
      qitemId: askReceivedNoTs.qitemId,
      episodeKey: askReceivedNoTs.payload.episodeKey,
      decisionRevision: askReceivedNoTs.payload.decisionRevision,
      mode: askReceivedNoTs.payload.mode,
      ordering: "after-question",
      text: "Reserved received with missing ts",
    });

    const suspectEventId1 = "evt-suspect-unknown-status";
    const suspectKey1 = computeRelayEventKey("relay-main", suspectEventId1);
    const suspectEventId2 = "evt-suspect-missing-status";
    const suspectKey2 = computeRelayEventKey("relay-main", suspectEventId2);
    const suspectEventId3 = "evt-suspect-conflicting-fps";
    const suspectKey3 = computeRelayEventKey("relay-main", suspectEventId3);
    const existingSeenRaw = readFileSync(seenPath, "utf8");
    writeFileSync(
      seenPath,
      existingSeenRaw +
        JSON.stringify({ id: keyProcessedNoTs, status: `processed:${fpProcessedNoTs}`, extraDiag: 123 }) +
        "\n" +
        JSON.stringify({ id: keyReceivedNoTs, ts: null, status: `received:${fpReceivedNoTs}`, note: "diag" }) +
        "\n" +
        JSON.stringify({ id: suspectKey1, ts: "2026-11-07T00:00:00.000Z", status: "unknown:status" }) +
        "\n" +
        JSON.stringify({ id: suspectKey2, ts: "2026-11-07T00:00:00.000Z" }) +
        "\n" +
        JSON.stringify({ id: suspectKey3, status: `received:${"a".repeat(64)}` }) +
        "\n" +
        JSON.stringify({ id: suspectKey3, status: `processed:${"b".repeat(64)}` }) +
        "\n",
      "utf8",
    );

    // Valid processed record missing ts still deduplicates safely (200, zero new effects) and rejects conflict (409)
    const processedNoTsRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: eventProcessedNoTs,
        sender: { handle: "founder-handle" },
        replyRef: askProcessedNoTs.replyRef,
        text: "Already processed with missing ts",
        ordering: "after-question",
      }),
    });
    expect(processedNoTsRes.status).toBe(200);
    expect(await processedNoTsRes.json()).toMatchObject({ ok: true, deduplicated: true });
    expect(f.daemon.queueRepo.getById(askProcessedNoTs.qitemId)?.state).toBe("pending");
    expect(f.daemon.missionControlActionLog.listForQitem(askProcessedNoTs.qitemId, 5)).toHaveLength(0);

    const processedNoTsConflict = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: eventProcessedNoTs,
        sender: { handle: "founder-handle" },
        replyRef: askProcessedNoTs.replyRef,
        text: "Different text under processed missing-ts key",
        ordering: "after-question",
      }),
    });
    expect(processedNoTsConflict.status).toBe(409);

    // Valid received record missing ts can safely complete/reconcile (200)
    const receivedNoTsRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: eventReceivedNoTs,
        sender: { handle: "founder-handle" },
        replyRef: askReceivedNoTs.replyRef,
        text: "Reserved received with missing ts",
        ordering: "after-question",
      }),
    });
    expect(receivedNoTsRes.status).toBe(200);
    expect(f.daemon.queueRepo.getById(askReceivedNoTs.qitemId)?.state).toBe("done");
    expect(seen.statuses().get(keyReceivedNoTs)).toBe(`processed:${fpReceivedNoTs}`);

    // Unrelated already-processed keyA still deduplicates (200) and rejects equivocation (409)
    const dupA = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyA),
    });
    expect(dupA.status).toBe(200);
    expect(await dupA.json()).toMatchObject({ ok: true, deduplicated: true });

    const conflictA = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...bodyA, text: "Conflicting text for keyA" }),
    });
    expect(conflictA.status).toBe(409);

    // Unrelated brand-new key on a fresh ask still succeeds (200)
    const askUnrelated = await createAskWithAcceptedRelayRef(f);
    const unrelatedRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-unrelated-healthy",
        sender: { handle: "founder-handle" },
        replyRef: askUnrelated.replyRef,
        text: "Unrelated key succeeds despite keyed suspect records",
        ordering: "after-question",
      }),
    });
    expect(unrelatedRes.status).toBe(200);
    expect(f.daemon.queueRepo.getById(askUnrelated.qitemId)?.state).toBe("done");

    // Request for the keyed suspect eventIds (unknown status, missing status, conflicting fingerprints) is refused with 503 (never treated as unseen!)
    const askSuspect = await createAskWithAcceptedRelayRef(f);
    for (const badEventId of [suspectEventId1, suspectEventId2, suspectEventId3]) {
      const suspectRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.inboundTokenMain}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          eventId: badEventId,
          sender: { handle: "founder-handle" },
          replyRef: askSuspect.replyRef,
          text: "Should be refused because its keyed seen record is unvouched",
          ordering: "after-question",
        }),
      });
      expect(suspectRes.status, `eventId=${badEventId}`).toBe(503);
      const suspectJson = (await suspectRes.json()) as Record<string, unknown>;
      expect(suspectJson).toMatchObject({
        error: "seen_store_unavailable",
        seenPath,
      });
      expect(String(suspectJson.message)).toContain(seenPath);
    }
    expect(f.daemon.queueRepo.getById(askSuspect.qitemId)?.state).toBe("pending");

    // D2. Unkeyable record (missing id) and unparseable JSONL line refuse with scoped 503 even for unseen keys
    writeFileSync(
      seenPath,
      existingSeenRaw + JSON.stringify({ ts: "2026-11-07T00:00:00.000Z", status: `processed:${"b".repeat(64)}` }) + "\n",
      "utf8",
    );
    const unkeyableRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-unseen-during-unkeyable-history",
        sender: { handle: "founder-handle" },
        replyRef: askSuspect.replyRef,
        text: "Must not count as unseen when history has unkeyable line",
        ordering: "after-question",
      }),
    });
    expect(unkeyableRes.status).toBe(503);
    expect(await unkeyableRes.json()).toMatchObject({
      error: "seen_store_unavailable",
      seenPath,
    });
    expect(f.daemon.queueRepo.getById(askSuspect.qitemId)?.state).toBe("pending");

    writeFileSync(seenPath, "{corrupt-jsonl-line\n", "utf8");
    const corruptRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyA),
    });
    expect(corruptRes.status).toBe(503);
    expect(await corruptRes.json()).toMatchObject({
      error: "seen_store_unavailable",
      seenPath,
    });
  });

  it("distinguishes normal noHumans (401) from broken or thrown registry reads (503) and preserves receipt-first verification when dispatch buffer is unreadable (503 for un-receipted refs)", async () => {
    const f = await createRelayFixture();
    const receiptedAsk = await createAskWithAcceptedRelayRef(f);
    const unreceiptedAsk = await createAskWithAcceptedRelayRef(f, { recordViaPendingBufferOnly: true });

    // 1. Normal noHumans (empty registry directory with zero fragments) -> 401 unauthorized (not 503 outage)
    const emptyHome = mkdtempSync(join(tmpdir(), "relay-empty-humans-"));
    try {
      const emptyHandler = createRelayInboundHandler({
        home: emptyHome,
        queueRepo: f.daemon.queueRepo,
        missionControlWriteContract: f.daemon.missionControlWriteContract,
        missionControlActionLog: f.daemon.missionControlActionLog,
      });
      const noHumansRes = await emptyHandler.handle({
        authorizationHeader: `Bearer ${f.inboundTokenMain}`,
        rawBody: JSON.stringify({
          eventId: "evt-no-humans-1",
          sender: { handle: "founder-handle" },
          replyRef: receiptedAsk.replyRef,
          text: "No humans configured",
        }),
      });
      expect(noHumansRes.status).toBe(401);
      expect(noHumansRes.body.error).toBe("unauthorized");
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }

    // 2. Returned broken registry (ok: false without noHumans) -> 503 human_registry_unavailable
    const brokenRegistryHandler = createRelayInboundHandler({
      home: f.home,
      queueRepo: f.daemon.queueRepo,
      missionControlWriteContract: f.daemon.missionControlWriteContract,
      missionControlActionLog: f.daemon.missionControlActionLog,
      loadEntities: () => ({ ok: false, error: "corrupt human fragment YAML" }),
    });
    const brokenRegRes = await brokenRegistryHandler.handle({
      authorizationHeader: `Bearer ${f.inboundTokenMain}`,
      rawBody: JSON.stringify({
        eventId: "evt-broken-reg-1",
        sender: { handle: "founder-handle" },
        replyRef: receiptedAsk.replyRef,
        text: "Broken registry",
      }),
    });
    expect(brokenRegRes.status).toBe(503);
    expect(brokenRegRes.body.error).toBe("human_registry_unavailable");

    // 3. Thrown registry read exception -> 503 human_registry_unavailable
    const throwingRegistryHandler = createRelayInboundHandler({
      home: f.home,
      queueRepo: f.daemon.queueRepo,
      missionControlWriteContract: f.daemon.missionControlWriteContract,
      missionControlActionLog: f.daemon.missionControlActionLog,
      loadEntities: () => {
        throw new Error("EIO: disk read failure on human registry");
      },
    });
    const thrownRegRes = await throwingRegistryHandler.handle({
      authorizationHeader: `Bearer ${f.inboundTokenMain}`,
      rawBody: JSON.stringify({
        eventId: "evt-thrown-reg-1",
        sender: { handle: "founder-handle" },
        replyRef: receiptedAsk.replyRef,
        text: "Thrown registry",
      }),
    });
    expect(thrownRegRes.status).toBe(503);
    expect(thrownRegRes.body.error).toBe("human_registry_unavailable");

    // 4. Corrupt the local DispatchBuffer file:
    //    - A replyRef already vouched for by a durable accepted receipt still succeeds (200 OK)
    //    - An un-receipted replyRef that requires reading DispatchBuffer returns 503 dispatch_buffer_unavailable
    //      with zero seen-store reservation and zero action side effects.
    const bufferPath = join(f.home, "gateway", "dispatch-buffer.json");
    writeFileSync(bufferPath, "{corrupt-dispatch-buffer-json\n", "utf8");

    const receiptedRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-receipt-wins-over-corrupt-buffer",
        sender: { handle: "founder-handle" },
        replyRef: receiptedAsk.replyRef,
        text: "Durable receipt vouches for this replyRef despite corrupt buffer",
        ordering: "after-question",
      }),
    });
    expect(receiptedRes.status).toBe(200);
    expect(f.daemon.queueRepo.getById(receiptedAsk.qitemId)?.state).toBe("done");

    const unreceiptedEventId = "evt-unreceipted-corrupt-buffer";
    const unreceiptedRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: unreceiptedEventId,
        sender: { handle: "founder-handle" },
        replyRef: unreceiptedAsk.replyRef,
        text: "Should return 503 because buffer cannot be read to verify un-receipted ref",
        ordering: "after-question",
      }),
    });
    expect(unreceiptedRes.status).toBe(503);
    expect(await unreceiptedRes.json()).toMatchObject({
      error: "dispatch_buffer_unavailable",
    });
    const seen = new SeenStore(join(f.home, "state", RELAY_INBOUND_SEEN_FILE));
    expect(seen.statuses().get(computeRelayEventKey("relay-main", unreceiptedEventId))).toBeUndefined();
    expect(f.daemon.queueRepo.getById(unreceiptedAsk.qitemId)?.state).toBe("pending");
    expect(f.daemon.missionControlActionLog.listForQitem(unreceiptedAsk.qitemId, 5)).toHaveLength(0);
  });

  it("exposes sanitized relay readiness on /api/gateway/human/:entityId/readiness and /api/gateway/connections without leaking secrets", async () => {
    const f = await createRelayFixture();

    const readinessRes = await fetch(`${f.baseUrl}/api/gateway/human/founder/readiness`);
    expect(readinessRes.status).toBe(200);
    const readinessBody = (await readinessRes.json()) as Record<string, unknown>;
    expect(readinessBody).toMatchObject({
      ok: true,
      readiness: {
        state: "ready",
        configured: true,
        enabled: true,
        active: true,
        ready: true,
        connector: {
          kind: "relay",
          ref: "relay-main",
        },
      },
    });
    const readinessText = JSON.stringify(readinessBody);
    expect(readinessText).not.toContain(f.inboundTokenMain);
    expect(readinessText).not.toContain(f.outboundTokenMain);

    const connectionsRes = await fetch(`${f.baseUrl}/api/gateway/connections`);
    expect(connectionsRes.status).toBe(200);
    const connectionsBody = (await connectionsRes.json()) as Record<string, unknown>;
    const connectionsText = JSON.stringify(connectionsBody);
    expect(connectionsText).not.toContain(f.inboundTokenMain);
    expect(connectionsText).not.toContain(f.outboundTokenMain);
    expect(connectionsBody.relay).toMatchObject({
      configured: true,
      ready: true,
    });
  });

  it("keeps generated replyRef fixed-size (<= 4096 chars and fitting 64 KiB body) for arbitrary high-entropy qitemId, connectorRef, episodeKey, and decisionId across pending DispatchBuffer, active/archived accepted receipts, digest items, and 503/dedup target guards", async () => {
    const f = await createRelayFixture({ registerSecondaryRelay: true });

    const highEntropyStream = (label: string, blocks: number) =>
      Array.from({ length: blocks }, (_, idx) =>
        createHash("sha512").update(`${label}:${idx}`).digest("base64url"),
      ).join("-");

    // Register a relay connector profile with a > 19,000-char high-entropy connectorRef and two bound humans
    const hugeConnectorRef = `relay-${highEntropyStream("connector-ref", 220)}`;
    const hugeInboundToken = "in-tok-huge-connector-654321";
    const hugeOutboundToken = "out-tok-huge-connector-123456";
    const hugeEnvPath = join(f.home, "secrets", "relay-huge.env");
    writeFileSync(
      hugeEnvPath,
      [
        "OPENRIG_RELAY_URL=http://127.0.0.1:43199/outbound",
        `OPENRIG_RELAY_OUTBOUND_TOKEN=${hugeOutboundToken}`,
        `OPENRIG_RELAY_INBOUND_TOKEN=${hugeInboundToken}`,
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    chmodSync(hugeEnvPath, 0o600);

    addHumanFragment(
      {
        entityId: "longfounder",
        class: "human",
        displayName: "Long Founder",
        address: "longfounder@external",
        connectorBindings: [
          {
            kind: "relay",
            connectorRef: hugeConnectorRef,
            handle: "longfounder-handle",
            secretsRef: `file:${hugeEnvPath}`,
            role: "primary",
          },
        ],
        prefs: { deliveryClass: "A" },
      },
      f.home,
    );
    addHumanFragment(
      {
        entityId: "longpartner",
        class: "human",
        displayName: "Long Partner",
        address: "longpartner@external",
        connectorBindings: [
          {
            kind: "relay",
            connectorRef: hugeConnectorRef,
            handle: "longpartner-handle",
            secretsRef: `file:${hugeEnvPath}`,
            role: "primary",
          },
        ],
        prefs: { deliveryClass: "A" },
      },
      f.home,
    );

    const rekeyQitemId = (oldId: string, newId: string) => {
      f.db.pragma("foreign_keys = OFF");
      try {
        f.db.prepare("UPDATE queue_items SET qitem_id = ? WHERE qitem_id = ?").run(newId, oldId);
        f.db.prepare("UPDATE queue_transitions SET qitem_id = ? WHERE qitem_id = ?").run(newId, oldId);
        f.db.prepare("UPDATE outbox_entries SET audit_pointer = ? WHERE audit_pointer = ?").run(newId, oldId);
      } finally {
        f.db.pragma("foreign_keys = ON");
      }
    };

    // 1. Pending DispatchBuffer round-trip with > 19,000-char qitemId, episodeKey, connectorRef, and decisionId
    //    (old inline base64url encoding > 100,000 chars > 4096 chars and > 64 KiB body; new token is exactly 246 chars)
    const seededPending = await f.daemon.queueRepo.create({
      sourceSession: "architect@rig",
      destinationSession: "longfounder@external",
      summary: "High-entropy pending ask",
      body: "Approve high-entropy pending deployment?",
      humanIntent: "decision",
      humanAlert: true,
      humanQuestions: [
        {
          id: "q-huge-pending",
          header: "Deploy",
          question: "Ship high-entropy pending build?",
          options: [
            { id: "yes", label: "Yes", description: "Proceed" },
            { id: "no", label: "No", description: "Hold" },
          ],
        },
      ],
      nudge: false,
    });
    const hugeQitemIdPending = `qi-${highEntropyStream("qitem-pending", 220)}`;
    rekeyQitemId(seededPending.qitemId, hugeQitemIdPending);

    const hugeEpisodeKeyPending = f.daemon.queueRepo.currentHumanRequiredEpisode(hugeQitemIdPending)!.key;
    const hugeDecisionIdPending = `dec-${highEntropyStream("decision-pending", 220)}`;
    expect(hugeQitemIdPending.length).toBeGreaterThan(19_000);
    expect(hugeConnectorRef.length).toBeGreaterThan(19_000);
    expect(hugeEpisodeKeyPending.length).toBeGreaterThan(19_000);
    expect(hugeDecisionIdPending.length).toBeGreaterThan(19_000);

    const preparedPendingHuge = prepareRelayDecision(
      {
        kind: "outbound_decision",
        decisionId: hugeDecisionIdPending,
        op: OUTBOUND_OP,
        entityBindingRef: "longfounder@external",
        payload: {
          qitemId: hugeQitemIdPending,
          notificationKey: hugeEpisodeKeyPending,
          destinationSession: "longfounder@external",
          summary: "High-entropy pending ask",
          body: "Approve high-entropy pending deployment?",
          humanIntent: "decision",
          ownerNotificationKind: "human-required",
        },
        enqueuedAt: new Date().toISOString(),
      },
      {
        loadHumanRegistry: () => loadHumanRegistry(f.home),
        queueRepo: f.daemon.queueRepo,
        resolveOutcome: () => "interrupt",
      },
    );
    const pendingHugeEnv = (preparedPendingHuge.payload as { relayEnvelope?: { replyRef: string | null } }).relayEnvelope!;
    expect(pendingHugeEnv.replyRef).not.toBeNull();
    expect(pendingHugeEnv.replyRef!.length).toBeLessThanOrEqual(4096);
    expect(pendingHugeEnv.replyRef!.length).toBe(246);

    const buffer = new DispatchBuffer(f.home);
    buffer.enqueue(preparedPendingHuge);

    // Cross-connector guard: relay-main token rejected (403) when trying to answer hugeConnectorRef's replyRef
    const crossConnRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-huge-cross-conn-1",
        sender: { handle: "founder-handle" },
        replyRef: pendingHugeEnv.replyRef,
        text: "Cross connector attempt",
        ordering: "after-question",
      }),
    });
    expect(crossConnRes.status).toBe(403);
    expect(await crossConnRes.json()).toMatchObject({ error: "connector_ref_mismatch" });

    const inboundPendingBody = JSON.stringify({
      eventId: "evt-huge-pending-1",
      sender: { handle: "longfounder-handle" },
      replyRef: pendingHugeEnv.replyRef,
      text: "Yes, ship from pending buffer.",
      ordering: "after-question",
    });
    expect(Buffer.byteLength(inboundPendingBody, "utf8")).toBeLessThanOrEqual(65_536);

    const pendingRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hugeInboundToken}`,
        "Content-Type": "application/json",
      },
      body: inboundPendingBody,
    });
    expect(pendingRes.status).toBe(200);
    expect(await pendingRes.json()).toMatchObject({
      ok: true,
      qitemId: hugeQitemIdPending,
      verb: "answer",
      actorSession: "longfounder@external",
      deduplicated: false,
    });
    expect(f.daemon.queueRepo.getById(hugeQitemIdPending)?.state).toBe("done");
    buffer.ack(hugeDecisionIdPending);

    // 2. Accepted receipt round-trip after buffer drain (with corrupt dispatch-buffer.json + fresh handler + registered partner attribution + archive)
    const seededReceipt = await f.daemon.queueRepo.create({
      sourceSession: "architect@rig",
      destinationSession: "longfounder@external",
      summary: "High-entropy receipt ask",
      body: "Approve high-entropy receipt deployment?",
      humanIntent: "decision",
      humanAlert: true,
      humanQuestions: [
        {
          id: "q-huge-receipt",
          header: "Deploy Receipt",
          question: "Ship high-entropy receipt build?",
          options: [
            { id: "yes", label: "Yes", description: "Proceed" },
            { id: "no", label: "No", description: "Hold" },
          ],
        },
      ],
      nudge: false,
    });
    const hugeQitemIdReceipt = `qi-${highEntropyStream("qitem-receipt", 220)}`;
    rekeyQitemId(seededReceipt.qitemId, hugeQitemIdReceipt);

    const receiptHugeRow = f.daemon.queueRepo.getById(hugeQitemIdReceipt)!;
    const hugeEpisodeKeyReceipt = f.daemon.queueRepo.currentHumanRequiredEpisode(hugeQitemIdReceipt)!.key;
    const hugeRevisionReceipt = f.daemon.queueRepo.decisionRevision(receiptHugeRow);
    const hugeDecisionIdReceipt = `dec-${highEntropyStream("decision-receipt", 220)}`;

    const preparedReceiptHuge = prepareRelayDecision(
      {
        kind: "outbound_decision",
        decisionId: hugeDecisionIdReceipt,
        op: OUTBOUND_OP,
        entityBindingRef: "longfounder@external",
        payload: {
          qitemId: hugeQitemIdReceipt,
          notificationKey: hugeEpisodeKeyReceipt,
          destinationSession: "longfounder@external",
          summary: "High-entropy receipt ask",
          body: "Approve high-entropy receipt deployment?",
          humanIntent: "decision",
          ownerNotificationKind: "human-required",
        },
        enqueuedAt: new Date().toISOString(),
      },
      {
        loadHumanRegistry: () => loadHumanRegistry(f.home),
        queueRepo: f.daemon.queueRepo,
        resolveOutcome: () => "interrupt",
      },
    );
    const receiptHugeEnv = (preparedReceiptHuge.payload as { relayEnvelope?: { replyRef: string | null } }).relayEnvelope!;
    expect(receiptHugeEnv.replyRef).not.toBeNull();
    expect(receiptHugeEnv.replyRef!.length).toBeLessThanOrEqual(4096);
    expect(receiptHugeEnv.replyRef!.length).toBe(246);

    // Record durable accepted receipt (no pending buffer entry) and corrupt dispatch-buffer.json on disk
    f.daemon.queueRepo.recordRelayOwnerNotificationAccepted({
      qitemId: hugeQitemIdReceipt,
      actorSession: "relay-connector",
      notificationKey: hugeEpisodeKeyReceipt,
      connectorRef: hugeConnectorRef,
      deliveryId: hugeDecisionIdReceipt,
      replyRef: receiptHugeEnv.replyRef,
      replyRefHash: hashRelayReplyRef(receiptHugeEnv.replyRef!),
      revision: hugeRevisionReceipt,
      episodeKey: hugeEpisodeKeyReceipt,
      level: "ALERT",
      kind: "human-required",
      closeUpdate: false,
    });
    const bufferPath = join(f.home, "gateway", "dispatch-buffer.json");
    writeFileSync(bufferPath, "{corrupt-buffer-while-receipt-valid\n", "utf8");

    const inboundReceiptBody = JSON.stringify({
      eventId: "evt-huge-receipt-partner-1",
      sender: { handle: "longpartner-handle" },
      replyRef: receiptHugeEnv.replyRef,
      text: "Partner approves from durable receipt with corrupt buffer.",
      ordering: "after-question",
    });
    expect(Buffer.byteLength(inboundReceiptBody, "utf8")).toBeLessThanOrEqual(65_536);

    // Fresh handler instance (simulating restart) resolves from durable accepted receipt despite corrupt buffer
    const restartedHandler = createRelayInboundHandler({
      home: f.home,
      queueRepo: f.daemon.queueRepo,
      missionControlWriteContract: f.daemon.missionControlWriteContract,
      missionControlActionLog: f.daemon.missionControlActionLog,
    });
    const receiptPartnerRes = await restartedHandler.handle({
      authorizationHeader: `Bearer ${hugeInboundToken}`,
      rawBody: inboundReceiptBody,
    });
    expect(receiptPartnerRes.status).toBe(200);
    expect(receiptPartnerRes.body).toMatchObject({
      ok: true,
      qitemId: hugeQitemIdReceipt,
      verb: "answer",
      actorSession: "longpartner@external",
      deduplicated: false,
    });
    expect(f.daemon.queueRepo.getById(hugeQitemIdReceipt)?.state).toBe("done");

    // Restore valid empty dispatch-buffer.json, archive the terminal transitions into queue_transitions_archive, and verify HTTP replay
    writeFileSync(bufferPath, "[]\n", "utf8");
    const oldIso = "2025-01-01T00:00:00.000Z";
    f.db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run(oldIso, hugeQitemIdReceipt);
    f.db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(oldIso, hugeQitemIdReceipt);
    expect(
      archiveAgedTerminalTransitions(f.db, { nowIso: "2026-11-07T00:00:00.000Z" }).archivedQitems,
    ).toBeGreaterThanOrEqual(1);

    const archivedReplayRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hugeInboundToken}`,
        "Content-Type": "application/json",
      },
      body: inboundReceiptBody,
    });
    expect(archivedReplayRes.status).toBe(200);
    expect(await archivedReplayRes.json()).toMatchObject({
      ok: true,
      qitemId: hugeQitemIdReceipt,
      actorSession: "longpartner@external",
      deduplicated: true,
    });

    // 3. Processed-event dedup runs BEFORE current-target getById/listTransitions verification:
    //    - When getById returns null (target missing) or throws (target DB read error) while receipt + processed seen ledger exist:
    //      * exact duplicate replay still returns 200 OK (deduplicated: true) without touching getById
    //      * fresh new eventId with the same replyRef returns 404 (when missing) or 503 (when throwing) with zero seen reservation
    let getByIdCalls = 0;
    const missingTargetRepo = new Proxy(f.daemon.queueRepo, {
      get(target, prop, receiver) {
        if (prop === "getById") {
          return () => {
            getByIdCalls++;
            return null;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const missingTargetHandler = createRelayInboundHandler({
      home: f.home,
      queueRepo: missingTargetRepo,
      missionControlWriteContract: f.daemon.missionControlWriteContract,
      missionControlActionLog: f.daemon.missionControlActionLog,
    });
    const dedupWhenMissingRes = await missingTargetHandler.handle({
      authorizationHeader: `Bearer ${hugeInboundToken}`,
      rawBody: inboundReceiptBody,
    });
    expect(dedupWhenMissingRes.status).toBe(200);
    expect(dedupWhenMissingRes.body).toMatchObject({
      ok: true,
      qitemId: hugeQitemIdReceipt,
      deduplicated: true,
    });
    expect(getByIdCalls).toBe(0);

    const seen = new SeenStore(join(f.home, "state", RELAY_INBOUND_SEEN_FILE));
    const freshMissingEventId = "evt-fresh-when-target-missing-1";
    const freshWhenMissingRes = await missingTargetHandler.handle({
      authorizationHeader: `Bearer ${hugeInboundToken}`,
      rawBody: JSON.stringify({
        eventId: freshMissingEventId,
        sender: { handle: "longpartner-handle" },
        replyRef: receiptHugeEnv.replyRef,
        text: "Fresh event when target row is gone",
        ordering: "after-question",
      }),
    });
    expect(freshWhenMissingRes.status).toBe(404);
    expect(freshWhenMissingRes.body.error).toBe("qitem_not_found");
    expect(seen.statuses().get(computeRelayEventKey(hugeConnectorRef, freshMissingEventId))).toBeUndefined();

    const throwingTargetRepo = new Proxy(f.daemon.queueRepo, {
      get(target, prop, receiver) {
        if (prop === "getById") {
          return () => {
            throw new Error("SQLITE_IOERR: simulated getById failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const throwingTargetHandler = createRelayInboundHandler({
      home: f.home,
      queueRepo: throwingTargetRepo,
      missionControlWriteContract: f.daemon.missionControlWriteContract,
      missionControlActionLog: f.daemon.missionControlActionLog,
    });
    const dedupWhenThrowingRes = await throwingTargetHandler.handle({
      authorizationHeader: `Bearer ${hugeInboundToken}`,
      rawBody: inboundReceiptBody,
    });
    expect(dedupWhenThrowingRes.status).toBe(200);
    expect(dedupWhenThrowingRes.body).toMatchObject({
      ok: true,
      qitemId: hugeQitemIdReceipt,
      deduplicated: true,
    });

    const freshThrowingEventId = "evt-fresh-when-target-throws-1";
    const freshWhenThrowingRes = await throwingTargetHandler.handle({
      authorizationHeader: `Bearer ${hugeInboundToken}`,
      rawBody: JSON.stringify({
        eventId: freshThrowingEventId,
        sender: { handle: "longpartner-handle" },
        replyRef: receiptHugeEnv.replyRef,
        text: "Fresh event when target getById throws",
        ordering: "after-question",
      }),
    });
    expect(freshWhenThrowingRes.status).toBe(503);
    expect(freshWhenThrowingRes.body.error).toBe("queue_store_unavailable");
    expect(seen.statuses().get(computeRelayEventKey(hugeConnectorRef, freshThrowingEventId))).toBeUndefined();

    // 4. Multi-item digest with per-item fixed-size replyRef tokens (264 chars for ask-digest) scopes each reply to its individual question
    const digAsk1 = await f.daemon.queueRepo.create({
      sourceSession: "architect@rig",
      destinationSession: "founder@external",
      summary: "Digest ask 1",
      body: "Question 1?",
      humanIntent: "decision",
      humanAlert: true,
      nudge: false,
    });
    const digAsk2 = await f.daemon.queueRepo.create({
      sourceSession: "architect@rig",
      destinationSession: "founder@external",
      summary: "Digest ask 2",
      body: "Question 2?",
      humanIntent: "decision",
      humanAlert: true,
      nudge: false,
    });
    const ep1 = f.daemon.queueRepo.currentHumanRequiredEpisode(digAsk1.qitemId)!.key;
    const ep2 = f.daemon.queueRepo.currentHumanRequiredEpisode(digAsk2.qitemId)!.key;
    const digestDecisionId = `digest:${highEntropyStream("digest-id", 60)}`;
    const preparedDigest = prepareRelayDecision(
      {
        kind: "outbound_decision",
        decisionId: digestDecisionId,
        op: OUTBOUND_OP,
        entityBindingRef: "founder@external",
        payload: {
          deliveryDigestPost: true,
          digestId: "multi-huge",
          qitemId: digAsk1.qitemId,
          destinationSession: "founder@external",
          summary: "Digest summary",
          body: "• Question 1?\n• Question 2?",
          memberReceipts: [
            { qitemId: digAsk1.qitemId, notificationKey: ep1, level: "ALERT", kind: "human-required" },
            { qitemId: digAsk2.qitemId, notificationKey: ep2, level: "ALERT", kind: "human-required" },
          ],
        },
        enqueuedAt: new Date().toISOString(),
      },
      {
        loadHumanRegistry: () => loadHumanRegistry(f.home),
        queueRepo: f.daemon.queueRepo,
        resolveOutcome: () => "digest",
      },
    );
    const digestEnv = (
      preparedDigest.payload as {
        relayEnvelope?: { replyRef: string | null; items?: Array<{ qitemId: string; replyRef: string | null }> };
      }
    ).relayEnvelope!;
    expect(digestEnv.replyRef).toBeNull();
    const itemRef1 = digestEnv.items![0]!.replyRef!;
    const itemRef2 = digestEnv.items![1]!.replyRef!;
    expect(itemRef1.length).toBeLessThanOrEqual(4096);
    expect(itemRef2.length).toBeLessThanOrEqual(4096);
    expect(itemRef1.length).toBe(264);
    expect(itemRef2.length).toBe(264);

    // Record accepted receipts for both digest member items
    f.daemon.queueRepo.recordRelayOwnerNotificationAccepted({
      qitemId: digAsk1.qitemId,
      actorSession: "relay-connector",
      notificationKey: ep1,
      connectorRef: "relay-main",
      deliveryId: digestDecisionId,
      replyRef: itemRef1,
      replyRefHash: hashRelayReplyRef(itemRef1),
      revision: f.daemon.queueRepo.decisionRevision(digAsk1),
      episodeKey: ep1,
      level: "ALERT",
      kind: "human-required",
    });
    f.daemon.queueRepo.recordRelayOwnerNotificationAccepted({
      qitemId: digAsk2.qitemId,
      actorSession: "relay-connector",
      notificationKey: ep2,
      connectorRef: "relay-main",
      deliveryId: digestDecisionId,
      replyRef: itemRef2,
      replyRefHash: hashRelayReplyRef(itemRef2),
      revision: f.daemon.queueRepo.decisionRevision(digAsk2),
      episodeKey: ep2,
      level: "ALERT",
      kind: "human-required",
    });

    const digReply1 = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-digest-item-1",
        sender: { handle: "founder-handle" },
        replyRef: itemRef1,
        text: "Answer for digest item 1 only",
        ordering: "after-question",
      }),
    });
    expect(digReply1.status).toBe(200);
    expect(f.daemon.queueRepo.getById(digAsk1.qitemId)?.state).toBe("done");
    expect(f.daemon.queueRepo.getById(digAsk2.qitemId)?.state).toBe("pending");

    // 5. Unavailable DB read during receipt lookup returns 503 queue_store_unavailable with zero seen-store reservation or action side effects
    const dbThrowingRepo = new Proxy(f.daemon.queueRepo, {
      get(target, prop, receiver) {
        if (prop === "findRelayOwnerNotificationReceiptByReplyRef") {
          return () => {
            throw new Error("SQLITE_IOERR: simulated receipt lookup failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const dbFailureHandler = createRelayInboundHandler({
      home: f.home,
      queueRepo: dbThrowingRepo,
      missionControlWriteContract: f.daemon.missionControlWriteContract,
      missionControlActionLog: f.daemon.missionControlActionLog,
    });
    const dbFailEventId = "evt-db-unavailable-1";
    const dbFailRes = await dbFailureHandler.handle({
      authorizationHeader: `Bearer ${f.inboundTokenMain}`,
      rawBody: JSON.stringify({
        eventId: dbFailEventId,
        sender: { handle: "founder-handle" },
        replyRef: itemRef2,
        text: "Should fail 503 before seen reservation",
        ordering: "after-question",
      }),
    });
    expect(dbFailRes.status).toBe(503);
    expect(dbFailRes.body.error).toBe("queue_store_unavailable");
    expect(seen.statuses().get(computeRelayEventKey("relay-main", dbFailEventId))).toBeUndefined();
    expect(f.daemon.queueRepo.getById(digAsk2.qitemId)?.state).toBe("pending");
    expect(f.daemon.missionControlActionLog.listForQitem(digAsk2.qitemId, 5)).toHaveLength(0);
  });

  it("supports pull-mode GET /api/gateway/relay/outbox (read-only FIFO, cross-connector isolation, > 64 KiB, limit validation) and POST /api/gateway/relay/outbox/ack (custody receipt, update close, duplicate & archived-receipt reconciliation)", async () => {
    const f = await createRelayFixture({
      mainVars: {
        OPENRIG_RELAY_MODE: "pull",
        OPENRIG_RELAY_INBOUND_TOKEN: "relay-in-secret-main-token-001",
      },
      registerSecondaryRelay: true,
      secondaryVars: {
        OPENRIG_RELAY_MODE: "pull",
        OPENRIG_RELAY_INBOUND_TOKEN: "relay-in-secret-sec-token-002",
      },
    });

    // Pull-mode readiness reports ready with endpointUrl: null
    const readinessRes = await fetch(`${f.baseUrl}/api/gateway/human/founder/readiness`);
    expect(readinessRes.status).toBe(200);
    expect(await readinessRes.json()).toMatchObject({
      ok: true,
      readiness: {
        state: "ready",
        ready: true,
        connector: { kind: "relay", ref: "relay-main" },
      },
    });

    const longBody = "PULL-CJK-測試-🚀-".repeat(4500) + "PULL-TAIL-MARKER";
    const mainAsk = await createAskWithAcceptedRelayRef(f, {
      destinationSession: "founder@external",
      connectorRef: "relay-main",
      summary: "Pull ask > 64 KiB",
      body: longBody,
      humanIntent: "decision",
      recordViaPendingBufferOnly: true,
    });
    const mainUpdate = await createAskWithAcceptedRelayRef(f, {
      destinationSession: "founder@external",
      connectorRef: "relay-main",
      summary: "Pull informational update",
      body: "Informational notice body",
      humanIntent: "update",
      recordViaPendingBufferOnly: true,
    });
    const secAsk = await createAskWithAcceptedRelayRef(f, {
      destinationSession: "ops@external",
      connectorRef: "relay-sec",
      summary: "Secondary connector ask",
      body: "Secondary body",
      humanIntent: "decision",
      recordViaPendingBufferOnly: true,
    });

    // Unauthorized and browser-origin checks on GET /api/gateway/relay/outbox and POST /api/gateway/relay/outbox/ack
    const unauthList = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`);
    expect(unauthList.status).toBe(401);
    const originList = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        Origin: "https://evil.example",
      },
    });
    expect(originList.status).toBe(403);

    const invalidLimitRes = await fetch(`${f.baseUrl}/api/gateway/relay/outbox?limit=0`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(invalidLimitRes.status).toBe(400);
    expect(await invalidLimitRes.json()).toMatchObject({ error: "invalid_limit" });

    // Read-only listing: returns only relay-main's 2 pending envelopes in FIFO order; repeated read changes nothing
    const list1 = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(list1.status).toBe(200);
    const list1Body = (await list1.json()) as {
      ok: boolean;
      connectorRef: string;
      deliveries: Array<{ deliveryId: string; intent: string; body: string; replyRef: string | null }>;
    };
    expect(list1Body.ok).toBe(true);
    expect(list1Body.connectorRef).toBe("relay-main");
    expect(list1Body.deliveries.map((d) => d.deliveryId)).toEqual([
      mainAsk.payload.decisionId,
      mainUpdate.payload.decisionId,
    ]);
    expect(Buffer.byteLength(JSON.stringify(list1Body.deliveries[0]), "utf8")).toBeGreaterThan(65_536);
    expect(list1Body.deliveries[0]!.body).toContain("PULL-TAIL-MARKER");

    const listLimit1 = await fetch(`${f.baseUrl}/api/gateway/relay/outbox?limit=1`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(listLimit1.status).toBe(200);
    const listLimit1Body = (await listLimit1.json()) as { deliveries: Array<{ deliveryId: string }> };
    expect(listLimit1Body.deliveries.map((d) => d.deliveryId)).toEqual([mainAsk.payload.decisionId]);

    // Repeat full list: still has both items untouched, and zero acceptance receipts recorded yet
    const list2 = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(list2.status).toBe(200);
    const list2Body = (await list2.json()) as { deliveries: Array<{ deliveryId: string }> };
    expect(list2Body.deliveries.map((d) => d.deliveryId)).toEqual([
      mainAsk.payload.decisionId,
      mainUpdate.payload.decisionId,
    ]);
    expect(
      f.daemon.queueRepo.hasRelayOwnerNotificationReceipt(mainAsk.qitemId, mainAsk.payload.episodeKey),
    ).toBe(false);

    // Cross-connector ack attempt is rejected with 404 unknown_delivery (leaks nothing about other connectors)
    const crossAckRes = await fetch(`${f.baseUrl}/api/gateway/relay/outbox/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deliveryId: secAsk.payload.decisionId }),
    });
    expect(crossAckRes.status).toBe(404);
    expect(await crossAckRes.json()).toMatchObject({ error: "unknown_delivery" });

    // Closed schema validation and unknown deliveryId check (answered without scanning queue_transitions)
    const findReceiptSpy = vi.spyOn(
      f.daemon.queueRepo,
      "findRelayOwnerNotificationReceiptByDeliveryId",
    );
    const extraKeyAck = await fetch(`${f.baseUrl}/api/gateway/relay/outbox/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deliveryId: mainAsk.payload.decisionId, extra: true }),
    });
    expect(extraKeyAck.status).toBe(400);

    const unknownAck = await fetch(`${f.baseUrl}/api/gateway/relay/outbox/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deliveryId: "dec-does-not-exist-999" }),
    });
    expect(unknownAck.status).toBe(404);
    expect(await unknownAck.json()).toMatchObject({ error: "unknown_delivery" });
    expect(findReceiptSpy).not.toHaveBeenCalled();

    // Acknowledge mainAsk (decision) and mainUpdate (informational update)
    const ackAskRes = await fetch(`${f.baseUrl}/api/gateway/relay/outbox/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deliveryId: mainAsk.payload.decisionId }),
    });
    expect(ackAskRes.status).toBe(200);
    expect(await ackAskRes.json()).toEqual({
      ok: true,
      deliveryId: mainAsk.payload.decisionId,
      connectorRef: "relay-main",
      alreadyAccepted: false,
    });
    expect(
      f.daemon.queueRepo.hasRelayOwnerNotificationReceipt(mainAsk.qitemId, mainAsk.payload.episodeKey),
    ).toBe(true);
    // Custody ack does NOT close a decision item
    expect(f.daemon.queueRepo.getById(mainAsk.qitemId)?.state).toBe("pending");

    const ackUpdateRes = await fetch(`${f.baseUrl}/api/gateway/relay/outbox/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deliveryId: mainUpdate.payload.decisionId }),
    });
    expect(ackUpdateRes.status).toBe(200);
    expect(await ackUpdateRes.json()).toEqual({
      ok: true,
      deliveryId: mainUpdate.payload.decisionId,
      connectorRef: "relay-main",
      alreadyAccepted: false,
    });
    // Informational update is closed as delivered upon custody ack (same as push 2xx)
    expect(f.daemon.queueRepo.getById(mainUpdate.qitemId)?.state).toBe("done");

    // Outbox for relay-main is now empty; relay-sec still has secAsk pending
    const listMainAfter = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(((await listMainAfter.json()) as { deliveries: unknown[] }).deliveries).toEqual([]);

    const listSecAfter = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: { Authorization: `Bearer ${f.inboundTokenSecondary}` },
    });
    expect(
      ((await listSecAfter.json()) as { deliveries: Array<{ deliveryId: string }> }).deliveries.map(
        (d) => d.deliveryId,
      ),
    ).toEqual([secAsk.payload.decisionId]);

    // Duplicate ack after transition archival still reconciles idempotently (alreadyAccepted: true)
    // and answers directly from deliveredStore + attemptedStore without scanning history
    const oldIso = "2025-01-01T00:00:00.000Z";
    f.db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run(oldIso, mainUpdate.qitemId);
    f.db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(oldIso, mainUpdate.qitemId);
    expect(
      archiveAgedTerminalTransitions(f.db, { nowIso: "2026-11-07T00:00:00.000Z" }).archivedQitems,
    ).toBeGreaterThanOrEqual(1);

    findReceiptSpy.mockClear();
    const dupUpdateAck = await fetch(`${f.baseUrl}/api/gateway/relay/outbox/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deliveryId: mainUpdate.payload.decisionId }),
    });
    expect(dupUpdateAck.status).toBe(200);
    expect(await dupUpdateAck.json()).toEqual({
      ok: true,
      deliveryId: mainUpdate.payload.decisionId,
      connectorRef: "relay-main",
      alreadyAccepted: true,
    });
    expect(findReceiptSpy).not.toHaveBeenCalled();

    // Cross-connector duplicate ack for relay-main's already-accepted deliveryId is still rejected with 404 without scanning history
    const crossAcceptedAck = await fetch(`${f.baseUrl}/api/gateway/relay/outbox/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenSecondary}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deliveryId: mainUpdate.payload.decisionId }),
    });
    expect(crossAcceptedAck.status).toBe(404);
    expect(await crossAcceptedAck.json()).toMatchObject({ error: "unknown_delivery" });
    expect(findReceiptSpy).not.toHaveBeenCalled();
    findReceiptSpy.mockRestore();

    // Non-loopback TCP peers are rejected with 403 loopback_peer_required on /relay/outbox, /relay/outbox/ack, and /relay/inbound
    const nonLoopbackEnv = { incoming: { socket: { remoteAddress: "198.51.100.42" } } };
    for (const [path, method] of [
      ["/api/gateway/relay/outbox", "GET"],
      ["/api/gateway/relay/outbox/ack", "POST"],
      ["/api/gateway/relay/inbound", "POST"],
    ] as const) {
      const res = await f.daemon.app.request(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
        undefined,
        nonLoopbackEnv,
      );
      expect(res.status, `${method} ${path} from non-loopback peer`).toBe(403);
      expect(await res.json()).toMatchObject({ error: "loopback_peer_required" });
    }

    // An unacknowledged ask to a pull-mode profile aged past 120s is NOT never-posted and NOT in findUndelivered
    f.db.prepare("UPDATE queue_transitions SET ts = datetime('now', '-10 minutes') WHERE qitem_id = ?").run(secAsk.qitemId);
    expect(f.daemon.queueRepo.deliveryOutcomeFor(secAsk.qitemId)).toBeNull();
    expect(f.daemon.queueRepo.findUndelivered({ qitemId: secAsk.qitemId })).toHaveLength(0);
  });

  it("finishes partial receipt and drain sequence on retry after mid-ack failure and never shows unreadable storage as an empty outbox", async () => {
    const f = await createRelayFixture({
      mainVars: {
        OPENRIG_RELAY_MODE: "pull",
        OPENRIG_RELAY_INBOUND_TOKEN: "relay-in-secret-main-token-001",
      },
    });

    const dig1 = await f.daemon.queueRepo.create({
      sourceSession: "architect@rig",
      destinationSession: "founder@external",
      summary: "Pull digest item 1",
      body: "Body 1",
      humanIntent: "decision",
      humanAlert: true,
      nudge: false,
    });
    const dig2 = await f.daemon.queueRepo.create({
      sourceSession: "architect@rig",
      destinationSession: "founder@external",
      summary: "Pull digest item 2",
      body: "Body 2",
      humanIntent: "decision",
      humanAlert: true,
      nudge: false,
    });
    const ep1 = f.daemon.queueRepo.currentHumanRequiredEpisode(dig1.qitemId)!.key;
    const ep2 = f.daemon.queueRepo.currentHumanRequiredEpisode(dig2.qitemId)!.key;
    const digestDecisionId = "dec-pull-digest-retry-1";

    const preparedDigest = prepareRelayDecision(
      {
        kind: "outbound_decision",
        decisionId: digestDecisionId,
        op: OUTBOUND_OP,
        entityBindingRef: "founder@external",
        payload: {
          deliveryDigestPost: true,
          digestId: "dig-pull-1",
          qitemId: dig1.qitemId,
          notificationKey: "digest:founder@external:pull-1",
          destinationSession: "founder@external",
          summary: "Digest summary",
          body: "Digest body",
          humanIntent: "update",
          ownerNotificationKind: "human-required",
          ownerNotificationLevel: "INFO",
          memberReceipts: [
            { qitemId: dig1.qitemId, notificationKey: ep1, level: "ALERT", kind: "human-required", summary: "Pull digest item 1", body: "Body 1" },
            { qitemId: dig2.qitemId, notificationKey: ep2, level: "ALERT", kind: "human-required", summary: "Pull digest item 2", body: "Body 2" },
          ],
        },
        enqueuedAt: new Date().toISOString(),
      },
      {
        loadHumanRegistry: () => loadHumanRegistry(f.home),
        queueRepo: f.daemon.queueRepo,
        resolveOutcome: () => "digest",
      },
    );
    new DispatchBuffer(f.home).enqueue(preparedDigest);
    new SeenStore(relayStatePaths(f.home).attemptedPath).mark(
      digestDecisionId,
      "attempted:relay-main:digest",
    );

    // 1. Fail on second receipt write during ackOutbox -> returns 503 receipt_write_failed, retains in DispatchBuffer
    let failSecondReceipt = true;
    let receiptCalls = 0;
    const partialFailRepo = new Proxy(f.daemon.queueRepo, {
      get(target, prop, receiver) {
        if (prop === "recordRelayOwnerNotificationAccepted") {
          return (input: Parameters<QueueRepository["recordRelayOwnerNotificationAccepted"]>[0]) => {
            receiptCalls += 1;
            if (failSecondReceipt && receiptCalls === 2) {
              throw new Error("SQLITE_BUSY: simulated partial receipt failure on second digest member");
            }
            return target.recordRelayOwnerNotificationAccepted(input);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const partialHandler = createRelayInboundHandler({
      home: f.home,
      queueRepo: partialFailRepo,
      missionControlWriteContract: f.daemon.missionControlWriteContract,
      missionControlActionLog: f.daemon.missionControlActionLog,
    });

    const firstAck = await partialHandler.ackOutbox({
      authorizationHeader: `Bearer ${f.inboundTokenMain}`,
      rawBody: JSON.stringify({ deliveryId: digestDecisionId }),
    });
    expect(firstAck.status).toBe(503);
    expect(firstAck.body.error).toBe("receipt_write_failed");
    expect(f.daemon.queueRepo.hasRelayOwnerNotificationReceipt(dig1.qitemId, ep1)).toBe(true);
    expect(f.daemon.queueRepo.hasRelayOwnerNotificationReceipt(dig2.qitemId, ep2)).toBe(false);
    expect(new DispatchBuffer(f.home).pending().map((d) => d.decisionId)).toEqual([digestDecisionId]);

    // Outbox listing still shows the pending envelope so the connector can retry ack
    const midList = await partialHandler.listOutbox({
      authorizationHeader: `Bearer ${f.inboundTokenMain}`,
    });
    expect(midList.status).toBe(200);
    expect((midList.body.deliveries as Array<{ deliveryId: string }>).map((d) => d.deliveryId)).toEqual([
      digestDecisionId,
    ]);

    // 2. Retry ackOutbox once DB recovers -> finishes remaining receipt + marks delivered + drains buffer
    failSecondReceipt = false;
    const retryAck = await partialHandler.ackOutbox({
      authorizationHeader: `Bearer ${f.inboundTokenMain}`,
      rawBody: JSON.stringify({ deliveryId: digestDecisionId }),
    });
    expect(retryAck.status).toBe(200);
    expect(retryAck.body).toEqual({
      ok: true,
      deliveryId: digestDecisionId,
      connectorRef: "relay-main",
      alreadyAccepted: false,
    });
    expect(f.daemon.queueRepo.hasRelayOwnerNotificationReceipt(dig1.qitemId, ep1)).toBe(true);
    expect(f.daemon.queueRepo.hasRelayOwnerNotificationReceipt(dig2.qitemId, ep2)).toBe(true);
    expect(new DispatchBuffer(f.home).pending()).toHaveLength(0);

    // 3. Unreadable storage never appears as an empty outbox (returns 503)
    const bufferPath = join(f.home, "gateway", "dispatch-buffer.json");
    writeFileSync(bufferPath, "{corrupt-buffer-json\n", "utf8");

    const corruptBufferList = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(corruptBufferList.status).toBe(503);
    expect(await corruptBufferList.json()).toMatchObject({ error: "dispatch_buffer_unavailable" });

    const corruptBufferAck = await fetch(`${f.baseUrl}/api/gateway/relay/outbox/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deliveryId: digestDecisionId }),
    });
    expect(corruptBufferAck.status).toBe(503);
    expect(await corruptBufferAck.json()).toMatchObject({ error: "dispatch_buffer_unavailable" });

    // Restore valid buffer and make delivered SeenStore unreadable (directory) -> 503 seen_store_unavailable
    writeFileSync(bufferPath, JSON.stringify({ pending: [] }), "utf8");
    const deliveredPath = join(f.home, "state", "relay-delivered-decisions.jsonl");
    rmSync(deliveredPath, { recursive: true, force: true });
    mkdirSync(deliveredPath, { recursive: true });

    const corruptSeenList = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(corruptSeenList.status).toBe(503);
    expect(await corruptSeenList.json()).toMatchObject({ error: "seen_store_unavailable" });
  });

  it("pins 503 registry_unavailable wording across surfaces, gates listOutbox and ackOutbox on attempted decisions across hold/release/replay, and scopes digest replay completion to the digest deliveryId", async () => {
    const f = await createRelayFixture({
      mainVars: {
        OPENRIG_RELAY_MODE: "pull",
        OPENRIG_RELAY_INBOUND_TOKEN: "relay-in-secret-main-token-001",
      },
    });

    // 1. Registry-unavailable 503 messages capitalize surfaceLabel without duplicating "Relay relay ..."
    const unavailableHandler = createRelayInboundHandler({
      home: f.home,
      queueRepo: f.daemon.queueRepo,
      missionControlWriteContract: f.daemon.missionControlWriteContract,
      missionControlActionLog: f.daemon.missionControlActionLog,
      loadEntities: () => ({ ok: false, error: "simulated unreadable registry" }),
    });

    const unavailInbound = await unavailableHandler.handle({
      authorizationHeader: `Bearer ${f.inboundTokenMain}`,
      rawBody: "{}",
    });
    expect(unavailInbound.status).toBe(503);
    expect(unavailInbound.body).toEqual({
      error: "human_registry_unavailable",
      message: "Relay inbound authentication is unavailable because human registry cannot be read",
    });

    const unavailList = await unavailableHandler.listOutbox!({
      authorizationHeader: `Bearer ${f.inboundTokenMain}`,
    });
    expect(unavailList.status).toBe(503);
    expect(unavailList.body).toEqual({
      error: "human_registry_unavailable",
      message: "Relay outbox authentication is unavailable because human registry cannot be read",
    });

    const unavailAck = await unavailableHandler.ackOutbox!({
      authorizationHeader: `Bearer ${f.inboundTokenMain}`,
      rawBody: JSON.stringify({ deliveryId: "dec-any" }),
    });
    expect(unavailAck.status).toBe(503);
    expect(unavailAck.body).toEqual({
      error: "human_registry_unavailable",
      message: "Relay outbox ack authentication is unavailable because human registry cannot be read",
    });

    // 2. Unattempted decisions in DispatchBuffer (held/refused/threw before relayTransport.deliver)
    //    are NOT listed in /outbox and NOT ackable in /outbox/ack; once attempted/released, they are listed and ackable.
    const unattemptedAsk = await createAskWithAcceptedRelayRef(f, {
      destinationSession: "founder@external",
      connectorRef: "relay-main",
      summary: "Held ask not yet attempted by transport",
      body: "Held for quiet hours / threw before transport",
      humanIntent: "decision",
      recordViaPendingBufferOnly: true,
      markAttempted: false,
    });

    const listWhileHeld = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(listWhileHeld.status).toBe(200);
    expect(await listWhileHeld.json()).toEqual({
      ok: true,
      connectorRef: "relay-main",
      deliveries: [],
    });

    const ackWhileHeld = await fetch(`${f.baseUrl}/api/gateway/relay/outbox/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deliveryId: unattemptedAsk.payload.decisionId }),
    });
    expect(ackWhileHeld.status).toBe(404);
    expect(await ackWhileHeld.json()).toMatchObject({ error: "unknown_delivery" });
    expect(
      f.daemon.queueRepo.hasRelayOwnerNotificationReceipt(
        unattemptedAsk.qitemId,
        unattemptedAsk.payload.episodeKey,
      ),
    ).toBe(false);
    expect(new DispatchBuffer(f.home).pending().map((d) => d.decisionId)).toEqual([
      unattemptedAsk.payload.decisionId,
    ]);

    // Now release/replay through the gateway subsystem so relayTransport.deliver marks it attempted
    f.daemon.gatewaySubsystem.startServices();
    await new Promise((r) => setTimeout(r, 30));

    const listAfterRelease = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(listAfterRelease.status).toBe(200);
    const listAfterReleaseBody = (await listAfterRelease.json()) as {
      deliveries: Array<{ deliveryId: string }>;
    };
    expect(listAfterReleaseBody.deliveries.map((d) => d.deliveryId)).toEqual([
      unattemptedAsk.payload.decisionId,
    ]);

    const ackAfterRelease = await fetch(`${f.baseUrl}/api/gateway/relay/outbox/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deliveryId: unattemptedAsk.payload.decisionId }),
    });
    expect(ackAfterRelease.status).toBe(200);
    expect(await ackAfterRelease.json()).toEqual({
      ok: true,
      deliveryId: unattemptedAsk.payload.decisionId,
      connectorRef: "relay-main",
      alreadyAccepted: false,
    });
    expect(
      f.daemon.queueRepo.hasRelayOwnerNotificationReceipt(
        unattemptedAsk.qitemId,
        unattemptedAsk.payload.episodeKey,
      ),
    ).toBe(true);
    expect(new DispatchBuffer(f.home).pending()).toHaveLength(0);

    // 3. Shared digest member receipt from ANOTHER deliveryId does not cause a staged digest to complete/drain on replay
    const sharedMember = await f.daemon.queueRepo.create({
      sourceSession: "architect@rig",
      destinationSession: "founder@external",
      summary: "Shared digest member A",
      body: "Shared member A body",
      humanIntent: "decision",
      humanAlert: true,
      nudge: false,
    });
    const otherMember = await f.daemon.queueRepo.create({
      sourceSession: "architect@rig",
      destinationSession: "founder@external",
      summary: "Digest member B",
      body: "Member B body",
      humanIntent: "decision",
      humanAlert: true,
      nudge: false,
    });
    const epShared = f.daemon.queueRepo.currentHumanRequiredEpisode(sharedMember.qitemId)!.key;
    const epOther = f.daemon.queueRepo.currentHumanRequiredEpisode(otherMember.qitemId)!.key;
    const sharedDigestId = "dec-shared-digest-replay-1";

    const dispatchRes = f.daemon.gatewaySubsystem.dispatch(
      OUTBOUND_OP,
      "founder@external",
      {
        deliveryDigestPost: true,
        digestId: "dig-shared-1",
        qitemId: sharedMember.qitemId,
        notificationKey: "digest:founder@external:shared-1",
        destinationSession: "founder@external",
        summary: "Digest with shared member",
        body: "Shared digest body",
        humanIntent: "update",
        ownerNotificationKind: "human-required",
        ownerNotificationLevel: "INFO",
        memberReceipts: [
          {
            qitemId: sharedMember.qitemId,
            notificationKey: epShared,
            level: "ALERT",
            kind: "human-required",
            summary: "Shared digest member A",
            body: "Shared member A body",
          },
          {
            qitemId: otherMember.qitemId,
            notificationKey: epOther,
            level: "ALERT",
            kind: "human-required",
            summary: "Digest member B",
            body: "Member B body",
          },
        ],
      },
      { decisionId: sharedDigestId },
    );
    expect(dispatchRes.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 30));

    // Record an accepted receipt for sharedMember under a DIFFERENT deliveryId (e.g. a retained single decision)
    f.daemon.queueRepo.recordRelayOwnerNotificationAccepted({
      qitemId: sharedMember.qitemId,
      actorSession: "relay-connector",
      notificationKey: epShared,
      connectorRef: "relay-main",
      deliveryId: "dec-retained-single-shared-A",
      replyRef: null,
      replyRefHash: null,
      revision: f.daemon.queueRepo.decisionRevision(sharedMember),
      episodeKey: epShared,
      level: "ALERT",
      kind: "human-required",
    });
    expect(
      f.daemon.queueRepo.hasRelayOwnerNotificationReceipt(sharedMember.qitemId, epShared),
    ).toBe(true);
    expect(
      f.daemon.queueRepo.hasRelayOwnerNotificationReceipt(
        sharedMember.qitemId,
        epShared,
        sharedDigestId,
      ),
    ).toBe(false);

    // Replay the subsystem: sharedDigestId must NOT write otherMember's receipt or drain without ack
    f.daemon.gatewaySubsystem.restart();
    f.daemon.gatewaySubsystem.startServices();
    await new Promise((r) => setTimeout(r, 30));

    expect(
      f.daemon.queueRepo.hasRelayOwnerNotificationReceipt(otherMember.qitemId, epOther),
    ).toBe(false);
    expect(new DispatchBuffer(f.home).pending().map((d) => d.decisionId)).toEqual([
      sharedDigestId,
    ]);

    const listSharedDigest = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(listSharedDigest.status).toBe(200);
    expect(
      ((await listSharedDigest.json()) as { deliveries: Array<{ deliveryId: string }> }).deliveries.map(
        (d) => d.deliveryId,
      ),
    ).toEqual([sharedDigestId]);
  });

  it("pull notices: never staged or staging failed surfaces at 120s; staged and unpulled stays quiet, then surfaces after 24h; acknowledged reads accepted", async () => {
    const f = await createRelayFixture({
      mainVars: { OPENRIG_RELAY_MODE: "pull", OPENRIG_RELAY_INBOUND_TOKEN: "relay-in-secret-main-token-001" },
    });
    // Never staged: dispatch failed before the DispatchBuffer.
    const neverStaged = await f.daemon.queueRepo.create({
      sourceSession: "architect@rig",
      destinationSession: "founder@external",
      summary: "Never staged ask",
      body: "Dispatch failed before the buffer",
      humanIntent: "decision",
      humanAlert: true,
      nudge: false,
    });
    // Staging failed: in the DispatchBuffer, but the transport never marked it attempted, so the outbox doesn't list it.
    const stagingFailed = await createAskWithAcceptedRelayRef(f, {
      summary: "Staging failed",
      recordViaPendingBufferOnly: true,
      markAttempted: false,
    });
    // Staged and unpulled: listed by the outbox, never acknowledged.
    const staged = await createAskWithAcceptedRelayRef(f, { summary: "Staged, waiting for a pull", recordViaPendingBufferOnly: true });
    const backdate = (qitemId: string, modifier: string) =>
      f.db.prepare("UPDATE queue_transitions SET ts = datetime('now', ?) WHERE qitem_id = ?").run(modifier, qitemId);
    for (const id of [neverStaged.qitemId, stagingFailed.qitemId, staged.qitemId]) backdate(id, "-10 minutes");

    expect(f.daemon.queueRepo.deliveryOutcomeFor(neverStaged.qitemId)?.outcome).toBe("never-posted");
    expect(f.daemon.queueRepo.deliveryOutcomeFor(stagingFailed.qitemId)?.outcome).toBe("never-posted");
    expect(f.daemon.queueRepo.deliveryOutcomeFor(staged.qitemId)).toBeNull();
    expect(f.daemon.queueRepo.findUndelivered({ qitemId: staged.qitemId })).toHaveLength(0);

    // A listing works out the outbox's listable set once, not per item.
    const bufferSpy = vi.spyOn(DispatchBuffer.prototype, "pendingStrict");
    try {
      const outcomes = new Map(f.daemon.queueRepo.list({ limit: 100 }).map((it) => [it.qitemId, it.deliveryOutcome]));
      expect(outcomes.get(neverStaged.qitemId)).toBe("never-posted");
      expect(outcomes.get(stagingFailed.qitemId)).toBe("never-posted");
      expect(outcomes.get(staged.qitemId)).toBeNull();
      expect(bufferSpy).toHaveBeenCalledTimes(1);
    } finally {
      bufferSpy.mockRestore();
    }

    backdate(staged.qitemId, "-23 hours");
    expect(f.daemon.queueRepo.deliveryOutcomeFor(staged.qitemId)).toBeNull();
    backdate(staged.qitemId, "-25 hours");
    expect(f.daemon.queueRepo.deliveryOutcomeFor(staged.qitemId)?.outcome).toBe("never-posted");
    expect(f.daemon.queueRepo.findUndelivered({ qitemId: staged.qitemId })).toHaveLength(1);

    const ackRes = await fetch(`${f.baseUrl}/api/gateway/relay/outbox/ack`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.inboundTokenMain}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deliveryId: staged.payload.decisionId }),
    });
    expect(ackRes.status).toBe(200);
    expect(f.daemon.queueRepo.deliveryOutcomeFor(staged.qitemId)?.outcome).toBe("accepted");
    expect(f.daemon.queueRepo.findUndelivered({ qitemId: staged.qitemId })).toHaveLength(0);
  });

  it("a staged pull notice surfaces at 120s when the outbox can't list it because the delivered store is unreadable", async () => {
    const f = await createRelayFixture({
      mainVars: { OPENRIG_RELAY_MODE: "pull", OPENRIG_RELAY_INBOUND_TOKEN: "relay-in-secret-main-token-001" },
    });
    const staged = await createAskWithAcceptedRelayRef(f, { summary: "Staged, delivered store unreadable", recordViaPendingBufferOnly: true });
    f.db.prepare("UPDATE queue_transitions SET ts = datetime('now', '-10 minutes') WHERE qitem_id = ?").run(staged.qitemId);
    expect(f.daemon.queueRepo.deliveryOutcomeFor(staged.qitemId)).toBeNull();

    const deliveredPath = relayStatePaths(f.home).deliveredPath;
    rmSync(deliveredPath, { recursive: true, force: true });
    mkdirSync(deliveredPath, { recursive: true });
    const listRes = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(listRes.status).toBe(503);
    expect(await listRes.json()).toMatchObject({ error: "seen_store_unavailable" });
    expect(f.daemon.queueRepo.deliveryOutcomeFor(staged.qitemId)?.outcome).toBe("never-posted");
    expect(f.daemon.queueRepo.findUndelivered({ qitemId: staged.qitemId })).toHaveLength(1);
  });

  it("asks the pull outbox only once a notice is past the post window without a receipt", async () => {
    const f = await createRelayFixture({
      mainVars: { OPENRIG_RELAY_MODE: "pull", OPENRIG_RELAY_INBOUND_TOKEN: "relay-in-secret-main-token-001" },
    });
    const recent = await createAskWithAcceptedRelayRef(f, { summary: "Recent pull ask", recordViaPendingBufferOnly: true });
    const receipted = await createAskWithAcceptedRelayRef(f, { summary: "Accepted pull ask" });
    const aged = await createAskWithAcceptedRelayRef(f, { summary: "Aged pull ask", recordViaPendingBufferOnly: true });
    for (const id of [receipted.qitemId, aged.qitemId]) {
      f.db.prepare("UPDATE queue_transitions SET ts = datetime('now', '-10 minutes') WHERE qitem_id = ?").run(id);
    }
    const secretSpy = vi.spyOn(nodeSecretFs, "readFileSync");
    const bufferSpy = vi.spyOn(DispatchBuffer.prototype, "pendingStrict");
    try {
      expect(f.daemon.queueRepo.deliveryOutcomeFor(recent.qitemId)).toBeNull();
      expect(f.daemon.queueRepo.deliveryOutcomeFor(receipted.qitemId)?.outcome).toBe("accepted");
      expect(secretSpy).not.toHaveBeenCalled();
      expect(bufferSpy).not.toHaveBeenCalled();
      expect(f.daemon.queueRepo.deliveryOutcomeFor(aged.qitemId)).toBeNull();
      expect(secretSpy).toHaveBeenCalledTimes(1);
      expect(bufferSpy).toHaveBeenCalledTimes(1);
    } finally {
      secretSpy.mockRestore();
      bufferSpy.mockRestore();
    }
  });

  it("loads relay profiles once per listing, not once per pull-routed item", async () => {
    const f = await createRelayFixture({
      mainVars: { OPENRIG_RELAY_MODE: "pull", OPENRIG_RELAY_INBOUND_TOKEN: "relay-in-secret-main-token-001" },
    });
    const asks = [];
    for (const n of [1, 2, 3]) {
      asks.push(await createAskWithAcceptedRelayRef(f, { summary: `Pull ask ${n}`, recordViaPendingBufferOnly: true }));
    }
    // Past the post window, so each one's outcome depends on the relay profile.
    for (const ask of asks) {
      f.db.prepare("UPDATE queue_transitions SET ts = datetime('now', '-10 minutes') WHERE qitem_id = ?").run(ask.qitemId);
    }
    const secretSpy = vi.spyOn(nodeSecretFs, "readFileSync");
    try {
      const listed = f.daemon.queueRepo.list({ limit: 100 }).map((it) => it.qitemId);
      for (const ask of asks) expect(listed).toContain(ask.qitemId);
      expect(secretSpy).toHaveBeenCalledTimes(1);
    } finally {
      secretSpy.mockRestore();
    }
  });

  it("acknowledges a listed deliveryId over 512 characters: a quiet-release of an ask with a long supplied queue id round-trips", async () => {
    const f = await createRelayFixture({
      mainVars: { OPENRIG_RELAY_MODE: "pull", OPENRIG_RELAY_INBOUND_TOKEN: "relay-in-secret-main-token-001" },
    });
    const loadRegistry = () => loadHumanRegistry(f.home);
    expect(setHumanField("founder", "delivery-class", "B", f.home).ok).toBe(true);
    const quiet = new HumanQuietStore(f.db);
    const now = new Date();
    quiet.setUntil("founder", { until: new Date(now.getTime() + 3_600_000), timezone: "UTC", setBy: "test", now });

    const ask = await f.daemon.queueRepo.create({
      qitemId: `qitem-long-${"a".repeat(560)}`,
      sourceSession: "architect@rig",
      destinationSession: "founder@external",
      summary: "Long queue id ask",
      body: "Held for quiet hours, then released",
      humanIntent: "decision",
      humanAlert: true,
      nudge: false,
    });
    const ports = makeQueuePorts(f.daemon.queueRepo, { loadHumanRegistry: loadRegistry } as never);
    const alert = (await ports.listHumanAlerts({ minimumLevel: "NOTICE" })).find((a) => a.qitemId === ask.qitemId)!;
    expect(f.daemon.gatewaySubsystem.dispatch(OUTBOUND_OP, alert.destinationSession!, alert).ok).toBe(true);
    f.daemon.gatewaySubsystem.startServices();
    await new Promise((r) => setTimeout(r, 30));
    expect(
      f.daemon.queueRepo.listTransitions(ask.qitemId).some((t) => (t.transitionNote ?? "").startsWith("delivery-decision: quiet-hold ")),
    ).toBe(true);

    // Quiet ends: the release job produces the delivery id quiet-release:<notification key>.
    quiet.end("founder", { endedBy: "test", now: new Date() });
    const jobsRepo = new WatchdogJobsRepository(f.db);
    const job = jobsRepo.listActive().find((j) => j.policy === QUIET_RELEASE_POLICY)!;
    const rel = await runQuietRelease({
      queueRepo: f.daemon.queueRepo,
      jobsRepo,
      home: f.home,
      jobId: job.jobId,
      now: new Date(),
      registry: { loadHumanRegistry: loadRegistry, resolveSlackHandle },
      dispatch: (op, ref, payload, opts) => f.daemon.gatewaySubsystem.dispatch(op, ref, payload, opts),
    });
    expect(rel).toMatchObject({ released: 1 });
    await new Promise((r) => setTimeout(r, 30));

    const listRes = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(listRes.status).toBe(200);
    const listed = ((await listRes.json()) as { deliveries: Array<{ deliveryId: string }> }).deliveries.map((d) => d.deliveryId);
    expect(listed).toEqual([`quiet-release:${alert.notificationKey}`]);
    expect(listed[0]!.length).toBeGreaterThan(512);

    const ackRes = await fetch(`${f.baseUrl}/api/gateway/relay/outbox/ack`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.inboundTokenMain}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deliveryId: listed[0] }),
    });
    expect(ackRes.status).toBe(200);
    expect(await ackRes.json()).toEqual({ ok: true, deliveryId: listed[0], connectorRef: "relay-main", alreadyAccepted: false });
    expect(f.daemon.queueRepo.hasRelayOwnerNotificationReceipt(ask.qitemId, alert.notificationKey!)).toBe(true);
    expect(f.daemon.queueRepo.deliveryOutcomeFor(ask.qitemId)?.outcome).toBe("accepted");

    const relistRes = await fetch(`${f.baseUrl}/api/gateway/relay/outbox`, {
      headers: { Authorization: `Bearer ${f.inboundTokenMain}` },
    });
    expect(((await relistRes.json()) as { deliveries: unknown[] }).deliveries).toEqual([]);
  });
});
