// The real createHerdrSocketRpc over a private unix socket. A UTF-8 reply split inside a
// multi-byte character must still parse to the exact original text.
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHerdrSocketRpc } from "../src/domain/terminal/herdr-transport.js";

const TEXT = "café 漢 😀";
const servers: net.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Serve one request, writing each reply part as a separate chunk. */
async function serve(reply: (req: { id: string }) => Buffer[]): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-"));
  dirs.push(dir);
  const socketPath = path.join(dir, "h.sock");
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", async (data) => {
      buf += data.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      for (const part of reply(JSON.parse(buf.slice(0, nl)))) {
        conn.write(part);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

const line = (id: string) => Buffer.from(`${JSON.stringify({ id, result: { type: "pane_output", text: TEXT } })}\n`);
const splitInside = (bytes: Buffer, char: string, into: number) => {
  const at = bytes.indexOf(Buffer.from(char)) + into;
  return [bytes.subarray(0, at), bytes.subarray(at)];
};

describe("herdr socket RPC keeps UTF-8 across chunk boundaries", () => {
  it.each([
    ["é", 2, 1],
    ["漢", 3, 1],
    ["漢", 3, 2],
    ["😀", 4, 1],
    ["😀", 4, 2],
    ["😀", 4, 3],
  ] as const)("a chunk boundary inside %s (%i bytes) at byte %i", async (char, _bytes, into) => {
    const socketPath = await serve((req) => splitInside(line(req.id), char, into));
    const rpc = createHerdrSocketRpc(socketPath, 2000);

    await expect(rpc({ id: "openrig-1", method: "pane.read", params: {} }))
      .resolves.toEqual({ type: "pane_output", text: TEXT });
  });

  it("still skips another id's line and matches this request's split reply", async () => {
    const socketPath = await serve((req) => {
      const other = Buffer.from(`${JSON.stringify({ id: "other", result: { type: "x", text: "no" } })}\n`);
      const [head, tail] = splitInside(line(req.id), "😀", 2);
      return [Buffer.concat([other, head!]), tail!];
    });
    const rpc = createHerdrSocketRpc(socketPath, 2000);

    await expect(rpc({ id: "openrig-1", method: "pane.read", params: {} }))
      .resolves.toEqual({ type: "pane_output", text: TEXT });
  });
});
