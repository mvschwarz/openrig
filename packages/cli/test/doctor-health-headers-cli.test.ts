import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe.skipIf(process.platform === "win32")("doctor with a listener holding response headers", () => {
  it("returns an unknown listener result through the built CLI", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "doctor-held-headers-"));
    const requests: string[] = [];
    const server = createServer(req => { requests.push(req.url ?? ""); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const cli = fileURLToPath(new URL("../dist/bin-wrapper.js", import.meta.url));
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, "doctor", "--json"], {
          env: { HOME: root, OPENRIG_HOME: path.join(root, "openrig"), OPENRIG_PORT: String(port), PATH: "/usr/bin:/bin", TMPDIR: root },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.resume();
        const timer = setTimeout(() => { child.kill(); reject(new Error("doctor did not finish")); }, 30_000);
        child.on("error", error => { clearTimeout(timer); reject(error); });
        child.on("close", () => { clearTimeout(timer); resolve(stdout); });
      });
      const result = JSON.parse(output) as { checks: Array<{ name: string; status: string; message: string }> };
      const check = result.checks.find(item => item.name === "port");
      expect(requests).toContain("/healthz");
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain("unknown listener");
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
