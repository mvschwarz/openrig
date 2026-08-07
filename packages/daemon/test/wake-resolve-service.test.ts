import { describe, it, expect, vi } from "vitest";
import { WakeResolveService } from "../src/domain/wake-resolve-service.js";
import type { WakeSessionRow } from "../src/domain/wake-resolver.js";

function row(id: number, token: string | null, runtime = "claude-code"): WakeSessionRow {
  return { id, sessionName: "dev-planner@my-rig", resumeToken: token, runtime, createdAt: `t${id}` };
}

describe("WakeResolveService — L3b route service (query + resolve)", () => {
  it("queries sessions for the seat (newest-first) and resolves the newest token", () => {
    const listSessionsBySeat = vi.fn((seat: string): WakeSessionRow[] =>
      seat === "dev-planner@my-rig" ? [row(2, "tok2"), row(1, "tok1")] : [],
    );
    const svc = new WakeResolveService({ listSessionsBySeat });
    const res = svc.resolve("dev-planner@my-rig");
    expect(listSessionsBySeat).toHaveBeenCalledWith("dev-planner@my-rig");
    expect(res.resolved).toBe(true);
    if (res.resolved) {
      expect(res.token).toBe("tok2");
      expect(res.runtime).toBe("claude"); // claude-code maps to claude
    }
  });

  it("maps a codex runtime through", () => {
    const svc = new WakeResolveService({ listSessionsBySeat: () => [row(1, "tok", "codex")] });
    const res = svc.resolve("dev-planner@my-rig");
    expect(res.resolved && res.runtime).toBe("codex");
  });

  it("refuses an unknown seat with an empty teaching listing", () => {
    const svc = new WakeResolveService({ listSessionsBySeat: () => [] });
    const res = svc.resolve("ghost@my-rig");
    expect(res.resolved).toBe(false);
    if (!res.resolved) expect(res.known).toHaveLength(0);
  });

  it("passes an explicit generation through to the resolver", () => {
    const svc = new WakeResolveService({ listSessionsBySeat: () => [row(2, "tok2"), row(1, "tok1")] });
    const res = svc.resolve("dev-planner@my-rig", 2);
    expect(res.resolved && res.token).toBe("tok1");
  });
});
