import { expect, it } from "vitest";
import { viewerArgv, readOnlyTile } from "../src/domain/terminal/herdr-app-provider.js";
import { windowsTileAttachArgv, readWindowsTileAttachArgv } from "../src/domain/terminal/windows-tile-attach.js";
import { herdrAppSocketPath } from "../src/domain/terminal/herdr-app-transport.js";
import { localControlEndpoint } from "../src/domain/local-control-endpoint.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("uses the shared native attachment and keeps its identity/server while carrying the reveal gate", () => {
  const attachArgv = windowsTileAttachArgv("C:\\tools\\tmux.exe", ["-L", "selected"], "worker:one@rig", false);
  const gate = { path: "C:\\owned\\gate.shown", until: 4_000_000_000, expired: "The view was not shown" };
  const viewer = viewerArgv({ attachArgv, paneCommand: "unused", readOnly: false }, "owned-nonce", gate, "win32");
  expect(viewer[0]).toBe(process.execPath);
  expect(viewer[2]).toBe("owned-nonce");
  const data = JSON.parse(Buffer.from(viewer[3]!, "base64").toString("utf8"));
  expect(readWindowsTileAttachArgv(data.argv)).toMatchObject({ tmux: "C:\\tools\\tmux.exe", server: ["-L", "selected"], session: "worker:one@rig", readOnly: false, gate });
  expect(readWindowsTileAttachArgv(readOnlyTile(attachArgv)!)).toMatchObject({ readOnly: true, session: "worker:one@rig" });
  expect(viewer.join(" ")).not.toContain("/bin/sh");
  const closed = viewerArgv({ attachArgv, paneCommand: "unused", readOnly: false }, "owned-nonce", undefined, "win32");
  expect(JSON.parse(Buffer.from(closed[3]!, "base64").toString("utf8")).argv).toBeNull();
});

it.runIf(process.platform === "win32")("shares named-pipe identity resolution and honors the app's explicit endpoint", () => {
  const home = mkdtempSync(join(tmpdir(), "ha-native-"));
  try {
    expect(herdrAppSocketPath(home, {}, "win32")).toBe(localControlEndpoint(join(home, "herdr-app.sock"), "win32", "herdr-app"));
    expect(herdrAppSocketPath(home, { HERDR_APP_SOCKET: "\\\\.\\pipe\\owned-app" }, "win32")).toBe("\\\\.\\pipe\\owned-app");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
