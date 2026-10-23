import { describe, expect, it } from "vitest";
import { seatGuidance } from "../src/domain/restore-guidance.js";
import type { NodeStartupSnapshot } from "../src/domain/types.js";

// Restore rebuilds missing managed blocks from a seat's SAVED projection selection. Selections saved before the per-seat
// role id became `rig-role` still say `role`; neither may put one seat's role into the shared guidance file.
describe("restore leaves a seat's own role out of shared guidance", () => {
  const guidance = (effectiveId: string, absolutePath: string) =>
    ({ category: "guidance", mergeStrategy: "managed_block", effectiveId, absolutePath, resourcePath: absolutePath });
  const items = (runtime: string, entries: ReturnType<typeof guidance>[]) => seatGuidance(
    { runtime, projectionEntries: entries, resolvedStartupFiles: [] } as unknown as NodeStartupSnapshot,
    "/team", null, () => true, () => "",
  )?.items.map((item) => `${item.blockId} ${item.sourcePath}`);

  it.each(["claude-code", "codex"])("%s: a legacy `role` or a `rig-role` of the agent's own role file is left out; shared guidance stays", (runtime) => {
    expect(items(runtime, [
      guidance("role", "/specs/agents/analyst/guidance/role.md"),
      guidance("rig-role", "/specs/agents/scout/guidance/role.md"),
      guidance("culture", "/specs/rig/guidance/culture.md"),
    ])).toEqual(["culture /specs/rig/guidance/culture.md"]);
    // A shared block that is also named role, from another file, is still put back.
    expect(items(runtime, [guidance("role", "/specs/rig/guidance/team-role.md")])).toEqual(["role /specs/rig/guidance/team-role.md"]);
  });

  it.each(["claude-code", "codex"])("%s: an auto startup file that is a seat's own role is left out, readable or not; other guidance stays", (runtime) => {
    const startup = (path: string, absolutePath: string, orientation?: "role") => ({
      path, absolutePath, ownerRoot: "/specs", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"], ...(orientation ? { orientation } : {}),
    });
    const files = [
      startup("guidance/role.md", "/specs/agents/impl/guidance/role.md"),
      startup("roles/lead.md", "/specs/agents/lead/roles/lead.md", "role"),
      startup("guidance/team.md", "/specs/rig/guidance/team.md"),
    ];
    for (const unreadable of [false, true]) {
      const read = (p: string) => { if (unreadable && p.includes("/agents/")) throw new Error(`ENOENT: ${p}`); return "# text"; };
      const restored = seatGuidance({ runtime, projectionEntries: [], resolvedStartupFiles: files } as unknown as NodeStartupSnapshot, "/team", null, () => true, read);
      expect(restored?.items.map((item) => item.blockId)).toEqual(["guidance/team.md"]);
    }
  });
});
