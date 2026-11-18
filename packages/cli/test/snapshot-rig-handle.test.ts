import { describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { snapshotRigIds } from "../src/snapshot-rig-handle.js";

describe("snapshot rig identities", () => {
  it("includes archived-only names and every same-name identity", async () => {
    const client = new DaemonClient("http://fixture");
    const get = vi.spyOn(client, "get").mockResolvedValue({ status: 200, data: [
      { id: "old", name: "lab", archivedAt: "2026-11-18" },
      { id: "new", name: "lab", archivedAt: null },
      { id: "other", name: "different", archivedAt: null },
    ] });
    expect(await snapshotRigIds(client, "lab")).toEqual({ ids: ["old", "new"], known: true });
    expect(get).toHaveBeenCalledWith("/api/rigs/summary?includeArchived=true");
    get.mockResolvedValue({ status: 200, data: [{ id: "old", name: "lab", archivedAt: "2026-11-18" }] });
    expect(await snapshotRigIds(client, "lab")).toEqual({ ids: ["old"], known: true });
  });

  it("gives an exact id precedence over another rig's name", async () => {
    const client = new DaemonClient("http://fixture");
    vi.spyOn(client, "get").mockResolvedValue({ status: 200, data: [
      { id: "old", name: "lab" }, { id: "new", name: "old" },
    ] });
    expect(await snapshotRigIds(client, "old")).toEqual({ ids: ["old"], known: true });
  });

  it("preserves the exact-id route for deleted rigs and unavailable summaries", async () => {
    const client = new DaemonClient("http://fixture");
    const get = vi.spyOn(client, "get").mockResolvedValue({ status: 200, data: [] });
    expect(await snapshotRigIds(client, "gone")).toEqual({ ids: ["gone"], known: false });
    get.mockResolvedValue({ status: 503, data: {} });
    expect(await snapshotRigIds(client, "gone")).toEqual({ ids: ["gone"], known: true });
    get.mockRejectedValue(new Error("connection refused"));
    expect(await snapshotRigIds(client, "gone")).toEqual({ ids: ["gone"], known: true });
  });
});
