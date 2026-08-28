// S10 — the SLACK gateway wiring: composes the in-process wire (shipped dispatcher + durable
// buffer), the chat.postMessage delivery path, the outbound queue-poll driver, and the Socket
// Mode inbound service into ONE GatewayWire the subsystem activates at daemon boot.
//
// Configuration honesty: an unconfigured/disabled connector yields an INERT wire — delivery
// refuses with a named class, no ops advertised, no drivers started — never a throw (boot
// proceeds; `rig slack status` names what is missing) and never a silent pretend-active
// delivery path.
//
// Durable-state continuity through the cutover: the SAME slice-11 state files carry over
// (slack-outbound-seen.jsonl, slack-inbound-seen.jsonl, slack-inbound-deadletter.jsonl), so
// the relay's history IS the subsystem's history — enabling the subsystem replays nothing the
// relay already delivered (the enable-time backlog rule survives the cutover by construction).

import path from "node:path";
import { buildInProcessWire, type GatewayWire } from "../gateway-subsystem.js";
import { loadConfig } from "./config.js";
import { resolveSecret } from "./secrets.js";
import { SeenStore, DeadLetterStore } from "./state-store.js";
import { makeQueuePorts } from "./queue-access.js";
import { SlackOutboundDriver, OUTBOUND_OP } from "./outbound-driver.js";
import { subsystemSlackDeliver } from "./slack-delivery.js";
import { InboundRouter, type SlackEvent } from "./inbound.js";
import { makeInboundSenderResolver, type RegistrySurface } from "./inbound-admission.js";
import { ThreadSeatMap, formatPostedStamp } from "./thread-seat-map.js";
import { makeThreadRouteResolver } from "./thread-routing.js";
import { startSocketInbound, type SocketInboundHandle, type WsLike } from "./socket-inbound.js";
import { loadHumanRegistry, resolveSlackHandle } from "../human-registry.js";
import type { QueueRepository } from "../../queue-repository.js";
import type { FetchImpl } from "./slack-api.js";
import { ownerNotificationLevelAtLeast } from "../../queue-transition-log.js";

const SECRET_BOT = "SLACK_BOT_TOKEN";
const SECRET_APP = "SLACK_APP_TOKEN";

export interface SlackWireOpts {
  home: string;
  queueRepo: QueueRepository;
  log?: (msg: string) => void;
  /** Injectable seams (tests): fetch, websocket factory, sweep cadence, registry surface. */
  fetchImpl?: FetchImpl;
  wsFactory?: (url: string) => WsLike;
  outboundIntervalMs?: number;
  inboundRetryIntervalMs?: number;
  inboundMaxConnects?: number;
  registry?: RegistrySurface;
}

function stateDir(home: string): string {
  return path.join(home, "state");
}

/** Build the production Slack gateway wire from config + secrets. Never throws on a missing
 *  configuration — that is an honest inert wire, not a boot failure. */
export function buildSlackGatewayWire(opts: SlackWireOpts): GatewayWire {
  const log = opts.log ?? (() => {});
  const cfg = loadConfig(opts.home);
  const envFile = cfg.secretsEnvFile ?? undefined;
  const bot = resolveSecret(SECRET_BOT, { envFile });
  const app = resolveSecret(SECRET_APP, { envFile });

  const outboundReady = cfg.enabled && bot !== null && cfg.channel !== null;
  const inboundReady = cfg.enabled && app !== null;

  if (!outboundReady && !inboundReady) {
    const missing = !cfg.enabled ? "connector disabled (rig slack enable)" : !bot ? "SLACK_BOT_TOKEN unresolved" : "channel unconfigured";
    log(`slack delivery not configured (${missing}) — wire is inert; dispatches would be refused honestly`);
    return buildInProcessWire({
      home: opts.home,
      ops: [],
      deliver: async () => ({ ok: false, class: "slack-not-configured", detail: missing }),
      log,
    });
  }

  const registrySurface: RegistrySurface = opts.registry ?? { loadHumanRegistry, resolveSlackHandle };
  const ports = makeQueuePorts(opts.queueRepo, {
    loadHumanRegistry: () => registrySurface.loadHumanRegistry(opts.home),
  });
  const outboundSeen = new SeenStore(path.join(stateDir(opts.home), "slack-outbound-seen.jsonl"));
  const delivered = new SeenStore(path.join(stateDir(opts.home), "slack-delivered-decisions.jsonl"));
  const attempted = new SeenStore(path.join(stateDir(opts.home), "slack-attempted-decisions.jsonl"));

  // S10 thread routing — the map shares the daemon DB (queue rows carry the rebuild stamps).
  const threadMap = new ThreadSeatMap(opts.queueRepo.db);

  // Late-bound so deliver can release the driver's in-flight guard (built after the wire).
  let releaseRef: (qitemId: string) => void = () => {};

  const deliver = outboundReady
    ? subsystemSlackDeliver({
        botToken: bot!,
        channel: cfg.channel!,
        sourceLabel: cfg.sourceLabel,
        fetchImpl: opts.fetchImpl,
        delivered,
        attempted,
        outboundSeen,
        release: (q) => releaseRef(q),
        // Thread reuse: an open (human, seat) conversation threads; otherwise a new root.
        // For an outbound alert, human = the destination seat-ref, seat = the source seat.
        resolveThreadTs: (p) =>
          threadMap.resolveOpenForPair(p.destinationSession ?? "", p.sourceSession ?? "")?.threadTs,
        // S14: posting and interruption are separate threshold dials over one vocabulary.
        resolveMentionUserId: (p) => {
          if (!p.ownerNotificationLevel || !ownerNotificationLevelAtLeast(p.ownerNotificationLevel, cfg.minimumLevelThatInterrupts)) return undefined;
          const local = (p.destinationSession ?? "").split("@")[0] ?? "";
          if (!local) return undefined;
          const reg = registrySurface.loadHumanRegistry(opts.home);
          if (!reg.ok) return undefined;
          for (const e of reg.entities) {
            if (e.entityId !== local) continue;
            for (const b of e.connectorBindings) {
              if (b.kind === "slack" && b.handle) return b.handle;
            }
          }
          return undefined;
        },
        onPostedRoot: (p, ts) => {
          const human = p.destinationSession ?? "";
          const seat = p.sourceSession ?? "";
          threadMap.open({ threadTs: ts, channel: cfg.channel!, human, seat, conversationId: p.qitemId });
          // The REBUILD stamp: the queue row is the durable source the map re-derives from.
          try {
            opts.queueRepo.update({
              qitemId: p.qitemId,
              actorSession: "daemon@kernel",
              transitionNote: formatPostedStamp({ threadTs: ts, messageTs: ts, channel: cfg.channel!, human, seat, conversationId: p.qitemId }),
            });
          } catch (e) {
            // Stamp failure degrades REBUILDABILITY, not routing — loud, never fatal to delivery.
            log(`thread stamp failed for ${p.qitemId}: ${(e as Error).message}`);
          }
        },
        onPosted: (p, messageTs, threadTs) => {
          try {
            opts.queueRepo.update({
              qitemId: p.qitemId,
              actorSession: "daemon@kernel",
              transitionNote: [
                "slack-owner-notification-posted",
                `notification_key=${p.notificationKey ?? p.qitemId}`,
                `level=${p.ownerNotificationLevel ?? "RECORD"}`,
                `kind=${p.ownerNotificationKind ?? "unclassified"}`,
                `message_ts=${messageTs}`,
                `thread_ts=${threadTs ?? messageTs}`,
              ].join(" "),
            });
          } catch (e) {
            log(`owner notification receipt failed for ${p.qitemId}: ${(e as Error).message}`);
          }
        },
        log,
      })
    : async () => ({ ok: false as const, class: "slack-outbound-not-configured", detail: "bot token or channel missing" });

  const wire = buildInProcessWire({
    home: opts.home,
    ops: outboundReady ? [OUTBOUND_OP] : [],
    deliver,
    log,
  });

  // Services are CONSTRUCTED here but started only via startServices() (post-bind, index.ts):
  // composing a daemon must never dial Slack or start pollers — the createDaemon-in-tests
  // hermeticity rule, same as every monitor in the supervision tree.
  const stops: Array<() => void> = [];
  const starts: Array<() => void> = [];

  if (outboundReady) {
    const driver = new SlackOutboundDriver({
      home: opts.home,
      queue: ports,
      seen: outboundSeen,
      filter: { alertTag: cfg.alertTag, destinations: cfg.outboundDestinations, minimumLevel: cfg.minimumLevelThatPosts },
      dispatch: (op, ref, payload) => wire.dispatcher.dispatch(op, ref, payload),
      intervalMs: opts.outboundIntervalMs,
      log,
    });
    releaseRef = (q) => driver.release(q);
    starts.push(() => {
      driver.start();
      log("slack outbound driver started (subsystem path)");
    });
    stops.push(() => driver.stop());
  }

  if (inboundReady) {
    const inboundSeen = new SeenStore(path.join(stateDir(opts.home), "slack-inbound-seen.jsonl"));
    const dead = new DeadLetterStore<SlackEvent>(path.join(stateDir(opts.home), "slack-inbound-deadletter.jsonl"));
    const registry: RegistrySurface = registrySurface;
    const router = new InboundRouter({
      queue: ports,
      seen: inboundSeen,
      deadLetter: dead,
      destination: cfg.inboundDestination,
      resolveSender: makeInboundSenderResolver(registry, opts.home),
      // S10 — deterministic thread routing: mapped thread → exactly the mapped seat; unmapped
      // or human-initiated → the configured orchestrator slot as an unrouted-signal row.
      resolveRoute: makeThreadRouteResolver({ map: threadMap, unroutedDestination: cfg.inboundDestination, log }),
      log,
    });
    let handle: SocketInboundHandle | undefined;
    starts.push(() => {
      handle = startSocketInbound(app!, router, {
        fetchImpl: opts.fetchImpl,
        wsFactory: opts.wsFactory,
        retryIntervalMs: opts.inboundRetryIntervalMs,
        inboundMaxConnects: opts.inboundMaxConnects,
        log,
      });
      log("slack socket-mode inbound started (subsystem path)");
    });
    stops.push(() => handle?.stop());
  }

  const baseStop = wire.stop;
  const baseStartServices = wire.startServices;
  let servicesLive = false;
  return {
    dispatcher: wire.dispatcher,
    startServices: () => {
      if (servicesLive) return; // idempotent — a double post-bind start must not double-poll
      servicesLive = true;
      baseStartServices?.(); // replay un-Acked decisions through delivery (restart no-loss)
      for (const s of starts) s();
    },
    stop: () => {
      for (const s of stops) { try { s(); } catch { /* best-effort */ } }
      baseStop();
    },
  };
}
