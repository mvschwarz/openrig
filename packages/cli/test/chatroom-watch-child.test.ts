import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

it("binds the paired child to the selected instance before importing the CLI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-watch-child-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    // Execute the actual entry source with only the CLI implementation replaced
    // by a recorder. No daemon, terminal session or SSE connection is started.
    fs.copyFileSync(new URL("../src/chatroom-watch-child.ts", import.meta.url), path.join(root, "child.js"));
    fs.writeFileSync(path.join(root, "index.js"), 'console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.OPENRIG_HOME,url:process.env.OPENRIG_URL,legacyHome:process.env.RIGGED_HOME,legacyUrl:process.env.RIGGED_URL}));');
    const home = path.join(root, "selected home 用户"), url = "http://127.0.0.1:17439", rig = "owned|用户 O'Brien $(literal)";
    const result = spawnSync(process.execPath, [path.join(root, "child.js"), home, url, rig], {
      env: { ...process.env, OPENRIG_HOME: "wrong-home", OPENRIG_URL: "http://127.0.0.1:1", RIGGED_HOME: "wrong-legacy", RIGGED_URL: "http://127.0.0.1:2" },
      encoding: "utf8", timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args: ["chatroom", "watch", "--", rig], home, url });
  } finally {
    const resolved = fs.realpathSync(root);
    if (!path.isAbsolute(resolved) || !path.basename(resolved).startsWith("openrig-watch-child-")) throw new Error("Unexpected owned root");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
