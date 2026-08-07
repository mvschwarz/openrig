import { describe, it, expect } from "vitest";
import { resolveDaemonDbPath } from "../src/daemon-db-path.js";

describe("resolveDaemonDbPath — D15: db derives from OPENRIG_HOME, never CWD-relative", () => {
  it("derives the db under OPENRIG_HOME when OPENRIG_DB is unset — NOT a bare CWD-relative filename", () => {
    const p = resolveDaemonDbPath(undefined, "/scratch/home");
    // The tonight incident: a bare 'openrig.sqlite' resolved against the process
    // CWD -> could land on the SHARED fleet db. The default must be home-anchored.
    expect(p).toBe("/scratch/home/openrig.sqlite");
    expect(p).not.toBe("openrig.sqlite");
    expect(p.startsWith("/")).toBe(true); // absolute, CWD-independent
  });

  it("isolates two daemons with different OPENRIG_HOME even from the same CWD", () => {
    expect(resolveDaemonDbPath(undefined, "/tmp/iso-a")).toBe("/tmp/iso-a/openrig.sqlite");
    expect(resolveDaemonDbPath(undefined, "/home/fleet")).toBe("/home/fleet/openrig.sqlite");
  });

  it("honors an explicit OPENRIG_DB path verbatim", () => {
    expect(resolveDaemonDbPath("/iso/custom.sqlite", "/scratch/home")).toBe("/iso/custom.sqlite");
  });

  it("treats an empty OPENRIG_DB as unset (falls back to home-anchored default)", () => {
    expect(resolveDaemonDbPath("", "/scratch/home")).toBe("/scratch/home/openrig.sqlite");
  });
});
