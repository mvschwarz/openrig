import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildInProcessWire } from "../src/domain/gateway/gateway-subsystem.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { OUTBOUND_OP, type OutboundPostPayload } from "../src/domain/gateway/slack/outbound-driver.js";
import { SeenStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";
import {
  RELAY_PROTOCOL_VERSION,
  RELAY_ENVELOPE_MAX_BYTES,
  encodeRelayReplyRef,
  decodeRelayReplyRef,
  hashRelayReplyRef,
  validateRelayOutboundEnvelope,
  splitRelayOutboundEnvelope,
  findPendingRelayReplyRef,
  resolvePrimaryRelayBinding,
  prepareRelayDecision,
  postRelayEnvelope,
  createRelayOutboundTransport,
  type RelayAcceptedReceiptInfo,
  type RelayOutboundEnvelope,
  type RelayPayloadCarry,
  type RelayReplyRefPayload,
} from "../src/domain/gateway/relay-outbound.js";
import {
  reassembleRelayEnvelopeParts,
  startRecordingRelay,
} from "./fixtures/recording-relay.js";

function memFs(): StateFsOps & { files: Map<string, string>; failReadsFor: Set<string> } {
  const files = new Map<string, string>();
  const failReadsFor = new Set<string>();
  return {
    files,
    failReadsFor,
    readFileSync: (p) => {
      if (failReadsFor.has(p)) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: "EACCES" });
      }
      if (!files.has(p)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
      }
      return files.get(p)!;
    },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (a, b) => {
      files.set(b, files.get(a) ?? "");
      files.delete(a);
    },
    mkdirp: () => {},
  };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

/** Recording in-memory bridge fixture modeling operator bridge custody + deliveryId deduplication. */
function recordingBridgeFixture(opts?: {
  failFirstHttp?: boolean;
  commitBeforeDropOnFirst?: boolean;
  redirectTo?: string;
  statusCode?: number;
  responseBody?: string;
}) {
  const custodyByDeliveryId = new Map<string, RelayOutboundEnvelope>();
  const attempts: Array<{ url: string; auth: string | null; envelope: RelayOutboundEnvelope }> = [];
  let callCount = 0;

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    callCount++;
    if (opts?.redirectTo) {
      if (init?.redirect === "error") {
        throw new TypeError("fetch failed: redirect mode is set to error");
      }
      return new Response("", { status: 302, headers: { location: opts.redirectTo } });
    }
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const envelope = JSON.parse(String(init?.body ?? "{}")) as RelayOutboundEnvelope;
    attempts.push({ url, auth, envelope });

    if (opts?.failFirstHttp && callCount === 1) {
      if (opts.commitBeforeDropOnFirst) {
        // Bridge committed custody of deliveryId, but the HTTP response was lost in flight.
        if (!custodyByDeliveryId.has(envelope.deliveryId)) {
          custodyByDeliveryId.set(envelope.deliveryId, envelope);
        }
      }
      throw new Error("socket hang up after bridge custody commit");
    }

    if (opts?.statusCode && opts.statusCode >= 400) {
      return new Response(opts.responseBody ?? JSON.stringify({ error: "bridge_error" }), {
        status: opts.statusCode,
        headers: { "content-type": "application/json" },
      });
    }

    // Bridge deduplicates by deliveryId and commits custody before returning 2xx.
    const deduplicated = custodyByDeliveryId.has(envelope.deliveryId);
    if (!deduplicated) {
      custodyByDeliveryId.set(envelope.deliveryId, envelope);
    }
    return new Response(JSON.stringify({ ok: true, deliveryId: envelope.deliveryId, deduplicated }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    fetchImpl,
    custodyByDeliveryId,
    attempts,
    callCount: () => callCount,
  };
}

describe("Capability 3 — relay-outbound protocol v1, replyRef, and pure transport", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "relay-outbound-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("encodes, decodes, validates, and hashes opaque base64url replyRef payloads with closed schema", () => {
    const payload: RelayReplyRefPayload = {
      v: RELAY_PROTOCOL_VERSION,
      qitemId: "qitem-ask-1",
      episodeKey: "qitem-ask-1:42",
      decisionRevision: "dr1-abcdef0123456789abcdef01",
      decisionId: "dec-101",
      connectorRef: "wa-main",
      mode: "park",
      digest: true,
    };
    const encoded = encodeRelayReplyRef(payload);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);

    const decoded = decodeRelayReplyRef(encoded);
    expect(decoded).toEqual({ ok: true, ref: payload });
    expect(hashRelayReplyRef(encoded)).toMatch(/^[0-9a-f]{64}$/);

    // Closed schema: reject unknown keys, wrong version, bad mode, or non-base64url
    const withUnknownKey = Buffer.from(JSON.stringify({ ...payload, extra: "nope" }), "utf8").toString("base64url");
    expect(decodeRelayReplyRef(withUnknownKey).ok).toBe(false);

    const wrongVersion = Buffer.from(JSON.stringify({ ...payload, v: 2 }), "utf8").toString("base64url");
    expect(decodeRelayReplyRef(wrongVersion).ok).toBe(false);

    expect(decodeRelayReplyRef("not valid json base64!").ok).toBe(false);
  });

  it("freezes protocol v1 closed envelope before enqueue: decision carries replyRef, update/notice has replyRef=null, digest carries per-question refs", () => {
    const reg = {
      ok: true as const,
      entities: [
        {
          entityId: "sam",
          class: "human" as const,
          displayName: "Sam",
          address: "sam@external",
          connectorBindings: [
            {
              kind: "relay",
              connectorRef: "wa-primary",
              secretsRef: "file:/tmp/wa.env",
              role: "primary" as const,
              handle: "sam_wa",
            },
          ],
          prefs: { deliveryClass: "B" as const, availability: "available" as const },
        },
      ],
    };

    const items = new Map<string, { qitemId: string; state: string; humanIntent?: "decision" | "update" | null; revision: string; episodeKey: string }>([
      ["q-park-1", { qitemId: "q-park-1", state: "blocked", humanIntent: "decision", revision: "dr1-rev-park-1", episodeKey: "q-park-1:7" }],
      ["q-ask-2", { qitemId: "q-ask-2", state: "pending", humanIntent: "decision", revision: "dr1-rev-ask-2", episodeKey: "q-ask-2:3" }],
      ["q-upd-1", { qitemId: "q-upd-1", state: "pending", humanIntent: "update", revision: "dr1-rev-upd-1", episodeKey: "q-upd-1:1" }],
    ]);

    const prepareOpts = {
      loadHumanRegistry: () => reg,
      lookupQuestionState: (qitemId: string, fallbackKey?: string | null) => {
        const found = items.get(qitemId);
        if (!found) return null;
        return {
          qitemId,
          mode: (found.state === "blocked" ? "park" : "ask") as "park" | "ask",
          episodeKey: fallbackKey ?? found.episodeKey,
          decisionRevision: found.revision,
          humanIntent: found.humanIntent ?? null,
        };
      },
    };

    // 1. Decision ask/park -> replyRef non-null, structured questions rendered as plain text, secrets redacted
    const parkDecision: OutboundDecision = {
      kind: "outbound_decision",
      decisionId: "dec-park-1",
      op: OUTBOUND_OP,
      entityBindingRef: "sam@external",
      payload: {
        qitemId: "q-park-1",
        notificationKey: "q-park-1:7",
        ownerNotificationKind: "human-required",
        ownerNotificationLevel: "ALERT",
        humanIntent: "decision",
        summary: "Approve release?",
        body: "Token xoxb-1234567890-abcdef should be redacted.",
        humanDetail: "Extra detail line.",
        humanQuestions: [
          {
            id: "q1",
            question: "Which target?",
            options: [
              { id: "staging", label: "Staging", recommended: true },
              { id: "prod", label: "Production" },
            ],
          },
        ],
        destinationSession: "sam@external",
        sourceSession: "lead@rig",
        state: "blocked",
      } satisfies OutboundPostPayload,
    };

    const preparedPark = prepareRelayDecision(parkDecision, { ...prepareOpts, resolveOutcome: () => "interrupt" });
    const envPark = (preparedPark.payload as { relayEnvelope?: RelayOutboundEnvelope }).relayEnvelope!;
    expect(envPark).toBeDefined();
    expect(validateRelayOutboundEnvelope(envPark)).toEqual({ ok: true, envelope: envPark });
    expect(envPark.deliveryId).toBe("dec-park-1");
    expect(envPark.recipient).toEqual({ handle: "sam_wa" });
    expect(envPark.intent).toBe("decision");
    expect(envPark.outcome).toBe("interrupt");
    expect(envPark.body).toContain("[redacted-secret]");
    expect(envPark.body).not.toContain("xoxb-1234567890-abcdef");
    expect(envPark.body).toContain("Which target?");
    expect(envPark.body).toContain("Staging (recommended)");
    expect(envPark.body).toContain("Extra detail line.");
    expect(envPark.replyRef).not.toBeNull();
    const decodedRef = decodeRelayReplyRef(envPark.replyRef!);
    expect(decodedRef).toEqual({
      ok: true,
      ref: {
        v: 1,
        qitemId: "q-park-1",
        episodeKey: "q-park-1:7",
        decisionRevision: "dr1-rev-park-1",
        decisionId: "dec-park-1",
        connectorRef: "wa-primary",
        mode: "park",
      },
    });

    // 2. Informational update -> replyRef is strictly null
    const updateDecision: OutboundDecision = {
      kind: "outbound_decision",
      decisionId: "dec-upd-1",
      op: OUTBOUND_OP,
      entityBindingRef: "sam@external",
      payload: {
        qitemId: "q-upd-1",
        notificationKey: "q-upd-1:1",
        ownerNotificationKind: "human-update",
        ownerNotificationLevel: "NOTICE",
        humanIntent: "update",
        summary: "FYI build green",
        body: "All checks passed.",
        destinationSession: "sam@external",
      } satisfies OutboundPostPayload,
    };
    const preparedUpdate = prepareRelayDecision(updateDecision, { ...prepareOpts, resolveOutcome: () => "notify" });
    const envUpdate = (preparedUpdate.payload as { relayEnvelope?: RelayOutboundEnvelope }).relayEnvelope!;
    expect(envUpdate.intent).toBe("update");
    expect(envUpdate.outcome).toBe("notify");
    expect(envUpdate.replyRef).toBeNull();

    // 3. Multi-item digest -> top-level replyRef is null; per-question refs in items[] prevent one reply from approving several
    const digestDecision: OutboundDecision = {
      kind: "outbound_decision",
      decisionId: "digest:multi-1",
      op: OUTBOUND_OP,
      entityBindingRef: "sam@external",
      payload: {
        deliveryDigestPost: true,
        digestId: "multi-1",
        qitemId: "q-park-1",
        destinationSession: "sam@external",
        summary: "Delivery digest (4h) — 2 item(s)",
        body: "• Approve release? [q-park-1]\n• Confirm API? [q-ask-2]",
        memberReceipts: [
          { qitemId: "q-park-1", notificationKey: "q-park-1:7", level: "ALERT", kind: "human-required" },
          { qitemId: "q-ask-2", notificationKey: "q-ask-2:3", level: "ALERT", kind: "human-required" },
        ],
      },
    };
    const preparedDigest = prepareRelayDecision(digestDecision, { ...prepareOpts, resolveOutcome: () => "digest" });
    const envDigest = (preparedDigest.payload as { relayEnvelope?: RelayOutboundEnvelope }).relayEnvelope!;
    expect(envDigest.outcome).toBe("digest");
    expect(envDigest.replyRef, "multi-question digest top-level replyRef must be null so one reply cannot resolve both").toBeNull();
    expect(envDigest.items).toHaveLength(2);
    expect(envDigest.items![0]!.replyRef).not.toBeNull();
    expect(envDigest.items![1]!.replyRef).not.toBeNull();
    expect(envDigest.items![0]!.replyRef).not.toBe(envDigest.items![1]!.replyRef);
    const dRef1 = decodeRelayReplyRef(envDigest.items![0]!.replyRef!);
    const dRef2 = decodeRelayReplyRef(envDigest.items![1]!.replyRef!);
    expect(dRef1.ok && dRef1.ref.qitemId === "q-park-1" && dRef1.ref.digest === true && dRef1.ref.mode === "park").toBe(true);
    expect(dRef2.ok && dRef2.ref.qitemId === "q-ask-2" && dRef2.ref.digest === true && dRef2.ref.mode === "ask").toBe(true);

    // 4. Missing queue row or noncurrent episode NEVER mints a synthetic replyRef
    const missingRowDecision: OutboundDecision = {
      kind: "outbound_decision",
      decisionId: "dec-missing-row",
      op: OUTBOUND_OP,
      entityBindingRef: "sam@external",
      payload: {
        qitemId: "q-missing-row",
        notificationKey: "q-missing-row:1",
        ownerNotificationKind: "human-required",
        ownerNotificationLevel: "ALERT",
        humanIntent: "decision",
        summary: "Missing queue row",
        body: "Should not get a synthetic dr1 revision",
        destinationSession: "sam@external",
      } satisfies OutboundPostPayload,
    };
    const preparedMissing = prepareRelayDecision(missingRowDecision, {
      loadHumanRegistry: () => reg,
      queueRepo: {
        getById: () => null,
        currentHumanRequiredEpisode: () => null,
        decisionRevision: () => "dr1-never",
      },
      resolveOutcome: () => "interrupt",
    });
    const envMissing = (preparedMissing.payload as { relayEnvelope?: RelayOutboundEnvelope }).relayEnvelope!;
    expect(envMissing.replyRef, "unavailable/noncurrent question state must never mint a replyRef").toBeNull();
  });

  it("recovers exact offered replyRef from pending DispatchBuffer before acceptance receipt lands", async () => {
    let releaseDeliver: () => void = () => {};
    const gate = new Promise<{ ok: true }>((r) => {
      releaseDeliver = () => r({ ok: true });
    });

    const offeredRef = encodeRelayReplyRef({
      v: 1,
      qitemId: "q-pending-1",
      episodeKey: "q-pending-1:2",
      decisionRevision: "dr1-pending-rev-1",
      decisionId: "dec-pending-1",
      connectorRef: "wa-main",
      mode: "park",
    });

    const wire = buildInProcessWire({
      home,
      ops: [OUTBOUND_OP],
      prepare: (d) => ({
        ...d,
        payload: {
          ...(d.payload as object),
          relayConnectorRef: "wa-main",
          relayEnvelope: {
            v: 1,
            deliveryId: d.decisionId,
            recipient: { handle: "sam_wa" },
            intent: "decision",
            outcome: "interrupt",
            summary: "Pending ask",
            body: "Pending body",
            replyRef: offeredRef,
          } satisfies RelayOutboundEnvelope,
        },
      }),
      deliver: () => gate,
    });

    wire.dispatcher.dispatch(OUTBOUND_OP, "sam@external", { qitemId: "q-pending-1" }, { decisionId: "dec-pending-1" });

    // Exact offered replyRef is recoverable from the pending buffer
    const found = findPendingRelayReplyRef(home, offeredRef);
    expect(found).toEqual({
      found: true,
      decisionId: "dec-pending-1",
      connectorRef: "wa-main",
      qitemId: "q-pending-1",
      episodeKey: "q-pending-1:2",
      decisionRevision: "dr1-pending-rev-1",
      mode: "park",
    });

    // Forged ref with valid structure but not actually offered is rejected
    const forgedRef = encodeRelayReplyRef({
      v: 1,
      qitemId: "q-pending-1",
      episodeKey: "q-pending-1:2",
      decisionRevision: "dr1-forged-rev",
      decisionId: "dec-pending-1",
      connectorRef: "wa-main",
      mode: "park",
    });
    expect(findPendingRelayReplyRef(home, forgedRef)).toEqual({ found: false });

    releaseDeliver();
    await tick();
    expect(findPendingRelayReplyRef(home, offeredRef)).toEqual({ found: false });
  });

  it("enforces loopback http endpoint, rejects redirects, bounds timeouts, and sanitizes secret tokens on error", async () => {
    const sampleEnvelope: RelayOutboundEnvelope = {
      v: 1,
      deliveryId: "dec-sec-1",
      recipient: { handle: "sam_wa" },
      intent: "decision",
      outcome: "interrupt",
      summary: "Test",
      body: "Body",
      replyRef: null,
    };

    // 1. Non-loopback or non-http or URL credentials rejected without calling fetch
    let fetchCalled = false;
    const neverFetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };
    const nonLoopback = await postRelayEnvelope({
      url: "http://192.168.1.50:8080/outbound",
      outboundToken: "secret-outbound-token-12345",
      envelope: sampleEnvelope,
      fetchImpl: neverFetch,
    });
    expect(nonLoopback.ok).toBe(false);
    expect(nonLoopback.class).toBe("invalid-endpoint");
    expect(fetchCalled).toBe(false);

    const urlCreds = await postRelayEnvelope({
      url: "http://user:pass@127.0.0.1:8080/outbound",
      outboundToken: "secret-outbound-token-12345",
      envelope: sampleEnvelope,
      fetchImpl: neverFetch,
    });
    expect(urlCreds.ok).toBe(false);
    expect(urlCreds.class).toBe("invalid-endpoint");
    expect(fetchCalled).toBe(false);

    // 2. Redirect rejected
    const redirectBridge = recordingBridgeFixture({ redirectTo: "http://example.com/steal" });
    const redirected = await postRelayEnvelope({
      url: "http://127.0.0.1:9090/outbound",
      outboundToken: "secret-outbound-token-12345",
      envelope: sampleEnvelope,
      fetchImpl: redirectBridge.fetchImpl,
    });
    expect(redirected.ok).toBe(false);

    // 3. Error message or bridge HTTP response body is never echoed; fixed sanitized status/reason only
    const secretToken = "relay-secret-token-9988776655";
    const leakyFetch = async () => {
      throw new Error(`request failed with raw credential ${secretToken} and Authorization: Bearer ${secretToken}`);
    };
    const leaked = await postRelayEnvelope({
      url: "http://localhost:9090/outbound",
      outboundToken: secretToken,
      envelope: sampleEnvelope,
      fetchImpl: leakyFetch,
    });
    expect(leaked.ok).toBe(false);
    expect(leaked.detail).not.toContain(secretToken);

    const bridge502 = recordingBridgeFixture({
      statusCode: 502,
      responseBody: `upstream failed with inboundToken=${secretToken} and extra details`,
    });
    const badStatus = await postRelayEnvelope({
      url: "http://127.0.0.1:9090/outbound",
      outboundToken: secretToken,
      envelope: sampleEnvelope,
      fetchImpl: bridge502.fetchImpl,
    });
    expect(badStatus).toEqual({
      ok: false,
      status: 502,
      class: "http-502",
      detail: "http 502",
    });
  });

  it("proves durable-before-network, stable replay on lost ACK with recording fake bridge, and no plaintext answers/secrets in SeenStore metadata", async () => {
    const fsx = memFs();
    const attempted = new SeenStore("/state/relay-attempted-decisions.jsonl", fsx);
    const delivered = new SeenStore("/state/relay-delivered-decisions.jsonl", fsx);
    const outboundSeen = new SeenStore("/state/slack-outbound-seen.jsonl", fsx);

    const bridge = recordingBridgeFixture({ failFirstHttp: true, commitBeforeDropOnFirst: true });
    const receipts: RelayAcceptedReceiptInfo[] = [];
    const failures: Array<{ failureClass: string; detail: string }> = [];

    let mutableRevision = "dr1-initial-rev-001";
    const reg = {
      ok: true as const,
      entities: [
        {
          entityId: "sam",
          class: "human" as const,
          displayName: "Sam",
          address: "sam@external",
          connectorBindings: [
            {
              kind: "relay",
              connectorRef: "wa-main",
              secretsRef: "file:/tmp/wa.env",
              role: "primary" as const,
              handle: "sam_wa",
            },
          ],
          prefs: { deliveryClass: "A" as const, availability: "available" as const },
        },
      ],
    };

    const transport = createRelayOutboundTransport({
      attempted,
      delivered,
      outboundSeen,
      fetchImpl: bridge.fetchImpl,
      resolveProfile: (connectorRef) =>
        connectorRef === "wa-main"
          ? { ok: true, connectorRef, url: "http://127.0.0.1:43110/outbound", outboundToken: "out-tok-secret-123456" }
          : { ok: false, reason: "unknown profile" },
      onAccepted: (info) => {
        receipts.push(info);
      },
      onTransportFailed: (_p, failureClass, detail) => {
        failures.push({ failureClass, detail });
      },
    });

    const wire = buildInProcessWire({
      home,
      ops: [OUTBOUND_OP],
      prepare: (d) =>
        prepareRelayDecision(d, {
          loadHumanRegistry: () => reg,
          lookupQuestionState: (qitemId, fallbackKey) => ({
            qitemId,
            mode: "park",
            episodeKey: fallbackKey ?? `${qitemId}:1`,
            decisionRevision: mutableRevision,
            humanIntent: "decision",
          }),
          resolveOutcome: () => "interrupt",
        }),
      deliver: (d) => transport.deliver(d),
    });

    const payload: OutboundPostPayload = {
      qitemId: "q-replay-1",
      notificationKey: "q-replay-1:1",
      ownerNotificationKind: "human-required",
      ownerNotificationLevel: "ALERT",
      humanIntent: "decision",
      summary: "Deploy v2?",
      body: "Sensitive body text with Bearer secret-token-abcdef123456",
      destinationSession: "sam@external",
      sourceSession: "lead@rig",
      state: "blocked",
    };

    // Dispatch: prepare freezes envelope, enqueues to DispatchBuffer, then attempts HTTP 1 (which drops after bridge custody commit)
    const disp = wire.dispatcher.dispatch(OUTBOUND_OP, "sam@external", payload, { decisionId: "dec-replay-1" });
    expect(disp.ok).toBe(true);
    await tick();

    // Bridge has custody of 1 message, but OpenRig lost the ACK -> retained in DispatchBuffer, attempted marked, NOT delivered
    expect(bridge.custodyByDeliveryId.size).toBe(1);
    expect(bridge.callCount()).toBe(1);
    expect(attempted.load().has("dec-replay-1")).toBe(true);
    expect(delivered.load().has("dec-replay-1")).toBe(false);
    expect(receipts).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);

    // Mutate current revision before replay to prove replay sends the EXACT frozen envelope and does NOT recompute refs
    mutableRevision = "dr1-mutated-later-rev-999";

    // Replay: sends identical deliveryId + identical replyRef; bridge deduplicates; receipt written; buffer drained
    wire.startServices?.();
    await tick();

    expect(bridge.callCount()).toBe(2);
    expect(bridge.custodyByDeliveryId.size, "bridge deduplicates same deliveryId").toBe(1);
    expect(bridge.attempts[1]!.envelope).toEqual(bridge.attempts[0]!.envelope);
    const replayedRef = decodeRelayReplyRef(bridge.attempts[1]!.envelope.replyRef!);
    expect(replayedRef.ok && replayedRef.ref.decisionRevision).toBe("dr1-initial-rev-001");

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      qitemId: "q-replay-1",
      notificationKey: "q-replay-1:1",
      connectorRef: "wa-main",
      deliveryId: "dec-replay-1",
      refHash: hashRelayReplyRef(bridge.attempts[0]!.envelope.replyRef!),
      revision: "dr1-initial-rev-001",
    });

    expect(delivered.load().has("dec-replay-1")).toBe(true);
    expect(outboundSeen.load().has("q-replay-1:1")).toBe(true);
    expect(new DispatchBuffer(home).pending()).toHaveLength(0);

    // Verify no secrets or plaintext body/answers in SeenStore metadata files
    for (const content of fsx.files.values()) {
      expect(content).not.toContain("out-tok-secret-123456");
      expect(content).not.toContain("Sensitive body text");
      expect(content).not.toContain("secret-token-abcdef123456");
    }
  });

  it("retains decision in DispatchBuffer on profile failure, receipt write failure, or unreadable strict SeenStore", async () => {
    const fsx = memFs();
    const attempted = new SeenStore("/state/relay-attempted-decisions.jsonl", fsx);
    const delivered = new SeenStore("/state/relay-delivered-decisions.jsonl", fsx);
    const outboundSeen = new SeenStore("/state/slack-outbound-seen.jsonl", fsx);
    const bridge = recordingBridgeFixture();

    let profileReady = false;
    let failReceiptWrite = true;
    const receipts: RelayAcceptedReceiptInfo[] = [];

    const transport = createRelayOutboundTransport({
      attempted,
      delivered,
      outboundSeen,
      fetchImpl: bridge.fetchImpl,
      resolveProfile: (connectorRef) =>
        profileReady
          ? { ok: true, connectorRef, url: "http://127.0.0.1:43110/outbound", outboundToken: "out-tok-valid-123456" }
          : { ok: false, reason: "relay secrets file missing or permissions insecure" },
      onAccepted: (info) => {
        if (failReceiptWrite) throw new Error("sqlite busy: receipt write failed");
        receipts.push(info);
      },
    });

    const decision: OutboundDecision = {
      kind: "outbound_decision",
      decisionId: "dec-retain-1",
      op: OUTBOUND_OP,
      entityBindingRef: "sam@external",
      payload: {
        qitemId: "q-retain-1",
        notificationKey: "q-retain-1:1",
        ownerNotificationKind: "human-required",
        ownerNotificationLevel: "ALERT",
        humanIntent: "decision",
        destinationSession: "sam@external",
        relayConnectorRef: "wa-main",
        relayEnvelope: {
          v: 1,
          deliveryId: "dec-retain-1",
          recipient: { handle: "sam_wa" },
          intent: "decision",
          outcome: "interrupt",
          summary: "Check retention",
          body: "Body",
          replyRef: encodeRelayReplyRef({
            v: 1,
            qitemId: "q-retain-1",
            episodeKey: "q-retain-1:1",
            decisionRevision: "dr1-ret-1",
            decisionId: "dec-retain-1",
            connectorRef: "wa-main",
            mode: "park",
          }),
        } satisfies RelayOutboundEnvelope,
      },
    };

    const wire = buildInProcessWire({
      home,
      ops: [OUTBOUND_OP],
      deliver: (d) => transport.deliver(d),
    });

    // 1. Profile unready -> retained in buffer, zero HTTP calls
    wire.dispatcher.dispatch(OUTBOUND_OP, "sam@external", decision.payload, { decisionId: decision.decisionId });
    await tick();
    expect(bridge.callCount()).toBe(0);
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);

    // 2. Profile ready, but receipt write throws after HTTP 200 -> retained in buffer, not marked delivered
    profileReady = true;
    wire.startServices?.();
    await tick();
    expect(bridge.callCount()).toBe(1);
    expect(receipts).toHaveLength(0);
    expect(delivered.load().has("dec-retain-1")).toBe(false);
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);

    // 3. Strict SeenStore unreadable -> retained in buffer, no blind action
    fsx.failReadsFor.add("/state/relay-attempted-decisions.jsonl");
    const unreadableOutcome = await transport.deliver(decision);
    expect(unreadableOutcome.ok).toBe(false);
    expect(unreadableOutcome.class).toBe("relay-state-unreadable");
    fsx.failReadsFor.delete("/state/relay-attempted-decisions.jsonl");

    // 4. Receipt write succeeds on next replay -> receipt persisted, buffer drained
    failReceiptWrite = false;
    const w2 = buildInProcessWire({
      home,
      ops: [OUTBOUND_OP],
      deliver: (d) => transport.deliver(d),
    });
    w2.startServices?.();
    await tick();
    expect(receipts).toHaveLength(1);
    expect(delivered.load().has("dec-retain-1")).toBe(true);
    expect(new DispatchBuffer(home).pending()).toHaveLength(0);
  });

  it("repairs failed outboundSeen mark/release on retry using durable receipt without reposting or leaving poll guard inconsistent", async () => {
    const fsx = memFs();
    let failOutboundSeenAppend = true;
    const baseAppend = fsx.appendFileSync.bind(fsx);
    fsx.appendFileSync = (p, d) => {
      if (failOutboundSeenAppend && p === "/state/slack-outbound-seen.jsonl") {
        throw new Error("simulated disk error writing outbound-seen");
      }
      baseAppend(p, d);
    };

    const attempted = new SeenStore("/state/relay-attempted-decisions.jsonl", fsx);
    const delivered = new SeenStore("/state/relay-delivered-decisions.jsonl", fsx);
    const outboundSeen = new SeenStore("/state/slack-outbound-seen.jsonl", fsx);
    const bridge = recordingBridgeFixture();
    const acceptedKeys = new Set<string>();
    const releasedKeys: string[] = [];

    const transport = createRelayOutboundTransport({
      attempted,
      delivered,
      outboundSeen,
      fetchImpl: bridge.fetchImpl,
      resolveProfile: (connectorRef) => ({
        ok: true,
        connectorRef,
        url: "http://127.0.0.1:43110/outbound",
        outboundToken: "out-tok-valid-123456",
      }),
      hasAcceptedReceipt: ({ qitemId, notificationKey }) => acceptedKeys.has(`${qitemId}:${notificationKey}`),
      onAccepted: (info) => {
        acceptedKeys.add(`${info.qitemId}:${info.notificationKey}`);
      },
      release: (key) => {
        releasedKeys.push(key);
      },
    });

    const decision: OutboundDecision = {
      kind: "outbound_decision",
      decisionId: "dec-seen-repair-1",
      op: OUTBOUND_OP,
      entityBindingRef: "sam@external",
      payload: {
        qitemId: "q-seen-1",
        notificationKey: "q-seen-1:1",
        ownerNotificationKind: "human-required",
        ownerNotificationLevel: "ALERT",
        humanIntent: "decision",
        destinationSession: "sam@external",
        relayConnectorRef: "wa-main",
        relayEnvelope: {
          v: 1,
          deliveryId: "dec-seen-repair-1",
          recipient: { handle: "sam_wa" },
          intent: "decision",
          outcome: "interrupt",
          summary: "Check seen repair",
          body: "Body",
          replyRef: null,
        } satisfies RelayOutboundEnvelope,
      },
    };

    // Attempt 1: HTTP POST + onAccepted succeed, but outboundSeen.mark throws -> must NOT mark delivered or ack
    const first = await transport.deliver(decision);
    expect(first.ok).toBe(false);
    expect(bridge.callCount()).toBe(1);
    expect(acceptedKeys.has("q-seen-1:q-seen-1:1")).toBe(true);
    expect(outboundSeen.load().has("q-seen-1:1")).toBe(false);
    expect(delivered.load().has("dec-seen-repair-1")).toBe(false);
    expect(releasedKeys).toEqual([]);

    // Attempt 2: outboundSeen write repaired -> reconciles from durable receipt without a second HTTP POST
    failOutboundSeenAppend = false;
    const second = await transport.deliver(decision);
    expect(second.ok).toBe(true);
    expect(bridge.callCount(), "durable receipt reconciles metadata without repost").toBe(1);
    expect(outboundSeen.load().has("q-seen-1:1")).toBe(true);
    expect(delivered.load().has("dec-seen-repair-1")).toBe(true);
    expect(releasedKeys).toEqual(["q-seen-1:1"]);
  });

  describe("resolvePrimaryRelayBinding exact address requirements", () => {
    const reg = {
      ok: true as const,
      entities: [
        {
          entityId: "alice",
          class: "human" as const,
          displayName: "Alice",
          address: "alice@external",
          connectorBindings: [
            {
              kind: "relay" as const,
              connectorRef: "relay-alice",
              secretsRef: "file:/tmp/alice.env",
              role: "primary" as const,
              handle: "alice_relay",
            },
          ],
          prefs: { deliveryClass: "A" as const },
        },
        {
          entityId: "bob",
          class: "human" as const,
          displayName: "Bob",
          address: "bob@external",
          connectorBindings: [
            {
              kind: "relay" as const,
              connectorRef: "relay-bob",
              secretsRef: "file:/tmp/bob.env",
              role: "primary" as const,
            },
          ],
          prefs: { deliveryClass: "A" as const },
        },
      ],
    };

    it("resolves valid stable registered person's address exactly", () => {
      const resolved = resolvePrimaryRelayBinding("alice@external", reg);
      expect(resolved).toEqual({
        entity: reg.entities[0],
        connectorRef: "relay-alice",
        handle: "alice_relay",
        secretsRef: "file:/tmp/alice.env",
      });
    });

    it("allows exact bare entityId as fallback per existing caller contract", () => {
      const resolved = resolvePrimaryRelayBinding("alice", reg);
      expect(resolved).toEqual({
        entity: reg.entities[0],
        connectorRef: "relay-alice",
        handle: "alice_relay",
        secretsRef: "file:/tmp/alice.env",
      });
    });

    it("rejects different domain / same-name agent / different rig destination", () => {
      expect(resolvePrimaryRelayBinding("alice@different-rig", reg)).toBeNull();
      expect(resolvePrimaryRelayBinding("alice@some-rig", reg)).toBeNull();
      expect(resolvePrimaryRelayBinding("alice@externalx", reg)).toBeNull();
    });

    it("rejects shared channel ref with #", () => {
      expect(resolvePrimaryRelayBinding("alice#slack", reg)).toBeNull();
      expect(resolvePrimaryRelayBinding("alice#general", reg)).toBeNull();
    });

    it("leaves binding without handle as outbound-only fallback entityId per current contract", () => {
      const resolved = resolvePrimaryRelayBinding("bob@external", reg);
      expect(resolved).toEqual({
        entity: reg.entities[1],
        connectorRef: "relay-bob",
        handle: "bob",
        secretsRef: "file:/tmp/bob.env",
      });
    });
  });

  describe("R1-C Fix 3 — full long-text, multibyte CJK, emoji boundary, digest, and multi-part replay", () => {
    const reg = {
      ok: true as const,
      entities: [
        {
          entityId: "sam",
          class: "human" as const,
          displayName: "Sam",
          address: "sam@external",
          connectorBindings: [
            {
              kind: "relay" as const,
              connectorRef: "wa-main",
              secretsRef: "file:/tmp/wa.env",
              role: "primary" as const,
              handle: "sam_wa",
            },
          ],
          prefs: { deliveryClass: "A" as const, availability: "available" as const },
        },
      ],
    };

    it("renders and splits full ASCII, multibyte CJK, emoji, humanDetail, and humanQuestions/options without silent clipping or surrogate corruption", () => {
      const asciiBlock = "ASCII-LINE-0123456789-abcdefghijklmnopqrstuvwxyz\n".repeat(900) + "ASCII-TAIL-MARKER";
      const cjkBlock = "日本語と中国語と한국어の長文テスト検証データ".repeat(1400) + "CJK-TAIL-終端";
      const emojiBlock = "🚀👩‍💻🎉🔥🧪".repeat(1200) + "EMOJI-TAIL-🏁";
      const detailBlock = "DETAIL-SECTION-" + "D".repeat(12_000) + "-DETAIL-TAIL";

      const prepared = prepareRelayDecision(
        {
          kind: "outbound_decision",
          decisionId: "dec-long-cjk-1",
          op: OUTBOUND_OP,
          entityBindingRef: "sam@external",
          payload: {
            qitemId: "q-long-1",
            notificationKey: "q-long-1:1",
            ownerNotificationKind: "human-required",
            ownerNotificationLevel: "ALERT",
            humanIntent: "decision",
            destinationSession: "sam@external",
            state: "blocked",
            summary: "S".repeat(1200) + "-SUMMARY-TAIL",
            body: `${asciiBlock}\n${cjkBlock}\n${emojiBlock}`,
            humanDetail: detailBlock,
            humanQuestions: [
              {
                id: "q-rollout",
                header: "Deployment Gate",
                question: "Which rollout strategy should we execute for the multi-region cluster?",
                options: [
                  {
                    id: "canary",
                    label: "Canary 5%",
                    description: "Roll out to 5% of edge nodes first and monitor p99 latency for 30m",
                    recommended: true,
                  },
                  {
                    id: "blue-green",
                    label: "Blue/Green Cutover",
                    description: "Switch full traffic to green standby with instant DNS rollback",
                  },
                ],
              },
            ],
          } satisfies OutboundPostPayload,
        },
        {
          loadHumanRegistry: () => reg,
          lookupQuestionState: () => ({
            qitemId: "q-long-1",
            mode: "park",
            episodeKey: "q-long-1:1",
            decisionRevision: "dr1-long-1",
            humanIntent: "decision",
          }),
        },
      );

      const carry = prepared.payload as RelayPayloadCarry;
      const fullEnvelope = carry.relayEnvelope!;
      expect(fullEnvelope).toBeDefined();
      expect(fullEnvelope.body).toContain("SUMMARY-TAIL");
      expect(fullEnvelope.body).toContain("ASCII-TAIL-MARKER");
      expect(fullEnvelope.body).toContain("CJK-TAIL-終端");
      expect(fullEnvelope.body).toContain("EMOJI-TAIL-🏁");
      expect(fullEnvelope.body).toContain("DETAIL-TAIL");
      expect(fullEnvelope.body).toContain("Deployment Gate");
      expect(fullEnvelope.body).toContain("Which rollout strategy should we execute for the multi-region cluster?");
      expect(fullEnvelope.body).toContain("Canary 5% (recommended)");
      expect(fullEnvelope.body).toContain("Roll out to 5% of edge nodes first and monitor p99 latency for 30m");
      expect(fullEnvelope.body).toContain("Blue/Green Cutover");
      expect(fullEnvelope.body).toContain("Switch full traffic to green standby with instant DNS rollback");

      const parts = carry.relayEnvelopes ?? splitRelayOutboundEnvelope(fullEnvelope);
      expect(parts.length).toBeGreaterThan(2);

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const raw = JSON.stringify(part);
        expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(RELAY_ENVELOPE_MAX_BYTES);
        expect(part.deliveryId).toBe(`dec-long-cjk-1:part:${i + 1}`);
        expect(part.part).toEqual({
          parentDeliveryId: "dec-long-cjk-1",
          index: i + 1,
          total: parts.length,
        });
        expect(part.replyRef).toBe(fullEnvelope.replyRef);
        // Verify no unpaired UTF-16 surrogates in any part
        expect(part.body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      }

      const reassembled = reassembleRelayEnvelopeParts(parts);
      expect(reassembled).toEqual(fullEnvelope);
    });

    it("replays failed/ACK-lost middle part across bridge and transport restart with stable part identities/bytes and commits custody only after all parts succeed", async () => {
      const fsx = memFs();
      const relayDir = mkdtempSync(join(tmpdir(), "openrig-relay-mp-"));
      const relay = await startRecordingRelay({
        custodyFilePath: join(relayDir, "bridge-state.jsonl"),
        outboundToken: "out-tok-valid-123456",
        inboundToken: "in-tok-valid-654321",
      });

      try {
        const attempted = new SeenStore("/state/relay-attempted-decisions.jsonl", fsx);
        const delivered = new SeenStore("/state/relay-delivered-decisions.jsonl", fsx);
        const outboundSeen = new SeenStore("/state/slack-outbound-seen.jsonl", fsx);
        const receipts: RelayAcceptedReceiptInfo[] = [];
        const releasedKeys: string[] = [];

        const cjkBody =
          "第一段内容：多字节UTF-8编码边界与分片恢复测试。".repeat(950) +
          "\nMIDDLE-MARKER-中間標記\n" +
          "第二段内容：确保在中间分片丢失ACK后重启不会丢失尾部也不会重复接管。".repeat(950) +
          "\nFINAL-TAIL-MARKER-最終尾部";

        const prepared = prepareRelayDecision(
          {
            kind: "outbound_decision",
            decisionId: "dec-mp-ack-lost-1",
            op: OUTBOUND_OP,
            entityBindingRef: "sam@external",
            payload: {
              qitemId: "q-mp-1",
              notificationKey: "q-mp-1:1",
              ownerNotificationKind: "human-required",
              ownerNotificationLevel: "ALERT",
              humanIntent: "decision",
              destinationSession: "sam@external",
              state: "blocked",
              summary: "Multi-part lost ACK test",
              body: cjkBody,
            } satisfies OutboundPostPayload,
          },
          {
            loadHumanRegistry: () => reg,
            lookupQuestionState: () => ({
              qitemId: "q-mp-1",
              mode: "park",
              episodeKey: "q-mp-1:1",
              decisionRevision: "dr1-mp-1",
              humanIntent: "decision",
            }),
          },
        );

        const expectedParts = (prepared.payload as RelayPayloadCarry).relayEnvelopes!;
        expect(expectedParts).toBeDefined();
        expect(expectedParts.length).toBe(3);

        // Fail HTTP ACK on the 2nd part (index 2 of 3) AFTER the bridge persists custody for part 2
        let outboundCallIndex = 0;
        const realFetch: typeof fetch = async (url, init) => {
          outboundCallIndex += 1;
          if (outboundCallIndex === 2) {
            relay.setLoseNextAck(true);
          }
          return fetch(url, init);
        };

        const transport1 = createRelayOutboundTransport({
          attempted,
          delivered,
          outboundSeen,
          fetchImpl: realFetch,
          resolveProfile: (connectorRef) => ({
            ok: true,
            connectorRef,
            url: relay.outboundUrl,
            outboundToken: "out-tok-valid-123456",
          }),
          onAccepted: (info) => receipts.push(info),
          release: (key) => releasedKeys.push(key),
        });

        const wire1 = buildInProcessWire({
          home,
          ops: [OUTBOUND_OP],
          deliver: (d) => transport1.deliver(d),
        });

        wire1.dispatcher.dispatch(OUTBOUND_OP, "sam@external", prepared.payload, {
          decisionId: "dec-mp-ack-lost-1",
        });
        for (let i = 0; i < 40 && relay.getSanitizedStats().lostAckCount === 0; i++) {
          await tick();
        }
        await tick();

        // Part 1 succeeded (200), Part 2 committed custody on bridge then returned 502 (lost ACK), Part 3 not sent yet.
        expect(relay.getSanitizedStats().custodyCount).toBe(2);
        expect(receipts, "logical custody receipt must NOT fire before all parts succeed").toHaveLength(0);
        expect(outboundSeen.load().has("q-mp-1:1")).toBe(false);
        expect(delivered.load().has("dec-mp-ack-lost-1")).toBe(false);
        expect(releasedKeys).toEqual([]);
        expect(new DispatchBuffer(home).pending()).toHaveLength(1);

        // Pending replyRef lookup still correlates parent decisionId while buffered
        const parentReplyRef = (prepared.payload as RelayPayloadCarry).relayEnvelope!.replyRef!;
        const pendingRef = findPendingRelayReplyRef(home, parentReplyRef);
        expect(pendingRef.found).toBe(true);
        expect(pendingRef.decisionId).toBe("dec-mp-ack-lost-1");

        // Restart the recording relay server (reloads persisted custody from disk) and create fresh transport/wire
        await relay.restart();

        const transport2 = createRelayOutboundTransport({
          attempted,
          delivered,
          outboundSeen,
          fetchImpl: fetch,
          resolveProfile: (connectorRef) => ({
            ok: true,
            connectorRef,
            url: relay.outboundUrl,
            outboundToken: "out-tok-valid-123456",
          }),
          onAccepted: (info) => receipts.push(info),
          release: (key) => releasedKeys.push(key),
        });

        const wire2 = buildInProcessWire({
          home,
          ops: [OUTBOUND_OP],
          deliver: (d) => transport2.deliver(d),
        });
        wire2.startServices?.();
        for (let i = 0; i < 40 && receipts.length === 0; i++) {
          await tick();
        }
        await tick();

        // Part 1 was skipped (already delivered locally), Part 2 replayed with identical deliveryId/bytes (deduplicated), Part 3 delivered fresh!
        expect(relay.getSanitizedStats().custodyCount, "exactly 3 unique part deliveries in bridge custody").toBe(3);
        expect(relay.getSanitizedStats().deduplicatedCount, "middle part replay deduplicated by bridge without conflict").toBe(1);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.deliveryId).toBe("dec-mp-ack-lost-1");
        expect(outboundSeen.load().has("q-mp-1:1")).toBe(true);
        expect(delivered.load().has("dec-mp-ack-lost-1")).toBe(true);
        expect(releasedKeys).toEqual(["q-mp-1:1"]);
        expect(new DispatchBuffer(home).pending()).toHaveLength(0);

        const committedEnvelopes = relay.getCustodyRecords().map((d) => d.envelope);
        const reassembled = reassembleRelayEnvelopeParts(committedEnvelopes);
        expect(relay.getReassembledDeliveries()).toEqual([reassembled]);
        expect(reassembled.body).toBe(cjkBody);
        expect(reassembled.body).toContain("MIDDLE-MARKER-中間標記");
        expect(reassembled.body).toContain("FINAL-TAIL-MARKER-最終尾部");
      } finally {
        await relay.stop();
        rmSync(relayDir, { recursive: true, force: true });
      }
    });

    it("splits and delivers oversized multi-item digests with full item content and records all member receipts only on complete acceptance", async () => {
      const fsx = memFs();
      const attempted = new SeenStore("/state/relay-attempted-decisions.jsonl", fsx);
      const delivered = new SeenStore("/state/relay-delivered-decisions.jsonl", fsx);
      const outboundSeen = new SeenStore("/state/slack-outbound-seen.jsonl", fsx);
      const bridge = recordingBridgeFixture();
      const receipts: RelayAcceptedReceiptInfo[] = [];

      const item1Body = "DIGEST-ITEM-1-" + "甲乙丙丁戊己庚辛壬癸".repeat(2500) + "-ITEM-1-TAIL";
      const item2Body = "DIGEST-ITEM-2-" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(1600) + "-ITEM-2-TAIL";

      const prepared = prepareRelayDecision(
        {
          kind: "outbound_decision",
          decisionId: "dec-digest-long-1",
          op: OUTBOUND_OP,
          entityBindingRef: "sam@external",
          payload: {
            deliveryDigestPost: true,
            digestId: "long-1",
            qitemId: "q-dig-1",
            notificationKey: "digest:sam@external:long",
            ownerNotificationKind: "human-required",
            ownerNotificationLevel: "INFO",
            humanIntent: "update",
            destinationSession: "sam@external",
            summary: "Digest summary header",
            body: `${item1Body}\n\n${item2Body}`,
            memberReceipts: [
              {
                qitemId: "q-dig-1",
                notificationKey: "q-dig-1:1",
                level: "ALERT",
                kind: "human-required",
                summary: "Item 1 summary",
                body: item1Body,
              },
              {
                qitemId: "q-dig-2",
                notificationKey: "q-dig-2:1",
                level: "ALERT",
                kind: "human-required",
                summary: "Item 2 summary",
                body: item2Body,
              },
            ],
          } as OutboundPostPayload,
        },
        {
          loadHumanRegistry: () => reg,
          lookupQuestionState: (qitemId) => ({
            qitemId,
            mode: "ask",
            episodeKey: `${qitemId}:1`,
            decisionRevision: `dr1-${qitemId}`,
            humanIntent: "decision",
            summary: qitemId === "q-dig-1" ? "Item 1 summary" : "Item 2 summary",
            body: qitemId === "q-dig-1" ? item1Body : item2Body,
          }),
        },
      );

      const parts = (prepared.payload as RelayPayloadCarry).relayEnvelopes!;
      expect(parts).toBeDefined();
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(Buffer.byteLength(JSON.stringify(part), "utf8")).toBeLessThanOrEqual(RELAY_ENVELOPE_MAX_BYTES);
      }

      const transport = createRelayOutboundTransport({
        attempted,
        delivered,
        outboundSeen,
        fetchImpl: bridge.fetchImpl,
        resolveProfile: (connectorRef) => ({
          ok: true,
          connectorRef,
          url: "http://127.0.0.1:43110/outbound",
          outboundToken: "out-tok-valid-123456",
        }),
        onAccepted: (info) => receipts.push(info),
      });

      const outcome = await transport.deliver({
        kind: "outbound_decision",
        decisionId: "dec-digest-long-1",
        op: OUTBOUND_OP,
        entityBindingRef: "sam@external",
        payload: prepared.payload,
      });

      expect(outcome.ok).toBe(true);
      expect(bridge.custodyByDeliveryId.size).toBe(parts.length);
      expect(receipts.map((r) => `${r.qitemId}:${r.notificationKey}`)).toEqual([
        "q-dig-1:q-dig-1:1",
        "q-dig-2:q-dig-2:1",
      ]);

      const reassembled = reassembleRelayEnvelopeParts(Array.from(bridge.custodyByDeliveryId.values()));
      expect(reassembled.body).toContain("ITEM-1-TAIL");
      expect(reassembled.body).toContain("ITEM-2-TAIL");
      expect(reassembled.items).toHaveLength(2);
      expect(reassembled.items?.[0]?.body).toContain("ITEM-1-TAIL");
      expect(reassembled.items?.[1]?.body).toContain("ITEM-2-TAIL");
      const ref1 = decodeRelayReplyRef(reassembled.items?.[0]?.replyRef ?? "");
      const ref2 = decodeRelayReplyRef(reassembled.items?.[1]?.replyRef ?? "");
      expect(ref1.ok && ref1.ref.qitemId).toBe("q-dig-1");
      expect(ref2.ok && ref2.ref.qitemId).toBe("q-dig-2");
    });

    it("distinguishes stopSignal abort from genuine timeout: in-flight stop suppresses failure ledger, retains pending decision and part ACKs, replays stable IDs/bytes on restart, while genuine timeout still records failure", async () => {
      const fsx = memFs();
      const attempted = new SeenStore("/state/relay-attempted-decisions.jsonl", fsx);
      const delivered = new SeenStore("/state/relay-delivered-decisions.jsonl", fsx);
      const outboundSeen = new SeenStore("/state/slack-outbound-seen.jsonl", fsx);
      const bridge = recordingBridgeFixture();
      const receipts: RelayAcceptedReceiptInfo[] = [];
      const failures: Array<{ failureClass: string; detail: string }> = [];

      const longBody = "STOP-RESUME-BLOCK-".repeat(4500) + "\nSTOP-RESUME-TAIL";
      const prepared = prepareRelayDecision(
        {
          kind: "outbound_decision",
          decisionId: "dec-stop-mp-1",
          op: OUTBOUND_OP,
          entityBindingRef: "sam@external",
          payload: {
            qitemId: "q-stop-1",
            notificationKey: "q-stop-1:1",
            ownerNotificationKind: "human-required",
            ownerNotificationLevel: "ALERT",
            humanIntent: "decision",
            destinationSession: "sam@external",
            state: "blocked",
            summary: "Stop during in-flight multi-part send",
            body: longBody,
          } satisfies OutboundPostPayload,
        },
        {
          loadHumanRegistry: () => reg,
          lookupQuestionState: () => ({
            qitemId: "q-stop-1",
            mode: "park",
            episodeKey: "q-stop-1:1",
            decisionRevision: "dr1-stop-1",
            humanIntent: "decision",
          }),
        },
      );

      const expectedParts = (prepared.payload as RelayPayloadCarry).relayEnvelopes!;
      expect(expectedParts.length).toBe(2);

      const stopCtl1 = new AbortController();
      let postCalls = 0;
      const stopOnSecondPartFetch = async (url: string, init?: RequestInit): Promise<Response> => {
        postCalls += 1;
        if (postCalls === 1) {
          return bridge.fetchImpl(url, init);
        }
        return await new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal;
          const onAbort = () => {
            reject(sig?.reason ?? new DOMException("The operation was aborted", "AbortError"));
          };
          if (sig?.aborted) {
            onAbort();
            return;
          }
          sig?.addEventListener("abort", onAbort, { once: true });
          // Simulate subsystem stop while Part 2 HTTP POST is in flight
          queueMicrotask(() => stopCtl1.abort(new Error("subsystem stop requested")));
        });
      };

      const transport1 = createRelayOutboundTransport({
        attempted,
        delivered,
        outboundSeen,
        fetchImpl: stopOnSecondPartFetch,
        stopSignal: stopCtl1.signal,
        resolveProfile: (connectorRef) => ({
          ok: true,
          connectorRef,
          url: "http://127.0.0.1:43110/outbound",
          outboundToken: "out-tok-valid-123456",
        }),
        onAccepted: (info) => receipts.push(info),
        onTransportFailed: (_p, failureClass, detail) => failures.push({ failureClass, detail }),
      });

      const wire1 = buildInProcessWire({
        home,
        ops: [OUTBOUND_OP],
        deliver: (d) => transport1.deliver(d),
      });

      wire1.dispatcher.dispatch(OUTBOUND_OP, "sam@external", prepared.payload, {
        decisionId: "dec-stop-mp-1",
      });
      await tick();

      // Part 1 succeeded and was recorded; Part 2 was aborted by stopSignal -> NO failure ledger entry, NO acceptance, decision retained
      expect(bridge.custodyByDeliveryId.size).toBe(1);
      expect(delivered.load().has("dec-stop-mp-1:part:1")).toBe(true);
      expect(delivered.load().has("dec-stop-mp-1:part:2")).toBe(false);
      expect(delivered.load().has("dec-stop-mp-1")).toBe(false);
      expect(failures, "stopSignal abort must not record transport failure").toEqual([]);
      expect(receipts, "stopSignal abort must not record false acceptance").toEqual([]);
      expect(new DispatchBuffer(home).pending()).toHaveLength(1);

      // Pre-aborted stopSignal also returns stopped without calling fetch or recording failure
      const callsBeforePreAborted = postCalls;
      const preAbortedOutcome = await transport1.deliver({
        kind: "outbound_decision",
        decisionId: "dec-stop-mp-1",
        op: OUTBOUND_OP,
        entityBindingRef: "sam@external",
        payload: prepared.payload,
      });
      expect(preAbortedOutcome).toEqual({
        ok: false,
        class: "stopped",
        detail: "relay transport stopped",
      });
      expect(postCalls).toBe(callsBeforePreAborted);
      expect(failures).toEqual([]);

      // Restart with a fresh transport/wire: Part 1 is skipped, Part 2 is sent with identical frozen ID/bytes, custody completes
      const stopCtl2 = new AbortController();
      const transport2 = createRelayOutboundTransport({
        attempted,
        delivered,
        outboundSeen,
        fetchImpl: bridge.fetchImpl,
        stopSignal: stopCtl2.signal,
        resolveProfile: (connectorRef) => ({
          ok: true,
          connectorRef,
          url: "http://127.0.0.1:43110/outbound",
          outboundToken: "out-tok-valid-123456",
        }),
        onAccepted: (info) => receipts.push(info),
        onTransportFailed: (_p, failureClass, detail) => failures.push({ failureClass, detail }),
      });

      const wire2 = buildInProcessWire({
        home,
        ops: [OUTBOUND_OP],
        deliver: (d) => transport2.deliver(d),
      });
      wire2.startServices?.();
      await tick();

      expect(bridge.callCount(), "Part 1 posted once before stop + Part 2 posted once on replay").toBe(2);
      expect(bridge.custodyByDeliveryId.size).toBe(2);
      expect(bridge.attempts[0]!.envelope.deliveryId).toBe("dec-stop-mp-1:part:1");
      expect(bridge.attempts[1]!.envelope.deliveryId).toBe("dec-stop-mp-1:part:2");
      expect(bridge.attempts[1]!.envelope).toEqual(expectedParts[1]);
      expect(receipts).toHaveLength(1);
      expect(failures).toEqual([]);
      expect(delivered.load().has("dec-stop-mp-1")).toBe(true);
      expect(new DispatchBuffer(home).pending()).toHaveLength(0);

      // Genuine timeout (when stopSignal is NOT aborted) still reports class "timeout" and invokes onTransportFailed
      const hangingFetch = async (_url: string, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal;
          sig?.addEventListener(
            "abort",
            () => reject(sig.reason ?? new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          );
        });

      const timeoutTransport = createRelayOutboundTransport({
        attempted,
        delivered,
        outboundSeen,
        fetchImpl: hangingFetch,
        timeoutMs: 20,
        stopSignal: stopCtl2.signal,
        resolveProfile: (connectorRef) => ({
          ok: true,
          connectorRef,
          url: "http://127.0.0.1:43110/outbound",
          outboundToken: "out-tok-valid-123456",
        }),
        onAccepted: (info) => receipts.push(info),
        onTransportFailed: (_p, failureClass, detail) => failures.push({ failureClass, detail }),
      });

      const timeoutOutcome = await timeoutTransport.deliver({
        kind: "outbound_decision",
        decisionId: "dec-genuine-timeout-1",
        op: OUTBOUND_OP,
        entityBindingRef: "sam@external",
        payload: {
          qitemId: "q-timeout-1",
          notificationKey: "q-timeout-1:1",
          ownerNotificationKind: "human-required",
          ownerNotificationLevel: "ALERT",
          humanIntent: "decision",
          destinationSession: "sam@external",
          relayConnectorRef: "wa-main",
          relayEnvelope: {
            v: 1,
            deliveryId: "dec-genuine-timeout-1",
            recipient: { handle: "sam_wa" },
            intent: "decision",
            outcome: "interrupt",
            summary: "Timeout test",
            body: "Body",
            replyRef: null,
          },
        },
      });

      expect(timeoutOutcome).toEqual({
        ok: false,
        class: "timeout",
        detail: "relay request timed out after 20ms",
      });
      expect(failures).toEqual([
        {
          failureClass: "timeout",
          detail: "relay request timed out after 20ms",
        },
      ]);
    });
  });
});
