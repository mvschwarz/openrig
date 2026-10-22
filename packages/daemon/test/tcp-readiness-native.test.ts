import net, { type AddressInfo } from "node:net";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { evaluateWaitTargets } from "../src/domain/services-readiness.js";

// A numeric-port TCP probe opens a real socket in-process. The exec function is a spy that must never
// run for those, so the probe works on hosts without `nc` (many Linux installs) and never forks a shell.
// A named port (`db:postgresql`) still goes through `nc`, which looks the service name up.
function adapter() {
  const exec = vi.fn(async () => { throw new Error("probeTcp must not shell out"); });
  return { exec, adapter: new ComposeServicesAdapter(exec) };
}

async function withListener<T>(host: string, run: (port: number, connections: () => number) => Promise<T>): Promise<T> {
  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.end(); });
  server.listen(0, host);
  await once(server, "listening");
  try {
    return await run((server.address() as AddressInfo).port, () => connections);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe.skipIf(process.platform === "win32")("TCP service readiness", () => {
  it.each(["127.0.0.1", "::1"])("probes an owned %s listener without an external nc", async host => {
    const { exec, adapter: a } = adapter();
    await withListener(host, async (port, connections) => {
      const target = `${host.includes(":") ? `[${host}]` : host}:${port}`;
      expect(await a.probeTcp(target, 1000)).toBe(true);
      await vi.waitFor(() => expect(connections()).toBe(1));
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports a closed port as not ready", async () => {
    const { exec, adapter: a } = adapter();
    // Take a free port, then release it, so nothing is listening there.
    const port = await withListener("127.0.0.1", async p => p);
    expect(await a.probeTcp(`127.0.0.1:${port}`, 1000)).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "127.0.0.1:", ":5432", "127.0.0.1:0", "127.0.0.1:65536", "::1:5432", "db:post gres", "db:-5432", "db:-pfs", "db:12-34"])(
    "refuses the malformed target %j without probing, and says why",
    async target => {
      const { exec, adapter: a } = adapter();
      expect(await a.probeTcp(target, 1000)).toBe(false);
      const [result] = await evaluateWaitTargets([{ tcp: target }], a);
      expect(result!.status).toBe("unhealthy");
      expect(result!.detail).toBe(
        `TCP probe failed: ${target} is not host:port with a port from 1 to 65535 or a service name`,
      );
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it("keeps a closed numeric port's detail unchanged", async () => {
    const { adapter: a } = adapter();
    const port = await withListener("127.0.0.1", async p => p);
    const [result] = await evaluateWaitTargets([{ tcp: `127.0.0.1:${port}` }], a);
    expect(result!.detail).toBe(`TCP probe failed: 127.0.0.1:${port}`);
  });

  describe("a named port", () => {
    it("goes through nc unchanged where nc exists", async () => {
      const commands: string[] = [];
      const a = new ComposeServicesAdapter(async cmd => { commands.push(cmd); return ""; });
      expect(await a.probeTcp("db:postgresql", 3000)).toBe(true);
      expect(commands).toEqual(["command -v nc", "nc -z -w 3 'db' 'postgresql' 2>/dev/null"]);
    });

    it("accepts a service name that starts with a digit, such as 9pfs", async () => {
      const commands: string[] = [];
      const a = new ComposeServicesAdapter(async cmd => { commands.push(cmd); return ""; });
      const [result] = await evaluateWaitTargets([{ tcp: "fs:9pfs" }], a);
      expect(result!.status).toBe("healthy");
      expect(commands).toEqual(["command -v nc", "nc -z -w 5 'fs' '9pfs' 2>/dev/null"]);
    });

    it("reads an nc failure as not ready, with the plain detail", async () => {
      const a = new ComposeServicesAdapter(async cmd => {
        if (cmd.startsWith("nc ")) throw new Error("exit 1");
        return "/usr/bin/nc";
      });
      expect(await a.probeTcp("db:postgresql", 1000)).toBe(false);
      const [result] = await evaluateWaitTargets([{ tcp: "db:postgresql" }], a);
      expect(result!.detail).toBe("TCP probe failed: db:postgresql");
    });

    it("fails the wait with a detail naming nc when nc isn't installed", async () => {
      const commands: string[] = [];
      const a = new ComposeServicesAdapter(async cmd => { commands.push(cmd); throw new Error("exit 127"); });
      expect(await a.probeTcp("db:postgresql", 1000)).toBe(false);
      const [result] = await evaluateWaitTargets([{ tcp: "db:postgresql" }], a);
      expect(result!.status).toBe("unhealthy");
      expect(result!.detail).toBe(
        "TCP probe failed: db:postgresql uses a named port, which needs nc on PATH. Install nc or use a numeric port",
      );
      expect(commands.every(cmd => cmd === "command -v nc")).toBe(true);
    });
  });
});
