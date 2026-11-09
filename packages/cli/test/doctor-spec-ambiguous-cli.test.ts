import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe.skipIf(process.platform === "win32")("doctor --spec with duplicate live names", () => {
  it("reports both IDs without fetching either topology through the built CLI", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "doctor-ambiguous-cli-"));
    const spec = path.join(root, "rig.yaml");
    writeFileSync(spec, "version: '0.2'\nname: twin\npods:\n  - namespace: orch\n    members:\n      - name: lead\n");
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/rigs") res.end(JSON.stringify([{ id: "first", name: "twin" }, { id: "second", name: "twin" }]));
      else if (req.url === "/healthz") res.end(JSON.stringify({ ok: true, pid: process.pid, euid: process.geteuid?.() }));
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const cli = fileURLToPath(new URL("../dist/bin-wrapper.js", import.meta.url));
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, "doctor", "--spec", spec, "--json"], {
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
      const check = result.checks.find(item => item.name === "spec_live_conformance");
      expect(check?.status).toBe("skipped");
      expect(check?.message).toContain("first, second");
      expect(requests.filter(url => url === "/api/rigs")).toHaveLength(1);
      expect(requests.some(url => url.includes("/nodes"))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
