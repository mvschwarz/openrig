// REGISTRY I4 — the socket "commands" OBSERVE query: one serialized projection of the
// ONE registry with LIVE availability. Parity: socket rows == registry entries == the
// I2 dump's data contract (one source, derived surfaces).
import { describe, it, expect } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createControlSocket } from "../src/socket-server.js";
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import { COMMAND_REGISTRY, serializeCommands } from "../src/commands/registry.js";

async function query(sockPath: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath, () => conn.write(line + "\n"));
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) { conn.end(); resolve(JSON.parse(buf.slice(0, buf.indexOf("\n")))); }
    });
    conn.on("error", reject);
  });
}

describe("socket commands query (I4)", () => {
  it("returns the full registry projection with live availability; parity with the one source", async () => {
    const view = createViewState({ instanceId: "i4", getSnapshot: () => demoSnapshot() });
    const sockPath = path.join(os.tmpdir(), `t-i4-${process.pid}.sock`);
    const sock = await createControlSocket({ socketPath: sockPath, view });
    try {
      const res = (await query(sockPath, "commands")) as { ok: boolean; commands: Array<{ name: string; available: boolean; context: string }> };
      expect(res.ok).toBe(true);
      expect(res.commands.length).toBe(COMMAND_REGISTRY.length); // every entry, none hidden
      expect(res.commands.every((c) => typeof c.available === "boolean" && c.context.length > 0)).toBe(true);
      expect(res.commands.find((c) => c.name === "help")!.available).toBe(true); // always-context
      // parity with the serializer (the ONE projection — byte-deep equality)
      expect(res.commands).toEqual(JSON.parse(JSON.stringify(serializeCommands("standard"))));
    } finally {
      await sock.close();
    }
  });
});
