import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLibrarySpec } from "../src/commands/specs.js";
import type { DaemonClient } from "../src/client.js";

const starter = { id: "starter-id", kind: "rig", name: "starter", sourceType: "builtin", sourcePath: "/builtin/starter/rig.yaml" };
const clientFor = (entries: object[]) => ({ get: vi.fn(async () => ({ status: 200, data: entries })) }) as unknown as DaemonClient;
afterEach(() => vi.restoreAllMocks());

describe("first-project compatibility alias", () => {
  it("keeps same-name user and built-in specs ambiguous when both are visible", async () => {
    const user = { ...starter, id: "user-id", sourceType: "user_file" };
    await expect(resolveLibrarySpec(clientFor([starter, user]), "starter", { kind: "rig" })).rejects.toThrow("ambiguous");
  });
  it("finds an explicitly requested hidden built-in without shadowing a visible user spec", async () => {
    const user = { ...starter, id: "user-id", sourceType: "user_file" };
    const get = vi.fn(async (url: string) => ({ status: 200, data: url.includes("include_builtins=true") ? [starter, user] : [user] }));
    const client = { get } as unknown as DaemonClient;
    expect(await resolveLibrarySpec(client, "starter", { kind: "rig" })).toEqual(user);
    expect(await resolveLibrarySpec(client, "starter-id", { kind: "rig" })).toEqual(starter);
    expect(get).toHaveBeenCalledWith("/api/specs/library?kind=rig&include_builtins=true");
  });
  it("prefers a hidden exact ID over a visible spec with that name", async () => {
    const user = { ...starter, id: "user-id", name: "starter-id", sourceType: "user_file" };
    const get = vi.fn(async (url: string) => ({ status: 200, data: url.includes("include_builtins=true") ? [starter, user] : [user] }));
    expect(await resolveLibrarySpec({ get } as unknown as DaemonClient, "starter-id")).toEqual(starter);
  });
  it("resolves the built-in starter without creating a second library entry, with a stderr notice", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await resolveLibrarySpec(clientFor([starter]), "first-project", { kind: "rig" })).toEqual(starter);
    expect(stderr).toHaveBeenCalledWith("first-project is now starter (a Claude builder and a Codex reviewer); on a Codex-only machine, ask your OpenRig operator to adapt it");
    expect(stdout).not.toHaveBeenCalled();
  });
  it.each(["builtin", "user_file"])("preserves an exact %s first-project name", async (sourceType) => {
    const original = { ...starter, id: "original", name: "first-project", sourceType };
    expect(await resolveLibrarySpec(clientFor([starter, original]), "first-project", { kind: "rig" })).toEqual(original);
  });
  it("preserves an exact ID ahead of the alias", async () => {
    const original = { ...starter, id: "first-project", name: "custom" };
    expect(await resolveLibrarySpec(clientFor([starter, original]), "first-project")).toEqual(original);
  });
  it("does not treat a user spec named starter as the compatibility target", async () => {
    await expect(resolveLibrarySpec(clientFor([{ ...starter, sourceType: "user_file" }]), "first-project")).rejects.toThrow("not found");
  });
  it("does not alias workflow requests or ambiguous built-ins", async () => {
    await expect(resolveLibrarySpec(clientFor([starter]), "first-project", { kind: "workflow" })).rejects.toThrow("not found");
    await expect(resolveLibrarySpec(clientFor([starter, { ...starter, id: "second" }]), "first-project")).rejects.toThrow("ambiguous");
  });
});
