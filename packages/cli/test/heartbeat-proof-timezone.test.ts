import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { heartbeatCommand } from "../src/commands/heartbeat.js";

it.each(["UTC", "America/New_York"])("orders zone-less UTC proof notes consistently under %s", async (timezone) => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = timezone;
  const root = mkdtempSync(join(tmpdir(), "heartbeat-proof-zone-"));
  const directory = join(root, "rigs", "alpha", "state", "dev"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "impl.queue.md"), ["---", "doc: fixture", "---", "", "---", "id: task", "state: in-progress",
    "ts-created: 2026-04-24T08:00:00Z", "---", "", "### Task", "", "**State transitions:**",
    "- 2026-04-24T08:00:00Z - in-progress",
    "- 2026-04-24T09:00:00 - in-progress; proof: updated `old.md`",
    "- 2026-04-24T11:30:00Z - in-progress; proof: updated `recent.md`"].join("\n"));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await heartbeatCommand({ sharedDocsRoot: root, now: () => new Date("2026-04-24T12:00:00Z") })
      .parseAsync(["node", "rig", "--json"]);
    const report = JSON.parse(String(log.mock.calls[0]![0]));
    expect(report.items[0]).toMatchObject({ executionState: "proven-active", lastProof: { path: "recent.md", ageSeconds: 1800 } });
    expect(report.summary).toMatchObject({ total: 1, provenActive: 1, stalled: 0 });
  } finally {
    log.mockRestore(); rmSync(root, { recursive: true, force: true });
    if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
  }
});
