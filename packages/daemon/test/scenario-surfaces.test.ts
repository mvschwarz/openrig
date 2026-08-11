import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { spawnScenarioDaemon, runRig, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import {
  readSurface,
  transcriptReadArgv,
  UnboundSurfaceError,
  type SurfaceContext,
} from "./helpers/scenario-surfaces.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_BIN = resolve(HERE, "../../cli/dist/bin-wrapper.js");
const realBaseEnv = () => ({ HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" });

// Slice 51-02 — surface readers: read each shipped-observable surface via the
// shipped `rig` invocation and parse it into the observable the runner asserts
// on. `proof` is RESERVED at the format level (PM lock amendment, ruling row
// qitem-20260811092250-a80735bc) — the validator rejects it at load, and the
// reader keeps a defense-in-depth unbound error for a runtime-smuggled value.

describe("surface readers — reserved-proof defense-in-depth + dispatch (pure)", () => {
  const ctx: SurfaceContext = { rigBin: RIG_BIN, readEnv: {}, baseUrl: "http://127.0.0.1:1" };

  it("a runtime-smuggled 'proof' read still FAILS LOUD with a named UnboundSurfaceError (defense-in-depth)", async () => {
    // "proof" left the ExpectSurface type (RESERVED); only a cast can reach here.
    const smuggled = "proof" as never;
    await expect(readSurface(smuggled, ctx)).rejects.toBeInstanceOf(UnboundSurfaceError);
    let msg = "";
    try { await readSurface(smuggled, ctx); } catch (e) { msg = (e as Error).message; }
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

  // Guard finding 1 (false-green): the transcript reader emitted `--tail --json`,
  // but `--tail <lines>` takes a REQUIRED value, so Commander consumed "--json"
  // AS the tail value ({"tail":"--json"}) and JSON mode was never set. The
  // containsMatch unit pin never crossed this reader/CLI boundary, so "D11 covers
  // transcript" was false for transcript. This crosses it for real.
  it("the transcript reader reaches JSON mode at the REAL CLI boundary (not human text)", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });

    // Drive the shipped CLI with the reader's OWN argv, then assert on the effect:
    // stdout must PARSE as JSON. Human text parses as nothing.
    const argv = transcriptReadArgv("no-such-seat@scn-none");
    expect(argv).toContain("--json");
    const tailIdx = argv.indexOf("--tail");
    expect(tailIdx).toBeGreaterThanOrEqual(0);
    expect(argv[tailIdx + 1]).toMatch(/^\d+$/); // a VALUE, never the next flag

    const r = await runRig(argv, daemon.readEnv, RIG_BIN);
    expect(() => JSON.parse(r.stdout)).not.toThrow();

    // Negative control: the OLD argv shape does NOT reach JSON mode — proving the
    // discriminator can actually tell the two apart.
    const broken = ["transcript", "no-such-seat@scn-none", "--tail", "--json"];
    const rBroken = await runRig(broken, daemon.readEnv, RIG_BIN);
    let brokenIsJson = true;
    try { JSON.parse(rBroken.stdout); } catch { brokenIsJson = false; }
    expect(brokenIsJson).toBe(false);
  }, 60_000);
});
