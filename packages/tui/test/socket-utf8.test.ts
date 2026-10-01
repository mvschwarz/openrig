import { describe, expect, it } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createViewState } from "../src/state.js";
import { createControlSocket } from "../src/socket-server.js";

async function sendSplit(socketPath: string, bytes: Buffer, split: number): Promise<string> {
  const client = net.createConnection(socketPath);
  client.setEncoding("utf8");
  try {
    await new Promise<void>((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
    const reply = new Promise<string>((resolve, reject) => {
      let text = "";
      client.on("data", (chunk) => { text += chunk; if (text.includes("\n")) resolve(text); });
      client.once("error", reject);
    });
    client.write(bytes.subarray(0, split));
    // Let the server consume the first network chunk before delivering the rest.
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.write(bytes.subarray(split));
    return await reply;
  } finally {
    client.destroy();
  }
}

describe("control socket UTF-8 stream", () => {
  it("preserves every split of multibyte command arguments over an actual socket", async () => {
    const view = createViewState({ instanceId: "utf8" });
    const directory = mkdtempSync(join(tmpdir(), "openrig-utf8-"));
    try {
      const control = await createControlSocket({ socketPath: join(directory, "control.sock"), view });
      const text = "工程🚀";
      const command = Buffer.from(`/${text}\n`);
      try {
        for (let split = Buffer.byteLength("/") + 1; split < command.length - 1; split++) {
          const reply = JSON.parse(await sendSplit(control.path, command, split));
          expect(reply.filter, `split byte ${split}`).toBe(text);
          expect(view.get().filter).toBe(text);
        }
      } finally {
        await control.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
