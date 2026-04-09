import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_OPENRIG_HOME = process.env.OPENRIG_HOME;
const ORIGINAL_RIGGED_HOME = process.env.RIGGED_HOME;

afterEach(() => {
  if (ORIGINAL_OPENRIG_HOME === undefined) delete process.env.OPENRIG_HOME;
  else process.env.OPENRIG_HOME = ORIGINAL_OPENRIG_HOME;

  if (ORIGINAL_RIGGED_HOME === undefined) delete process.env.RIGGED_HOME;
  else process.env.RIGGED_HOME = ORIGINAL_RIGGED_HOME;

  vi.resetModules();
  vi.restoreAllMocks();
});

describe("openrig-compat", () => {
  it("getOpenRigHome prefers OPENRIG_HOME when set", async () => {
    process.env.OPENRIG_HOME = "/tmp/custom-openrig-home";
    delete process.env.RIGGED_HOME;

    const mod = await import("../src/openrig-compat.js");

    expect(mod.getOpenRigHome()).toBe("/tmp/custom-openrig-home");
    expect(mod.getDefaultOpenRigPath("daemon.json")).toBe("/tmp/custom-openrig-home/daemon.json");
  });

  it("getOpenRigHome falls back to RIGGED_HOME with warning", async () => {
    delete process.env.OPENRIG_HOME;
    process.env.RIGGED_HOME = "/tmp/legacy-rigged-home";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mod = await import("../src/openrig-compat.js");

    expect(mod.getOpenRigHome()).toBe("/tmp/legacy-rigged-home");
    expect(warnSpy).toHaveBeenCalledWith(
      "Warning: RIGGED_HOME is deprecated; use OPENRIG_HOME instead.",
    );
  });
});
