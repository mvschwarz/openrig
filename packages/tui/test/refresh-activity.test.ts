// S16 measured RED (23 live rigs, 2026-08-26): 167 direct HTTP reads in
// 16 seconds, including a 117-read five-second bin; daemon CPU was 15.5%
// during the TUI window versus 2.125% in the adjacent control. This probe
// drives the production entrypoint so the cadence cannot pass behind a mock.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];
const tempDirs: string[] = [];

function responseFor(route: string): unknown {
  if (route === "/api/scopes?detail=1") return { missions: [] };
  if (route === "/api/review/fleet") return { needsYou: { items: [] }, hosts: [] };
  if (route === "/api/queue/attention-aggregate") return { hosts: [] };
  return [];
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for TUI requests");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode != null) return;
  child.stdin.write("q");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => {
      child.kill("SIGTERM");
      resolve();
    }, 2_000)),
  ]);
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("production TUI refresh cadence", () => {
  it("does no steady-state reads merely by being open and refreshes on operator activity", async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseFor(req.url ?? "")));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const root = await mkdtemp(path.join(tmpdir(), "openrig-tui-refresh-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const rigStub = path.join(bin, "rig");
    await writeFile(rigStub, "#!/bin/sh\nexit 1\n");
    await chmod(rigStub, 0o755);

    const viteNode = fileURLToPath(new URL("../../../node_modules/vite-node/vite-node.mjs", import.meta.url));
    const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    const child = spawn(process.execPath, [viteNode, "--script", entry, "--instance", "refresh-policy-test", "--no-color", "--url", `http://127.0.0.1:${address.port}`], {
      env: {
        ...process.env,
        OPENRIG_HOME: root,
        OPENRIG_TUI_SOCKET: path.join(root, "t.sock"),
        PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    try {
      await until(() => requests.length >= 11 || child.exitCode != null);
      expect(child.exitCode, stderr).toBeNull();
      const initialReads = requests.length;

      await new Promise((resolve) => setTimeout(resolve, 5_300));
      const idleReads = requests.length;

      child.stdin.write("\x1b[B");
      await until(() => requests.length > idleReads || child.exitCode != null, 1_500).catch(() => {});
      const activeReads = requests.length;

      expect(idleReads, "an unchanged open TUI must not rebuild the fleet on a timer").toBe(initialReads);
      expect(activeReads, "operator input must request fresh data").toBeGreaterThan(idleReads);
    } finally {
      await stop(child);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 12_000);
});
