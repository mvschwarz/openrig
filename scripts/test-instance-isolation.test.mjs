import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

for (const prefix of ["OPENRIG", "RIGGED"]) {
  test(`npm daemon tests leave an inherited ${prefix} instance untouched`, { timeout: 60000 }, async () => {
    const outer = mkdtempSync(join(tmpdir(), "test-outer-instance-"));
    const home = join(outer, "user"), state = join(outer, "state");
    mkdirSync(home); mkdirSync(state);
    const audit = join(state, "bundle-audit.jsonl");
    const database = join(outer, "outer.sqlite");
    writeFileSync(audit, "outer sentinel\n");
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    // Both state-file and explicit-env discovery point only at this disposable server.
    writeFileSync(join(state, "daemon.json"), JSON.stringify({ pid: process.pid, port, host: "127.0.0.1" }));
    const env = { ...process.env, HOME: home, OPENRIG_TEST_OUTER_INSTANCE: outer };
    for (const key of Object.keys(env)) {
      if (/^(OPENRIG|RIGGED)_(HOME|URL|DB|PORT|HOST|HOST_SELECTED)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      [`${prefix}_HOME`]: state, [`${prefix}_DB`]: database,
      [`${prefix}_URL`]: `http://127.0.0.1:${port}`, [`${prefix}_PORT`]: String(port),
      [`${prefix}_HOST`]: "127.0.0.1", OPENRIG_HOST_SELECTED: "outer-fixture",
    });
    let output = "";
    try {
      const child = spawn("npm", ["test", "-w", "packages/daemon", "--",
        "test/bundle-routes.test.ts", "test/instance-environment.test.ts", "--maxWorkers=1",
        "-t", "v2 bundle enters pod-aware path|test instance environment"],
      { cwd: repo, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      const timeout = setTimeout(() => {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL"); // Only this owned npm/Vitest process group.
      }, 50000);
      const [code, signal] = await once(child, "close").finally(() => clearTimeout(timeout));
      const effects = {
        auditUnchanged: readFileSync(audit, "utf8") === "outer sentinel\n",
        databaseUntouched: !existsSync(database),
        routedRequests: requests,
      };
      // Inspect effects before the child exit, so the parent discriminator names
      // the actual leak even if another assertion in that run also fails.
      assert.deepEqual(effects, { auditUnchanged: true, databaseUntouched: true, routedRequests: [] });
      assert.equal(signal, null, output);
      assert.equal(code, 0, output);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      rmSync(outer, { recursive: true, force: true });
    }
  });
}
