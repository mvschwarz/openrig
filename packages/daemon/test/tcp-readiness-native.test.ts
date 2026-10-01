import net, { type AddressInfo } from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { execCommand } from "../src/adapters/tmux-exec.js";

describe.skipIf(process.platform === "win32")("TCP service readiness", () => {
  it.each(["127.0.0.1", "::1"])("probes an owned %s listener through production nc", async host => {
    let connections = 0;
    const server = net.createServer(socket => { connections++; socket.end(); });
    server.listen(0, host);
    await once(server, "listening");
    try {
      const port = (server.address() as AddressInfo).port;
      const target = `${host.includes(":") ? `[${host}]` : host}:${port}`;
      expect(await new ComposeServicesAdapter(execCommand).probeTcp(target, 1000)).toBe(true);
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
