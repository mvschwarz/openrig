import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveNodeConfig, type ResolutionContext } from "../src/domain/profile-resolver.js";
import { resolveNodeConfigAsync, withNodeConfigResolver } from "../src/domain/profile-resolution-worker.js";
import { preflightValidatedSpec } from "../src/domain/rigspec-preflight.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): ResolutionContext {
  const root = mkdtempSync(join(tmpdir(), "profile-worker-"));
  roots.push(root);
  const member = { id: "worker", agentRef: "local:agent", profile: "default", runtime: "codex", cwd: root };
  const pod = { id: "dev", label: "Dev", members: [member], edges: [] };
  return {
    baseSpec: {
      sourcePath: root, hash: "test",
      spec: {
        name: "worker", version: "1.0.0", imports: [],
        startup: { files: [], actions: [] },
        resources: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
        profiles: { default: { uses: { skills: ["wanted"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
      },
    },
    importedSpecs: [], collisions: [], profileName: "default", member, pod,
    rig: { version: "0.2", name: "test", pods: [pod], edges: [] }, homedir: root,
  };
}

function skill(ctx: ResolutionContext, folder: string, name: string): void {
  const dir = join(ctx.homedir!, ".agents", "skills", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\nBody\n`);
}

function startScanGate(root: string, deadlineMs = 5000) {
  const gate = join(root, ".agents", "skills", "scan-gate", "SKILL.md");
  mkdirSync(join(gate, ".."), { recursive: true });
  execFileSync("mkfifo", [gate]);
  const helper = join(root, "scan-gate.cjs");
  writeFileSync(helper, `
    const fs = require("node:fs/promises");
    const { constants } = require("node:fs");
    (async () => {
      const gate = process.argv[2];
      let handle;
      let release;
      const released = new Promise(resolve => { release = resolve; });
      process.on("message", release);
      const deadline = setTimeout(() => {
        if (handle) release();
        else process.exit(2);
      }, Number(process.argv[3]));
      // Nonblocking open keeps the helper's own event loop and exit bounded.
      while (!handle) {
        try { handle = await fs.open(gate, constants.O_WRONLY | constants.O_NONBLOCK); }
        catch (error) {
          if (error.code !== "ENXIO") throw error;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      process.send("scan-started");
      await released;
      clearTimeout(deadline);
      const content = "---\\nname: scan-gate\\ndescription: Test skill\\n---\\nBody\\n";
      // Further scans see a regular file, while the first reader keeps its open FIFO.
      await fs.unlink(gate);
      await fs.writeFile(gate, content);
      await handle.writeFile(content);
      await handle.close();
      process.disconnect();
    })().catch(error => { console.error(error); process.exit(1); });
  `);
  const writer = fork(helper, [gate, String(deadlineMs)], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const writerExited = once(writer, "exit");
  return { writer, writerExited };
}

describe("profile resolution outside the daemon request thread", () => {
  it("preserves fallback discovery and reads edits on the next call", async () => {
    const ctx = fixture();
    skill(ctx, "different-folder", "wanted");
    await withNodeConfigResolver(async resolve => {
      const first = await resolve(ctx);
      expect(first.ok).toBe(true);
      expect(first).toEqual(resolveNodeConfig(ctx));

      skill(ctx, "different-folder", "renamed");
      const next = await resolve(ctx);
      expect(next.ok).toBe(false);
      expect(next).toEqual(resolveNodeConfig(ctx));
    });
  });

  it("serves a health request while a fallback skill scan is held open", async () => {
    const ctx = fixture();
    // The FIFO holds a real fallback scan until health responds, independent of disk speed.
    // A separate process releases it on timeout too, so a synchronous regression fails
    // the assertion below instead of hanging the request thread forever.
    const { writer, writerExited } = startScanGate(ctx.homedir!);
    const scanStarted = Promise.race([
      once(writer, "message"),
      writerExited.then(([code]) => { throw new Error(`Scan helper exited before opening the FIFO (code ${code})`); }),
    ]);
    const server = createServer((_req, res) => { res.end("healthy"); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    let completed = false;
    const resolution = preflightValidatedSpec(ctx.rig, {
      rigRoot: ctx.homedir!,
      fsOps: {
        exists: path => path === join(ctx.homedir!, "agent", "agent.yaml"),
        readFile: () => "name: worker\nversion: '1.0.0'\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: [wanted]\n",
      },
    }).then(result => { completed = true; return result; });
    try {
      expect((await Promise.race([
        scanStarted,
        resolution.then(() => { throw new Error("Preflight completed without opening the scan gate"); }),
      ]))[0]).toBe("scan-started");
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await response.text()).toBe("healthy");
      expect(completed).toBe(false);
      writer.send("release", () => {});
      const result = await resolution;
      expect(result.ready).toBe(false);
      expect(result.errors.some(error => error.includes("wanted"))).toBe(true);
    } finally {
      if (writer.connected) writer.send("release", () => {});
      await resolution.catch(() => undefined);
      const [exitCode] = await writerExited;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      expect(exitCode).toBe(0);
    }
  });

  it.each(["deleted", "deleted-cached"])("preserves fresh reads across repeated resolutions with a %s cwd", mode => {
    const ctx = fixture();
    skill(ctx, "different-folder", "wanted");
    writeFileSync(join(ctx.homedir!, "context.json"), JSON.stringify(ctx));
    const child = spawnSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"),
      fileURLToPath(new URL("./fixtures/profile-worker-deleted-cwd.ts", import.meta.url)), ctx.homedir!, mode],
    { cwd: ctx.homedir!, encoding: "utf8", timeout: 10_000, env: { ...process.env } });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.first.ok).toBe(true);
    expect(result.next.ok).toBe(false);
    expect(result.next.errors.some((error: string) => error.includes("wanted"))).toBe(true);
  });

  it("bounds the helper even when resolution fails before opening the FIFO", async () => {
    const ctx = fixture();
    const { writer, writerExited } = startScanGate(ctx.homedir!, 200);
    ctx.baseSpec.spec = null as unknown as ResolutionContext["baseSpec"]["spec"];
    try {
      await expect(resolveNodeConfigAsync(ctx)).rejects.toThrow(/profiles/);
      expect((await writerExited)[0]).toBe(2);
    } finally {
      if (writer.exitCode === null) writer.kill();
      await writerExited;
    }
  });

  it("does not turn a clone failure into synchronous resolution", async () => {
    const ctx = Object.assign(fixture(), { uncloneable: () => {} });
    await expect(resolveNodeConfigAsync(ctx)).rejects.toThrow(/cloned/);
  });

  it("propagates a resolver exception instead of waiting forever for a result", async () => {
    const ctx = fixture();
    // A malformed internal input throws before producing a normal validation result.
    ctx.baseSpec.spec = null as unknown as ResolutionContext["baseSpec"]["spec"];
    await expect(resolveNodeConfigAsync(ctx)).rejects.toThrow(/profiles/);
  });
});
