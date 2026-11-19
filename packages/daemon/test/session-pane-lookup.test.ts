import { expect, it, vi } from "vitest";
import { listNamedSessionPanes } from "../src/adapters/session-pane-lookup.js";
import { observeSolePane } from "../src/domain/pane-binding-observation.js";

it("uses the named-session contract for binding observation instead of parsing a colon", async () => {
  const listPanes = vi.fn(async () => { throw new Error("Ambiguous target API must not be used"); });
  const listSessionPanes = vi.fn(async () => [{ id: "owned-pane" }] as never);
  const adapter = { listPanes, listSessionPanes };
  expect(await observeSolePane(adapter, "owned:logical")).toEqual({ ok: true, pane: "owned-pane" });
  expect(listSessionPanes).toHaveBeenCalledExactlyOnceWith("owned:logical", false); expect(listPanes).not.toHaveBeenCalled();
});
it("retains the old injected adapter contract and all-windows option", async () => {
  const listPanes = vi.fn(async () => []);
  expect(await listNamedSessionPanes({ listPanes }, "owned:logical", true)).toEqual([]);
  expect(listPanes).toHaveBeenCalledExactlyOnceWith("owned:logical", true);
});
