import { expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHerdrSocketRpc, resolveHerdrSocketPath } from "../src/domain/terminal/herdr-transport.js";
import { createHerdrViewerRun, resolveHerdrBinary } from "../src/domain/terminal/herdr-viewer.js";
import { createHerdrProviders } from "../src/domain/terminal/herdr-sessions.js";

it.runIf(process.platform === "win32" && !!process.env.OPENRIG_TEST_HERDR)("uses real Herdr Windows pipes with distinct default/named endpoints and private CLI routing", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "openrig-herdr-owned-"))), binary = process.env.OPENRIG_TEST_HERDR!;
  const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
    PATH: [path.dirname(binary), path.dirname(process.execPath), path.join(process.env.SystemRoot!, "System32")].join(";"),
    HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, XDG_CONFIG_HOME: root };
  const run = promisify(execFile), children: Array<{ child: ReturnType<typeof spawn>; closed: boolean }> = [];
  const invoke = async (args: string[]) => (await run(binary, args, { cwd: root, env, timeout: 5000, windowsHide: true })).stdout;
  let bodyFailure: unknown;
  try {
    expect(fs.realpathSync.native(resolveHerdrBinary(env)!)).toBe(fs.realpathSync.native(binary));
    for (const session of [undefined, "owned-named"]) {
      const args = [...(session ? ["--session", session] : []), "server"];
      const child = spawn(binary, args, { cwd: root, env, windowsHide: true, stdio: "ignore" });
      const owned = { child, closed: false }; children.push(owned); child.once("close", () => { owned.closed = true; });
      const socket = resolveHerdrSocketPath(env, session);
      await expect.poll(() => fs.existsSync(socket), { timeout: 5000 }).toBe(true);
      expect(await createHerdrSocketRpc(socket)({ id: "owned", method: "ping", params: {} })).toMatchObject({ type: "pong", version: "0.9.5", protocol: 22 });
      // Explicit socket wins over an inherited, unrelated session marker.
      const cli = createHerdrViewerRun({ socketPath: socket }, { ...env, HERDR_SESSION: "stale-inherited", herdr_session: "another-stale", herdr_socket_path: "wrong-inherited" });
      expect(JSON.parse(await cli(["status", "server", "--json"]))).toMatchObject({ running: true, socket, version: "0.9.5", protocol: 22 });
    }
    const providers = createHerdrProviders(env);
    expect(await providers.defaultProvider.status()).toMatchObject({ provider: "herdr", available: true, launch: { socketPath: resolveHerdrSocketPath(env) } });
    expect(await providers.sessionProvider("owned-named").status()).toMatchObject({ provider: "herdr", available: true, launch: { socketPath: resolveHerdrSocketPath(env, "owned-named"), session: "owned-named" } });
    await invoke(["--session", "owned-named", "server", "stop"]);
    await expect.poll(() => providers.sessionProvider("owned-named").liveness(), { timeout: 5000 }).toMatchObject({ alive: false });
    expect(await providers.defaultProvider.liveness()).toMatchObject({ alive: true });
  } catch (error) { bodyFailure = error; throw error; } finally {
    await invoke(["--session", "owned-named", "server", "stop"]).catch(() => {});
    await invoke(["server", "stop"]).catch(() => {});
    for (const owned of children) {
      await expect.poll(() => owned.closed, { timeout: 5000 }).toBe(true);
      expect(owned.child.exitCode).toBe(0);
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (cleanupFailure) { if (bodyFailure) throw new AggregateError([bodyFailure, cleanupFailure], "Native Herdr operation and cleanup both failed"); throw cleanupFailure; }
  }
}, 30000);
