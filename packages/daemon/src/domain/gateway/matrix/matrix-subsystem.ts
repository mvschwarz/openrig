import { createHash } from "node:crypto";
import path from "node:path";
import type { QueueRepository } from "../../queue-repository.js";
import { buildInProcessWire, type GatewayWire } from "../gateway-subsystem.js";
import { loadHumanRegistry, type HumanFragment } from "../human-registry.js";
import { makeQueuePorts } from "../slack/queue-access.js";
import { SeenStore } from "../slack/state-store.js";
import { DispatchBuffer } from "../dispatch-buffer.js";
import { loadConfig } from "./config.js";
import { resolveAccessToken } from "./secrets.js";
import { MatrixClient, type FetchImpl } from "./matrix-api.js";
import { MatrixInbound } from "./inbound.js";
import { MatrixOutboundDriver } from "./outbound-driver.js";
import { ThreadSeatMap } from "./thread-seat-map.js";
import { OUTBOUND_OP } from "./capabilities.js";

export function primaryMatrixBinding(human: HumanFragment) {
  return human.connectorBindings.find((b) => b.role === "primary" && b.kind === "matrix");
}
type MatrixWireOpts = {
  home: string; queueRepo: QueueRepository; fetchImpl?: FetchImpl; intervalMs?: number;
  resolveHumanReply?: ConstructorParameters<typeof MatrixInbound>[0]["resolveHumanReply"];
  log?: (message: string) => void;
};
export function buildMatrixGatewayWire(opts: MatrixWireOpts): GatewayWire {
  try { return buildConfiguredMatrixWire(opts); }
  catch (error) {
    // A malformed Matrix config must not disable the existing Slack wire.
    const wire = buildInProcessWire({ home: opts.home, connectorId: "matrix-subsystem", platform: "matrix", ops: [],
      acceptsDecision: () => false, deliver: async () => ({ ok: false, class: "matrix-configuration-failed" }) });
    opts.log?.("matrix configuration failed; check rig matrix status");
    return { ...wire, status: () => ({ platform: "matrix", configured: false, outboundReady: false, inboundReady: false,
      inbound: { state: "failed", error: (error as Error).message } }) };
  }
}
function buildConfiguredMatrixWire(opts: MatrixWireOpts): GatewayWire {
  const cfg = loadConfig(opts.home);
  const token = resolveAccessToken({ envFile: cfg.secretsEnvFile });
  const ready = cfg.enabled && !!token && !!cfg.homeserverUrl;
  const accepts = (ref: string) => {
    if (ref.startsWith("matrix:")) return true;
    const registry = loadHumanRegistry(opts.home);
    return registry.ok && registry.entities.some((h) => (h.address === ref || h.entityId === ref) && primaryMatrixBinding(h));
  };
  const signal = new AbortController();
  let inbound: MatrixInbound | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let live = false;
  let syncEstablished = false;
  const seen = new SeenStore(path.join(opts.home, "state", "matrix-outbound-seen.jsonl"));
  const map = new ThreadSeatMap(opts.home);
  const ports = makeQueuePorts(opts.queueRepo, { loadHumanRegistry: () => loadHumanRegistry(opts.home), connectorKind: "matrix" });
  const client = ready ? new MatrixClient({ homeserverUrl: cfg.homeserverUrl!, accessToken: token!, deviceId: cfg.deviceId ?? undefined }, { fetchImpl: opts.fetchImpl }) : undefined;
  const rooms = new Map<string, string>();
  const resolvingRooms = new Map<string, Promise<string>>();
  const checkRoom = async (roomId: string): Promise<string> => {
    const state = await client!.getRoomState(roomId, signal.signal);
    if (state.some((event) => event.type === "m.room.encryption")) throw new Error("Matrix encrypted rooms are unsupported; use an unencrypted bot room");
    return roomId;
  };
  const joinRoom = async (room: string): Promise<string> => {
    const cached = rooms.get(room);
    if (cached) return cached;
    const joined = await client!.joinRoom(room, signal.signal);
    if (!joined.room_id) throw new Error("Matrix join response is missing room_id");
    await checkRoom(joined.room_id);
    rooms.set(room, joined.room_id);
    return joined.room_id;
  };
  const resolveRoom = (room: string): Promise<string> => {
    const cached = rooms.get(room);
    if (cached) return checkRoom(cached); // Encryption can be enabled after the initial join.
    const pending = resolvingRooms.get(room);
    if (pending) return pending;
    const task = joinRoom(room).finally(() => resolvingRooms.delete(room));
    resolvingRooms.set(room, task);
    return task;
  };
  const sender = (senderId: string, roomId: string): string | null => {
    const registry = loadHumanRegistry(opts.home);
    if (!registry.ok) return null;
    return registry.entities.find((h) => h.connectorBindings.some((b) => b.kind === "matrix" && b.handle === senderId
      && (rooms.get(b.connectorRef) ?? b.connectorRef) === roomId))?.address ?? null;
  };
  const outbound = client ? new MatrixOutboundDriver({
    home: opts.home, client, map, signal: signal.signal,
    shouldDeliver: (payload) => {
      // Check inside the driver's serial delivery lane: replay and the sweep
      // may enqueue the same episode before the first post writes its receipt.
      const key = payload.notificationKey ?? payload.qitemId;
      if (payload.qitemId) {
        const row = opts.queueRepo.getById(payload.qitemId);
        if (opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(payload.qitemId, key)
          || (row && !["pending", "in-progress", "blocked"].includes(row.state) && payload.ownerNotificationKind !== "human-decision-resolved")) {
          seen.mark(key, "already-delivered-or-closed");
          return false;
        }
      }
      return true;
    },
    roomFor: async (ref) => {
      const registry = loadHumanRegistry(opts.home);
      const human = registry.ok ? registry.entities.find((h) => h.address === ref || h.entityId === ref) : undefined;
      const room = human ? primaryMatrixBinding(human)?.connectorRef : ref.startsWith("matrix:") ? ref.slice(7) : cfg.defaultRoom;
      if (!room) throw new Error("Matrix destination room is not configured");
      return resolveRoom(room);
    },
    onDelivered: (payload, root, roomId) => {
      const key = payload.notificationKey ?? payload.qitemId;
      if (payload.qitemId && opts.queueRepo.getById(payload.qitemId) && !opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(payload.qitemId, key)) {
        opts.queueRepo.update({ qitemId: payload.qitemId, actorSession: "daemon@kernel",
          ...(payload.humanIntent === "update" ? { state: "done" as const, closureReason: "no-follow-on" } : {}),
          transitionNote: `matrix-owner-notification-posted notification_key=${key} room_id=${roomId} thread_root=${root}` });
      }
      seen.mark(key, "delivered");
    },
  }) : undefined;
  const wire = buildInProcessWire({
    home: opts.home, connectorId: "matrix-subsystem", platform: "matrix", ops: ready ? [OUTBOUND_OP] : [], acceptsDecision: accepts,
    deliver: outbound ? async (decision) => {
      const payload = decision.payload as import("./outbound-driver.js").MatrixPostPayload;
      const key = payload?.notificationKey ?? payload?.qitemId;
      try { return await outbound.deliver(decision); }
      catch (error) {
        if (payload?.qitemId && opts.queueRepo.getById(payload.qitemId)) {
          const note = `matrix-owner-notification-transport-failed notification_key=${key} class=matrix-api`;
          if (!opts.queueRepo.transitionLog.listForQitem(payload.qitemId).some((t) => t.transitionNote === note)) {
            opts.queueRepo.update({ qitemId: payload.qitemId, actorSession: "daemon@kernel", transitionNote: note });
          }
        }
        // The dispatcher keeps this decision until a later sweep replays it.
        return { ok: false, class: "matrix-delivery-failed", detail: (error as Error).message };
      }
    } : async () => ({ ok: false, class: "matrix-not-configured" }), log: opts.log,
  });
  let sweeping = false;
  const sweep = async () => {
    if (sweeping || signal.signal.aborted) return;
    sweeping = true;
    try {
      wire.dispatcher.replayPending();
      for (const alert of await ports.listHumanAlerts({ minimumLevel: "NOTICE" })) {
        const key = alert.notificationKey ?? alert.qitemId;
        if (seen.load().has(key) || signal.signal.aborted) continue;
        // Episode-stable identity + Matrix transaction IDs absorb poll/replay races.
        wire.dispatcher.dispatch(OUTBOUND_OP, alert.destinationSession!, alert, {
          decisionId: `matrix-${createHash("sha256").update(key).digest("hex")}`,
        });
      }
    } catch (error) { opts.log?.(`matrix outbound sweep failed: ${(error as Error).message}`); }
    finally { sweeping = false; }
  };
  if (client) inbound = new MatrixInbound({
    home: opts.home, client, map, queue: ports, destination: cfg.inboundDestination, resolveSender: sender,
    onSync: () => { if (!syncEstablished) { syncEstablished = true; void sweep(); } },
    recordHumanAnswer: (input) => opts.queueRepo.recordHumanAnswer(input), resolveHumanReply: opts.resolveHumanReply,
    prepareRooms: async () => {
      const registry = loadHumanRegistry(opts.home);
      if (!registry.ok) throw new Error(registry.error);
      const targets = new Set(registry.entities.flatMap((h) => h.connectorBindings.filter((b) => b.kind === "matrix").map((b) => b.connectorRef)));
      if (cfg.defaultRoom) targets.add(cfg.defaultRoom);
      for (const room of targets) await resolveRoom(room);
    }, log: opts.log,
  });
  return {
    dispatcher: wire.dispatcher,
    startServices: () => {
      if (live || !ready) return;
      live = true;
      inbound?.start();
      timer = setInterval(() => { if (syncEstablished) void sweep(); }, opts.intervalMs ?? 30000);
      timer.unref();
    },
    stop: () => { signal.abort(); if (timer) clearInterval(timer); void inbound?.stop(); wire.stop(); },
    status: () => ({ platform: "matrix", configured: !!token && !!cfg.homeserverUrl, enabled: cfg.enabled,
      outboundReady: ready && !signal.signal.aborted, inboundReady: inbound?.status().state === "connected", inbound: inbound?.status() ?? { state: "not-configured" },
      pendingDispatches: new DispatchBuffer(opts.home).pending().filter((d) => accepts(d.entityBindingRef)).length }),
  };
}
