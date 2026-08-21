// B1 Atom D — `rig crash-cart restore-fleet` drives the daemon-side conductor
// (POST /api/crash-cart/restore-fleet) and renders the FleetRollup. The client is
// injected so the drive is tested without a live daemon; the full flow is door-tested.
import { describe, it, expect } from "vitest";
import { crashCartCommand } from "../src/commands/crash-cart.js";
import type { DaemonClient } from "../src/client.js";

function mockClient(response: { status: number; data: unknown }): DaemonClient {
  return { post: async () => response } as unknown as DaemonClient;
}

describe("rig crash-cart restore-fleet", () => {
  it("renders verdict + per-rig outcomes + triage (human form)", async () => {
    const lines: string[] = [];
    const cmd = crashCartCommand({
      emit: async () => ({ state: "up" }),
      write: (l) => lines.push(l),
      getRestoreClient: async () =>
        mockClient({
          status: 200,
          data: {
            verdict: "mixed",
            rollup: {
              counts: { fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 1 },
              sequence: [
                { rigId: "kernel", outcome: "fully_restored" },
                { rigId: "alpha", outcome: "not_attempted" },
              ],
              attention_required: [{ rigId: "alpha", seat: "dev.guard", need: "codex auth" }],
            },
          },
        }),
    });
    await cmd.parseAsync(["restore-fleet"], { from: "user" });
    const out = lines.join("\n");
    expect(out).toContain("Fleet restore: mixed");
    expect(out).toContain("kernel: fully_restored");
    expect(out).toContain("alpha: not_attempted");
    expect(out).toContain("dev.guard — codex auth");
  });

  it("--json emits the raw rollup + verdict", async () => {
    const lines: string[] = [];
    const cmd = crashCartCommand({
      emit: async () => ({ state: "up" }),
      write: (l) => lines.push(l),
      getRestoreClient: async () =>
        mockClient({ status: 200, data: { verdict: "all_fully_restored", rollup: { counts: {}, sequence: [], attention_required: [] } } }),
    });
    await cmd.parseAsync(["restore-fleet", "--json"], { from: "user" });
    expect(JSON.parse(lines[0]!).verdict).toBe("all_fully_restored");
  });

  it("fail-closed: no client (daemon not up) → exit 1, no output", async () => {
    const lines: string[] = [];
    const cmd = crashCartCommand({
      emit: async () => ({ state: "down" }),
      write: (l) => lines.push(l),
      getRestoreClient: async () => null,
    });
    process.exitCode = 0;
    await cmd.parseAsync(["restore-fleet"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(lines).toEqual([]);
    process.exitCode = 0;
  });
});
