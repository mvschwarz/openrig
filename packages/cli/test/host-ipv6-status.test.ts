import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { hostCommand } from "../src/commands/host.js";

it("host list reports a live IPv6 endpoint reachable through its native TCP probe", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-host-ipv6-"));
  const server = createServer((socket) => socket.end());
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("OPENRIG_HOME", home);
  try {
    server.listen(0, "::1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "hosts.yaml"), JSON.stringify({ hosts: [
      { id: "ipv6-edge", transport: "http", url: `http://[::1]:${address.port}` },
    ] }));
    const program = new Command();
    program.addCommand(hostCommand());
    await program.parseAsync(["node", "rig", "host", "list", "--json"]);
    const rows = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "ipv6-edge", status: "reachable" });
  } finally {
    server.close();
    await once(server, "close");
    output.mockRestore();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
