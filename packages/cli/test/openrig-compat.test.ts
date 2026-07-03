import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

describe("OPR.0.4.3.12 — isFixtureScopedHome (path-only predicate)", () => {
  const created: string[] = [];
  afterEach(() => {
    while (created.length) {
      const dir = created.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true for a home containing the .openrig-fixture sentinel marker", async () => {
    const { isFixtureScopedHome, FIXTURE_HOME_MARKER } = await import("../src/openrig-compat.js");
    // A marker in an ARBITRARY (non-temp-convention) dir still counts — the
    // explicit sentinel is the most-honest signal and is location-independent.
    const dir = mkdtempSync(join(homedir(), ".openrig-compat-test-"));
    created.push(dir);
    writeFileSync(join(dir, FIXTURE_HOME_MARKER), "");
    expect(isFixtureScopedHome(dir)).toBe(true);
  });

  it("true for an openrig-qa* home under a temp root (no marker needed)", async () => {
    const { isFixtureScopedHome } = await import("../src/openrig-compat.js");
    expect(isFixtureScopedHome(join(tmpdir(), "openrig-qa-abc123-home"))).toBe(true);
    expect(isFixtureScopedHome("/tmp/openrig-qa-run-xyz")).toBe(true);
  });

  it("false for the real default home (~/.openrig)", async () => {
    const { isFixtureScopedHome } = await import("../src/openrig-compat.js");
    expect(isFixtureScopedHome(join(homedir(), ".openrig"))).toBe(false);
  });

  it("false for a plain temp home that is not an openrig-qa fixture and has no marker", async () => {
    const { isFixtureScopedHome } = await import("../src/openrig-compat.js");
    const dir = mkdtempSync(join(tmpdir(), "plain-home-"));
    created.push(dir);
    expect(isFixtureScopedHome(dir)).toBe(false);
  });

  it("false for an openrig-qa-named path OUTSIDE any temp root (no marker)", async () => {
    const { isFixtureScopedHome } = await import("../src/openrig-compat.js");
    // Name alone is not enough — must be under a temp root OR carry the marker.
    expect(isFixtureScopedHome(join(homedir(), "openrig-qa-not-a-fixture"))).toBe(false);
  });

  it("false for an empty string", async () => {
    const { isFixtureScopedHome } = await import("../src/openrig-compat.js");
    expect(isFixtureScopedHome("")).toBe(false);
  });
});
