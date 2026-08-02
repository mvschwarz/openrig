import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createViewState } from "../src/state.js";
import { createControlSocket, defaultSocketPath, MAX_SOCKET_PATH_BYTES } from "../src/socket-server.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { ControlSocket } from "../src/socket-server.js";

const snap = demoSnapshot();
let open: ControlSocket | null = null;

afterEach(async () => {
  if (open) await open.close();
  open = null;
});

function shortSockPath(): string {
  return path.join(os.tmpdir(), `tui-t-${process.pid}-${Math.floor(Math.random() * 1e6)}.sock`);
}

function ask(sockPath: string, lines: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection({ path: sockPath });
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.split("\n").filter(Boolean).length >= lines.length) {
        conn.end();
        resolve(buf.split("\n").filter(Boolean));
      }
    });
    conn.on("error", reject);
    conn.on("connect", () => conn.write(lines.map((l) => l + "\n").join("")));
  });
}

describe("control-socket adapter (spike-adopted; arch boundary constraint)", () => {
  it("deep-links a named screen through the ONE resolver/mutation path and replies with structured state", async () => {
    const view = createViewState({ instanceId: "tui-sock", getSnapshot: () => snap });
    open = await createControlSocket({ socketPath: shortSockPath(), view });
    const [reply] = await ask(open.path, ["agent dev50.driver"]);
    const parsed = JSON.parse(reply!);
    expect(parsed.ok).toBe(true);
    expect(parsed.screen).toBe("topology");
    expect(parsed.drill).toEqual(["host:vm-host", "rig:openrig-build", "pod:dev50", "agent:dev50.driver"]);
    expect(view.get().drill.at(-1)).toEqual({ kind: "agent", name: "dev50.driver" });
  });

  it("answers a read-only state query (OBSERVE class)", async () => {
    const view = createViewState({ instanceId: "tui-sock", getSnapshot: () => snap });
    open = await createControlSocket({ socketPath: shortSockPath(), view });
    const [reply] = await ask(open.path, ["state"]);
    const parsed = JSON.parse(reply!);
    expect(parsed.instanceId).toBe("tui-sock");
    expect(parsed.state.screen).toBe("topology");
  });

  it("rejects non-grammar verbs with the grammar's NAMED error — the socket has NO verb surface beyond the one resolver (arch line 1+2)", async () => {
    const view = createViewState({ instanceId: "tui-sock", getSnapshot: () => snap });
    open = await createControlSocket({ socketPath: shortSockPath(), view });
    const [reply] = await ask(open.path, ["resolve item-42"]);
    const parsed = JSON.parse(reply!);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/unknown command "resolve"/);
    // and the state was NOT mutated by the rejected verb
    expect(view.get().section).toBe("topology");
    expect(view.get().drill).toEqual([]);
  });

  it("refuses socket paths beyond the sun_path limit with a named error", async () => {
    const view = createViewState({ instanceId: "tui-sock", getSnapshot: () => snap });
    const tooLong = path.join(os.tmpdir(), "x".repeat(MAX_SOCKET_PATH_BYTES + 1) + ".sock");
    await expect(createControlSocket({ socketPath: tooLong, view })).rejects.toThrow(/socket path too long/);
  });

  it("defaults the socket home to $OPENRIG_HOME/run (herdr-style convention) and stays under the limit", () => {
    const p = defaultSocketPath("tui-1");
    expect(p).toMatch(/[/\\]run[/\\]tui-tui-1\.sock$/);
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
  });
});
