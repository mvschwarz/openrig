import net from "node:net";

export type RunnerRecoveryReply =
  | { ok: true; sessionFile: string; sessionId: string }
  | { ok: false; code: "runner_rpc_unavailable" | "runner_session_mismatch" | "runner_identity_unconfirmed"; detail: string };

export const RECOVERY_TIMEOUT_MS = 5_000;
const MAX_BYTES = 8_192;

/** One read-only operation on the runner's own RPC child. The random launch ID scopes the endpoint to this process. */
export async function startPiRecoveryServer(launchId: string, verify: (sessionFile: string) => Promise<RunnerRecoveryReply>) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(RECOVERY_TIMEOUT_MS, () => socket.destroy());
    let bytes = "";
    let submitted = false;
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      if (submitted) return;
      bytes += data;
      if (Buffer.byteLength(bytes) > MAX_BYTES) { socket.destroy(); return; }
      if (!bytes.includes("\n")) return;
      submitted = true;
      try {
        const request = JSON.parse(bytes.slice(0, bytes.indexOf("\n")));
        if (request.launchId !== launchId || typeof request.sessionFile !== "string" || !request.sessionFile) {
          socket.destroy(); return;
        }
        void verify(request.sessionFile).then(
          (reply) => socket.end(`${JSON.stringify(reply)}\n`),
          () => socket.destroy(),
        );
      } catch { socket.destroy(); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  server.on("error", () => {});
  server.unref();
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}

export function probePiRecovery(port: number, launchId: string, sessionFile: string): Promise<RunnerRecoveryReply> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let bytes = "";
    let done = false;
    const finish = (reply: RunnerRecoveryReply) => {
      if (done) return;
      done = true; clearTimeout(timer); socket.destroy(); resolve(reply);
    };
    const unavailable = () => finish({ ok: false, code: "runner_rpc_unavailable", detail: "The runner did not confirm a live RPC session." });
    const timer = setTimeout(unavailable, RECOVERY_TIMEOUT_MS);
    socket.on("error", unavailable);
    socket.on("close", unavailable);
    socket.on("connect", () => socket.write(`${JSON.stringify({ launchId, sessionFile })}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      bytes += data;
      if (Buffer.byteLength(bytes) > MAX_BYTES) { unavailable(); return; }
      if (!bytes.includes("\n")) return;
      try {
        const reply = JSON.parse(bytes.slice(0, bytes.indexOf("\n")));
        if (reply.ok === true && reply.sessionFile === sessionFile && typeof reply.sessionId === "string" && reply.sessionId) finish(reply);
        else if (reply.ok === false && ["runner_rpc_unavailable", "runner_session_mismatch", "runner_identity_unconfirmed"].includes(reply.code)
          && typeof reply.detail === "string") finish(reply);
        else unavailable();
      } catch { unavailable(); }
    });
  });
}
