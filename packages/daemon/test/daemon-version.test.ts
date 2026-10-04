import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { getDaemonVersion } from "../src/domain/daemon-version.js";

const stamp = vi.hoisted(() => ({ semver: null as string | null }));
vi.mock("../src/build-info.js", () => ({ BUILD_INFO: stamp }));

describe("daemon version", () => {
  beforeEach(() => { stamp.semver = null; });
  afterEach(() => { vi.restoreAllMocks(); });

  it("uses the packaged stamp when daemon/package.json is absent", () => {
    stamp.semver = "9.8.7";
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("ENOENT"); });
    expect(getDaemonVersion()).toBe("9.8.7");
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the package version at call time for an unstamped development run", () => {
    const read = vi.spyOn(fs, "readFileSync").mockReturnValueOnce('{"version":"1.2.3"}').mockReturnValueOnce('{"version":"1.2.4"}');
    expect(getDaemonVersion()).toBe("1.2.3");
    expect(getDaemonVersion()).toBe("1.2.4");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(["not-json", '{"version":42}', "{}"])("keeps unknown when neither source provides a version: %s", text => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(text);
    expect(getDaemonVersion()).toBe("unknown");
  });

  it("keeps unknown when an unstamped development package cannot be read", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("ENOENT"); });
    expect(getDaemonVersion()).toBe("unknown");
  });
});
