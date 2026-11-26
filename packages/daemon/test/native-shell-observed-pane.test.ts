import { expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";

it("uses observed pane metadata but keeps the managed identity for every native nested write", async () => {
  const identity = "owned-node", pane = "psmux:b3duZWQ6bG9naWNhbA:%1", checked: string[] = [];
  const guard = {
    attachInputInspection() {}, maybeTarget: () => undefined,
    input: async (id: string, run: () => Promise<unknown>) => { expect(id).toBe(identity); checked.push(id); return run(); },
    target: () => ({ nodeId: identity, session: "owned:logical", occupant: "owned-generation", pane }),
    ownsLifecycle: () => false, needsInputCheck: () => false,
    checkInput: (id: string) => { expect(id).toBe(identity); checked.push(id); },
    noteSubmitted: (id: string) => { expect(id).toBe(identity); },
  } as unknown as SeatDeliveryGuard;
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell transport"); }, {
    tmpName: () => "C:/owned/launch.ps1", bufferName: () => "owned", writeFile: async () => {}, unlink: async () => {},
  }, undefined, [], "psmux");
  vi.spyOn(adapter, "listSessionPanes").mockResolvedValue([{ id: pane, index: 0, cwd: "C:/owned", width: 80, height: 24, active: true }]);
  const command = vi.spyOn(adapter, "getPaneCommand").mockImplementation(async target => target === pane ? "powershell.exe" : "unknown");
  const typed: string[] = [];
  vi.spyOn(adapter as never, "sendTextUnchecked" as never).mockImplementation((async (target: string, _text: string, before: () => void) => { before(); typed.push(target); return { ok: true }; }) as never);
  vi.spyOn(adapter as never, "sendKeysUnchecked" as never).mockImplementation((async (target: string) => { typed.push(target); return { ok: true }; }) as never);
  adapter.deliveryGuard = guard;
  const result = await adapter.sendShellCommand(identity, "synthetic command");
  expect(result, JSON.stringify(result)).toEqual({ ok: true });
  expect(command).toHaveBeenCalledExactlyOnceWith(pane); expect(typed).toEqual([pane, pane]);
  expect(checked.length).toBeGreaterThan(2); expect(new Set(checked)).toEqual(new Set([identity]));
});
