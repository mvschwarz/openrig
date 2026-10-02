import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { daemonCommand } from "../src/commands/daemon.js";
import { doctorLegs, type DoctorDeps } from "../src/commands/host.js";
import type { LifecycleDeps } from "../src/daemon-lifecycle.js";

it.each(["healthy", "unhealthy", "unverified", "stopped"] as const)(
  "preserves the actual daemon status command's %s verdict in SSH doctor",
  async (mode) => {
    const server = createServer((req, res) => {
      if (mode === "unverified") { req.socket.destroy(); return; }
      res.statusCode = mode === "unhealthy" ? 503 : 200;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${address.port}`);
    if (mode === "stopped") await new Promise<void>((resolve) => server.close(() => resolve()));
    const calls: string[][] = [];
    const run: DoctorDeps["run"] = async (_host, argv) => {
      calls.push([...argv]);
      let stdout = "";
      if (argv[1] === "daemon") {
        const lines: string[] = [];
        const output = vi.spyOn(console, "log").mockImplementation((...parts) => { lines.push(parts.join(" ")); });
        try {
          const command = new Command();
          command.addCommand(daemonCommand({
            fetch, readFile: () => null, exists: () => false, isProcessAlive: () => false,
          } as LifecycleDeps));
          await command.parseAsync(["node", "rig", "daemon", "status"]);
        } finally { output.mockRestore(); }
        stdout = lines.join("\n");
      } else if (argv[1] === "--version") stdout = "0.6.3";
      else if (argv[1] === "ps") stdout = '{"entries":[]}';
      return { ok: true, failedStep: "none", stdout, stderr: "", remoteExitCode: 0 };
    };
    try {
      const rows = await doctorLegs({ id: "edge", transport: "ssh", target: "fixture.invalid" }, {
        run, httpGet: async () => { throw new Error("unused HTTP transport"); },
        tcpProbe: async () => { throw new Error("unused TCP probe"); },
      });
      const health = rows.find((row) => row.step === "remote-daemon-health")!;
      expect(health.status).toBe(mode === "healthy" ? "pass" : mode === "unverified" ? "unknown" : "fail");
      if (mode === "unverified") {
        expect(health.detail).not.toContain("not running");
        expect(health.fix).not.toContain("rig daemon start");
      }
      if (mode === "unhealthy") expect(health.detail).not.toContain("not running");
      expect(calls.some((argv) => argv[1] === "ps")).toBe(mode === "healthy");
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      if (mode !== "stopped") await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
