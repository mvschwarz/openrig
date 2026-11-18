import { describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { snapshotRigIds } from "../src/snapshot-rig-handle.js";

/** URL-aware mock: the summary read and per-id snapshot reads answer differently. */
function clientWith(rigs: Array<{ id: string; name: string }>, historyFor: Record<string, unknown[]> = {}) {
  const client = new DaemonClient("http://fixture");
  vi.spyOn(client, "get").mockImplementation(async (url: string) => {
    if (url === "/api/rigs/summary?includeArchived=true") return { status: 200, data: rigs };
    const id = decodeURIComponent(url.split("/api/rigs/")[1]?.split("/")[0] ?? "");
    return { status: 200, data: historyFor[id] ?? [] };
  });
  return client;
}

describe("snapshot rig identities", () => {
  it("includes archived-only names and every same-name identity", async () => {
    const client = clientWith([
      { id: "old", name: "lab", archivedAt: "2026-11-18" },
      { id: "new", name: "lab", archivedAt: null },
      { id: "other", name: "different", archivedAt: null },
    ]);
    expect(await snapshotRigIds(client, "lab")).toEqual({ ids: ["old", "new"], known: true });
    const single = clientWith([{ id: "old", name: "lab", archivedAt: "2026-11-18" }]);
    expect(await snapshotRigIds(single, "lab")).toEqual({ ids: ["old"], known: true });
  });

  it("retained history under a deleted rig's exact id outranks an archived rig of the same name", async () => {
    // "old" is an archived rig's NAME and also the exact id of a deleted rig
    // whose snapshots are still stored under that id: the id's history wins.
    const client = clientWith([{ id: "new", name: "old" }], { old: [{ id: "snap-1", kind: "manual" }] });
    expect(await snapshotRigIds(client, "old")).toEqual({ ids: ["old"], known: true });
  });

  it("an unreadable exact-id history read stops resolution instead of falling to the name", async () => {
    // "old" is an archived rig's NAME and possibly a deleted rig's id with
    // retained history; the history read 503s — the name match must NOT be
    // silently used, because it could be another rig's history.
    const client = new DaemonClient("http://fixture");
    vi.spyOn(client, "get").mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary?includeArchived=true") return { status: 200, data: [{ id: "new", name: "old" }] };
      return { status: 503, data: { error: "unavailable" } };
    });
    const outcome = await snapshotRigIds(client, "old");
    expect(outcome.unreadable).toContain("HTTP 503");
    // The ids stay available for the error report, but callers must stop.
  });

  it("a thrown exact-id history read stops resolution too", async () => {
    const client = new DaemonClient("http://fixture");
    vi.spyOn(client, "get").mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary?includeArchived=true") return { status: 200, data: [{ id: "new", name: "old" }] };
      throw new Error("socket hang up");
    });
    const outcome = await snapshotRigIds(client, "old");
    expect(outcome.unreadable).toContain("socket hang up");
  });

  it("a name match without retained id-history resolves the name", async () => {
    const client = clientWith([{ id: "new", name: "old" }]);
    expect(await snapshotRigIds(client, "old")).toEqual({ ids: ["new"], known: true });
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
