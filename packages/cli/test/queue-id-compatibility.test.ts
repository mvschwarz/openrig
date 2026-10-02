import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";
import { computeLintWarnings } from "../../ui/src/components/progress/priority-rail-rule.js";
import { shortQitemTail } from "../../ui/src/lib/activity-visuals.js";

vi.mock("../src/daemon-lifecycle.js", () => ({
  getDaemonStatus: async () => ({ state: "running", healthy: true, port: 12345 }),
  getDaemonUrl: () => "http://queue.invalid",
  daemonStatusGuard: vi.fn(),
}));

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it("preallocates timestamp/64-bit-hex IDs recognized by the existing lint, sort and last-eight consumers", async () => {
  vi.stubEnv("OPENRIG_SESSION_NAME", "writer@fixture");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  const ids: string[] = [];
  const deps: QueueDeps = {
    lifecycleDeps: {} as never,
    clientFactory: () => ({ post: async (_path: string, body: { qitemId: string }) => {
      ids.push(body.qitemId);
      return { status: 201, data: body };
    } }) as never,
  };
  for (const time of ["2026-10-02T07:00:00Z", "2026-10-02T07:00:01Z"]) {
    vi.setSystemTime(new Date(time));
    const program = new Command().addCommand(queueCommand(deps));
    await program.parseAsync(["node", "rig", "queue", "create", "--destination", "reader@fixture", "--body", "whole body", "--summary", "Work", "--json"]);
  }
  expect.soft(ids[0]).toMatch(/^qitem-20261002070000-[0-9a-f]{16,}$/);
  expect.soft(ids[1]).toMatch(/^qitem-20261002070001-[0-9a-f]{16,}$/);
  const file = {
    rootName: "fixture", relPath: "PROGRESS.md", absolutePath: "/fixture/PROGRESS.md", mtime: "2026-10-02", title: null,
    counts: { total: 1, done: 0, blocked: 0, active: 1 },
    rows: [{ line: 1, depth: 0, kind: "checkbox" as const, status: "active" as const, text: ids[0]! }],
  };
  expect.soft(computeLintWarnings(file, false).some((w) => w.ruleId === "qitem-no-label")).toBe(true);
  expect.soft(shortQitemTail(ids[0]!)).toBe(ids[0]!.slice(-8));
  // Both scope consumers fall back to descending ID order without timestamps.
  expect.soft([...ids].sort((a, b) => a < b ? 1 : a > b ? -1 : 0)).toEqual([ids[1], ids[0]]);
});
