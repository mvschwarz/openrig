import { Command } from "commander";
import path from "node:path";
import { DaemonClient } from "../client.js";
import { resolveSenderSession, SENDER_FALLBACK } from "../sender-identity.js";
import type { FetchImpl } from "@openrig/daemon/gateway-matrix";

type MatrixSurface = typeof import("@openrig/daemon/gateway-matrix");
export interface MatrixDeps {
  home?: string;
  log?: (message: string) => void;
  surface?: () => Promise<MatrixSurface>;
  fetchImpl?: FetchImpl;
  clientFactory?: () => Pick<DaemonClient, "get" | "post">;
}
export function matrixCommand(deps: MatrixDeps = {}): Command {
  const log = deps.log ?? console.log;
  const load = deps.surface ?? (() => import("@openrig/daemon/gateway-matrix"));
  const client = deps.clientFactory ?? (() => new DaemonClient());
  const cmd = new Command("matrix").description("Matrix connector: bot configuration + in-daemon chat over /sync");
  // Like Slack setup, flags provide an interactive-ish incremental configuration
  // that also works unattended. The access-token-file avoids shell-history leaks.
  cmd.command("setup").description("Configure a Matrix bot; access token stays in a 0600 secret file")
    .option("--homeserver-url <url>", "Matrix homeserver HTTP(S) base URL")
    .option("--access-token <token>", "Bot access token (prefer --access-token-file to avoid shell history)")
    .option("--access-token-file <path>", "Read the bot access token from a local file")
    .option("--secrets-env-file <path>", "0600 env file containing MATRIX_ACCESS_TOKEN")
    .option("--device-id <id>", "Existing bot device ID (optional; does not enable encryption)")
    .option("--default-room <room>", "Default unencrypted room: !room:server or #alias:server")
    .option("--inbound-destination <session>", "Destination for unthreaded messages (default operator-agent@kernel)")
    .option("--reason <reason>", "Reason recorded with the configuration change", "configure Matrix human delivery")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .action(async (opts) => {
      try {
        const surface = await load();
        const current = surface.loadConfig(deps.home);
        const next = { ...current, homeserverUrl: opts.homeserverUrl ?? current.homeserverUrl,
          deviceId: opts.deviceId ?? current.deviceId, defaultRoom: opts.defaultRoom ?? current.defaultRoom,
          inboundDestination: opts.inboundDestination ?? current.inboundDestination,
          secretsEnvFile: opts.secretsEnvFile ? path.resolve(opts.secretsEnvFile) : current.secretsEnvFile };
        surface.validateConfig(next);
        if (opts.accessToken !== undefined && opts.accessTokenFile !== undefined) throw new Error("Choose --access-token or --access-token-file");
        const token = opts.accessTokenFile ? (await import("node:fs/promises")).readFile(opts.accessTokenFile, "utf8").then((text) => text.trim()) : opts.accessToken;
        const accessToken = await token;
        const result = await surface.runChannelOperation({ actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK,
          provenance: "claimed:v1", reason: opts.reason, action: "configure", subject: "matrix", before: { digest: surface.channelStateDigest(current) },
          run: async () => {
            if (accessToken !== undefined) next.secretsEnvFile = surface.saveAccessToken(accessToken, deps.home, next.secretsEnvFile ?? undefined);
            const file = surface.saveConfig(next, deps.home);
            return { value: file, after: { digest: surface.channelStateDigest(next) }, effect: "applied" };
          } }, deps.home);
        log(`wrote ${result.value}; receipt ${result.receipt.id}`);
        log("Next: rig matrix verify, then rig matrix enable. Re-enable after changing a running connector's configuration.");
      } catch (error) { log(`✗ setup failed: ${(error as Error).message}`); process.exitCode = 1; }
    });
  cmd.command("status").description("Show local configuration and the daemon's last sync snapshot (no Matrix calls)")
    .option("--json", "Machine-readable output")
    .action(async (opts) => {
      try {
        const surface = await load();
        const cfg = surface.loadConfig(deps.home);
        const configured = !!cfg.homeserverUrl && !!surface.resolveAccessToken({ envFile: cfg.secretsEnvFile });
        let running: unknown = { state: "unavailable" };
        try {
          const response = await client().get<Record<string, unknown>>("/api/gateway/matrix/status", { timeoutMs: 900 });
          if (response.status === 200) running = response.data;
        } catch { /* Local configuration remains useful when the daemon is offline. */ }
        const status = { configured, enabled: cfg.enabled, homeserverUrl: cfg.homeserverUrl, deviceId: cfg.deviceId,
          defaultRoom: cfg.defaultRoom, inboundDestination: cfg.inboundDestination, running };
        if (opts.json) log(JSON.stringify(status, null, 2));
        else { log(`matrix connector: ${configured ? "configured" : "incomplete"}, ${cfg.enabled ? "enabled" : "disabled"}`); log(`Daemon: ${JSON.stringify(running)}`); }
      } catch (error) { log(`✗ status failed: ${(error as Error).message}`); process.exitCode = 1; }
    });
  cmd.command("verify").description("Verify bot identity; optionally join a room and send a test message")
    .option("--join", "Join the --room or configured default room")
    .option("--send-test", "Send a test message to the --room or configured default room")
    .option("--room <room>", "Room ID or alias to verify")
    .option("--json", "Machine-readable output")
    .option("--reason <reason>", "Reason recorded with the verification", "verify Matrix human delivery")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .action(async (opts) => {
      try {
        const surface = await load();
        const cfg = surface.loadConfig(deps.home);
        const token = surface.resolveAccessToken({ envFile: cfg.secretsEnvFile });
        if (!cfg.homeserverUrl || !token) throw new Error("Matrix homeserver URL or access token missing; run rig matrix setup");
        const api = new surface.MatrixClient({ homeserverUrl: cfg.homeserverUrl, accessToken: token, deviceId: cfg.deviceId ?? undefined }, { fetchImpl: deps.fetchImpl });
        const result = await surface.runChannelOperation({ actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK,
          provenance: "claimed:v1", reason: opts.reason, action: "verify", subject: "matrix", before: { digest: surface.channelStateDigest(cfg) },
          run: async () => {
            const identity = await api.whoami();
            let room = opts.room ?? cfg.defaultRoom;
            if ((opts.join || opts.sendTest) && !room) throw new Error("Set --room or configure --default-room");
            if (room) surface.validateConfig({ ...cfg, defaultRoom: room });
            if (opts.join || (opts.sendTest && room.startsWith("#"))) room = (await api.joinRoom(room)).room_id;
            if (opts.join || opts.sendTest) {
              const state = await api.getRoomState(room);
              if (state.some((event) => event.type === "m.room.encryption")) throw new Error("Matrix encrypted rooms are unsupported");
              if (opts.sendTest) await api.sendMessage(room, "OpenRig Matrix connector verification.");
            }
            return { value: { ok: true, ...identity, room, testSent: !!opts.sendTest }, after: { ready: true }, effect: "observed" };
          } }, deps.home);
        log(opts.json ? JSON.stringify(result.value, null, 2) : `Matrix bot verified: ${result.value.user_id}${result.value.testSent ? "; test message sent" : ""}`);
      } catch (error) { log(`✗ verify failed: ${(error as Error).message}`); process.exitCode = 1; }
    });
  for (const operation of ["enable", "disable"] as const) {
    const command = cmd.command(operation).description(`${operation === "enable" ? "Enable (seed existing alerts as history)" : "Disable"} Matrix delivery and rewire the daemon`)
      .option("--actor <actor>", "Named operator when outside a managed seat");
    if (operation === "disable") command.requiredOption("--reason <reason>", "Why Matrix human delivery is being shut down");
    else command.option("--reason <reason>", "Reason recorded with the change", "enable Matrix human delivery");
    command.action(async (opts) => {
      try {
        const response = await client().post<{ ok: boolean; onlineStatus: string }>(`/api/gateway/matrix/${operation}`,
          { actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK, reason: opts.reason });
        if (response.status !== 200 || response.data.ok !== true) throw new Error(`daemon refused ${operation} (HTTP ${response.status})`);
        log(response.data.onlineStatus);
      } catch (error) { log(`✗ ${operation} failed: ${(error as Error).message}`); process.exitCode = 1; }
    });
  }
  return cmd;
}
