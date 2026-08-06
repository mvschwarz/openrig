import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import {
  readSurface,
  UnboundSurfaceError,
  type SurfaceContext,
} from "./helpers/scenario-surfaces.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_BIN = resolve(HERE, "../../cli/dist/bin-wrapper.js");
const realBaseEnv = () => ({ HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" });

// Slice 51-02 — surface readers: read each shipped-observable surface via the
// shipped `rig` invocation and parse it into the observable the runner asserts
// on. The FLAG-1 fail-closed floor (PM ruling): the `proof` surface VALIDATES
// (locked name) but the runner FAILS LOUD at execution with a named unbound
// error — it never fabricates a read from scope-audit or anywhere else.

describe("surface readers — FLAG-1 proof unbound floor + dispatch (pure)", () => {
  const ctx: SurfaceContext = { rigBin: RIG_BIN, readEnv: {}, baseUrl: "http://127.0.0.1:1" };

  it("readSurface('proof') FAILS LOUD with a named UnboundSurfaceError (never fabricates, never skips)", async () => {
    await expect(readSurface("proof", ctx)).rejects.toBeInstanceOf(UnboundSurfaceError);
    let msg = "";
    try { await readSurface("proof", ctx); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("proof");
    expect(msg.toLowerCase()).toContain("unbound");
    // it must NOT claim success or return a value
  });

  it("readSurface(unknown surface) throws (never silently skips)", async () => {
    await expect(readSurface("database" as never, ctx)).rejects.toThrow();
  });
});

describe("surface readers — tui_socket `state` query (fake unix socket)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("connects, sends exactly `state`, and parses the one-line JSON reply", async () => {
    // Keep the socket path SHORT (sun_path ~104-byte cap): tmpdir + short name.
    const d = mkdtempSync(join(tmpdir(), "ts-"));
    dirs.push(d);
    const sockPath = join(d, "t.sock");
    const stateReply = { ok: true, instanceId: "i1", state: { ok: true, screen: "rigs", drill: [], viewTab: "graph" } };
    let received = "";
    const server = net.createServer((conn) => {
      conn.on("data", (b) => {
        received += b.toString();
        if (received.includes("\n") || received.trim() === "state") {
          conn.write(JSON.stringify(stateReply) + "\n");
        }
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, r));
    try {
      const ctx: SurfaceContext = {
        rigBin: RIG_BIN,
        readEnv: { OPENRIG_TUI_SOCKET: sockPath },
        baseUrl: "http://127.0.0.1:1",
      };
      const observed = await readSurface("tui_socket", ctx);
      expect(observed).toEqual(stateReply);
      expect(received.trim()).toBe("state"); // sent exactly the OBSERVE verb, no mutation
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("surface readers — live daemon (integration)", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  afterEach(async () => {
    if (daemon) await daemon.stop().catch(() => {});
    else if (scaffold) scaffold.cleanup();
    daemon = undefined; scaffold = undefined;
  });

  it("ps and queue readers return parsed bare arrays from the scenario-local daemon", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });
    const ctx: SurfaceContext = { rigBin: RIG_BIN, readEnv: daemon.readEnv, baseUrl: daemon.baseUrl };

    const ps = await readSurface("ps", ctx);
    expect(Array.isArray(ps)).toBe(true);
    const queue = await readSurface("queue", ctx);
    expect(Array.isArray(queue)).toBe(true);
  }, 60_000);
});
