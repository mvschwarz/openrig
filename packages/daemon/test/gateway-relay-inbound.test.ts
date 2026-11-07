import { afterEach, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
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
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { GatewaySubsystem } from "../src/domain/gateway/gateway-subsystem.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { addHumanFragment, loadHumanRegistry } from "../src/domain/gateway/human-registry.js";
import { OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";
import {
  encodeRelayReplyRef,
  hashRelayReplyRef,
  prepareRelayDecision,
  type RelayReplyRefPayload,
} from "../src/domain/gateway/relay-outbound.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import {
  RELAY_INBOUND_SEEN_FILE,
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

    // 3. Forwarding / proxy headers over real loopback TCP are rejected (403)
    for (const headerName of [
      "X-Forwarded-For",
      "Forwarded",
      "X-Real-Ip",
      "Via",
      "X-Forwarded-Host",
      "X-Forwarded-Proto",
    ]) {
      const proxiedRes = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.inboundTokenMain}`,
          "Content-Type": "application/json",
          [headerName]: "127.0.0.1",
        },
        body: JSON.stringify(validBody),
      });
      expect(proxiedRes.status, `header ${headerName}`).toBe(403);
    }

    // 4. Browser boundary rejects cross-origin and untrusted Host requests (403)
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

    // Verify qitem is still untouched (pending)
    expect(f.daemon.queueRepo.getById(qitemId)?.state).toBe("pending");
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

    // Insecure permissions (0644) -> unready profile, rejects even with matching token and never leaks secret
    const insecure = await createRelayFixture({ mainSecretMode: 0o644 });
    const { replyRef: insecureRef } = await createAskWithAcceptedRelayRef(insecure);
    const insecureRes = await fetch(`${insecure.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${insecure.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-auth-2",
        sender: { handle: "founder-handle" },
        replyRef: insecureRef,
        text: "Should fail due to 0644",
      }),
    });
    expect(insecureRes.status).toBe(401);
    const insecureBodyText = await insecureRes.text();
    expect(insecureBodyText).not.toContain(insecure.inboundTokenMain);
    expect(insecureBodyText).not.toContain(insecure.outboundTokenMain);

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

  it("validates closed bounded JSON schema and rejects unknown keys, malformed JSON, and oversized bodies", async () => {
    const f = await createRelayFixture();
    const { replyRef } = await createAskWithAcceptedRelayRef(f);

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

    // Unknown top-level key (e.g., actorSession injection attempt)
    const extraTopKey = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-schema-1",
        sender: { handle: "founder-handle" },
        replyRef,
        text: "Hello",
        actorSession: "founder@external",
      }),
    });
    expect(extraTopKey.status).toBe(400);

    // Unknown nested sender key
    const extraSenderKey = await fetch(`${f.baseUrl}/api/gateway/relay/inbound`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.inboundTokenMain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventId: "evt-schema-2",
        sender: { handle: "founder-handle", entityId: "founder" },
        replyRef,
        text: "Hello",
      }),
    });
    expect(extraSenderKey.status).toBe(400);

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

    // Case D: Corrupt seen-store file refuses 2xx (returns 503)
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
});
