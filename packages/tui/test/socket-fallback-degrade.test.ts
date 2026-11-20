// A failure to bind the primary control socket must not cost the operator the TUI.
//
// The fallback used to trigger on EADDRINUSE alone. Any other bind failure — a directory the process
// may not create in, a path longer than the platform allows — propagated out of createControlSocket,
// which main.ts awaits unguarded, so the launcher exited. Here the primary path is made unusable in a
// way that fails the bind, and the adapter is expected to come up on its independent endpoint.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createControlSocket, MAX_SOCKET_PATH_BYTES } from "../src/socket-server.js";
import { demoSnapshot } from "../src/demo-data.js";
import { createViewState } from "../src/state.js";
import type { ControlSocket } from "../src/socket-server.js";

const snap = demoSnapshot();
let open: ControlSocket | null = null;

afterEach(async () => {
  if (open) await open.close();
  open = null;
});

function view() {
  return createViewState({ instanceId: "tui-sock-degrade", getSnapshot: () => snap });
}

describe("control-socket fallback", () => {
  it("comes up on an independent endpoint when the primary path cannot be bound", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t-"));
    try {
      // A directory where the socket would be: the bind fails with EADDRINUSE and nothing else does,
      // so the fallback's endpoint in the same directory is free. The blocked-parent shape belongs to
      // the both-fail test below, where both attempts share that parent and neither can bind.
      const primary = path.join(root, "tui-taken.sock");
      fs.mkdirSync(primary);
      if (process.platform === "win32") {
        // Every AF_UNIX bind fails with EACCES on the hosts measured so far, so there is no endpoint to
        // come up on here; the both-fail test covers what the adapter says instead.
        await expect(createControlSocket({ socketPath: primary, view: view(), fallbackOnCollision: true }))
          .rejects.toThrow(/could not bind a TUI control socket/);
        return;
      }
      open = await createControlSocket({ socketPath: primary, view: view(), fallbackOnCollision: true });
      expect(open.path).not.toBe(primary);
      expect(open.path.startsWith(root)).toBe(true);
      expect(fs.statSync(open.path).isSocket()).toBe(true);
      expect(Buffer.byteLength(open.path)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("tries the shorter endpoint when the path itself is too long", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t-"));
    try {
      // Over MAX_SOCKET_PATH_BYTES, in a short writable directory: the length refusal carries
      // ENAMETOOLONG, so the fallback runs and its shortened name fits. On a host that cannot bind a
      // socket at all the attempt fails instead, and the branch below says what that failure must be.
      const primary = path.join(root, `${"l".repeat(120)}.sock`);
      const outcome = await createControlSocket({ socketPath: primary, view: view(), fallbackOnCollision: true }).then(
        (socket) => ({ ok: true as const, socket }),
        (error: Error) => ({ ok: false as const, error }),
      );
      // Assertions stay outside the promise so a failed one cannot read as an expected rejection.
      if (outcome.ok) {
        open = outcome.socket;
        expect(open.path).not.toBe(primary);
        expect(open.path.startsWith(root)).toBe(true);
        expect(Buffer.byteLength(open.path)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
      } else {
        expect(outcome.error.message).not.toMatch(/socket path too long/);
        expect(outcome.error.message).toMatch(/could not bind a TUI control socket/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports both failures by name when no endpoint can be bound", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t-"));
    try {
      // A regular file two levels up, so mkdirSync(recursive) on the socket's parent fails with
      // ENOTDIR and the alternate endpoint in the same folder fails the same way. This function
      // throws; what the launcher does with that throw is main.ts's call, and
      // control-socket-absent.test.ts covers it: the TUI starts without a control socket and says what
      // that costs.
      const blocked = path.join(root, "file");
      fs.writeFileSync(blocked, "not a directory\n");
      const primary = path.join(blocked, "sub", "tui.sock");
      await expect(createControlSocket({ socketPath: primary, view: view(), fallbackOnCollision: true }))
        .rejects.toThrow(/could not bind a TUI control socket/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
