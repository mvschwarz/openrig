// `rig snapshot list` padded Kind to 8 characters, so an auto-pre-down snapshot (made by every rig down) pushed its
// Status and Created out from under their headings. Each column now fits its widest value.
import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { snapshotCommand } from "../src/commands/snapshot.js";
import type { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

const RIG_ID = "01M5FH6C2XEGA4B56J40RF9Q2G";

function lifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "t.sqlite", startedAt: "2026-10-21T00:00:00Z" }) : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

describe("rig snapshot list columns", () => {
  it("keeps every column under its heading when a kind is wider than 'Kind'", async () => {
    const client = {
      get: vi.fn(async (path: string) => path.startsWith("/api/rigs/summary")
        ? { status: 200, data: [{ id: RIG_ID, name: "solo", archivedAt: null }] }
        : { status: 200, data: [
          { id: "01M5FH6F8XV2FEEQDHCGKF3TFA", kind: "auto-pre-down", status: "complete", createdAt: "2026-10-21 15:27:38" },
          { id: "01M5FH6EW20ZB9HFA3QWQT577B", kind: "manual", status: "incomplete", createdAt: "2026-10-21 15:27:37" },
        ] }),
    };
    const deps: StatusDeps = { lifecycleDeps: lifecycleDeps(), clientFactory: () => client as unknown as DaemonClient };
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    try {
      const program = new Command();
      program.exitOverride();
      program.addCommand(snapshotCommand(deps));
      await program.parseAsync(["node", "rig", "snapshot", "list", "solo"]);
    } finally {
      log.mockRestore();
    }

    const [header, ...rows] = lines;
    expect(rows).toHaveLength(2);
    const at = (title: string) => header!.indexOf(title);
    for (const [row, kind, status, created] of [
      [rows[0]!, "auto-pre-down", "complete", "2026-10-21 15:27:38"],
      [rows[1]!, "manual", "incomplete", "2026-10-21 15:27:37"],
    ] as const) {
      expect(row.indexOf(kind)).toBe(at("Kind"));
      expect(row.indexOf(status)).toBe(at("Status"));
      expect(row.indexOf(created)).toBe(at("Created"));
      expect(row.startsWith("01M5FH6")).toBe(true);
    }
  });
});
