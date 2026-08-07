// PARITY FENCE: the published-daemon constants and the L3 runbook prose are two
// consumers of ONE procedure. A value changed in the module without the runbook
// following (or vice-versa) is a silent drift that would make the A/B arms
// measure different setups — this test makes that drift loud.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BIND_ENV, BIND_VALUE, BEARER_ENV, L3_HOST_PORT, CONTAINER_PORT,
  HEALTH_PATH, GUARDED_PROBE_PATH, publishArg, publishedDaemonEnv,
  TERMINAL_BEARER_ENV, rigReadEnv,
} from "./helpers/testbed-published-daemon.js";

const RUNBOOK = readFileSync(
  resolve(import.meta.dirname, "../../../docker/testbed/runbooks/L3-daemon-in-container.md"),
  "utf8",
);

describe("published-daemon procedure — module/runbook parity", () => {
  it("the runbook carries the explicit bind, the bearer env, and the explicit port", () => {
    expect(RUNBOOK).toContain(`${BIND_ENV}=${BIND_VALUE}`);
    expect(RUNBOOK).toContain(BEARER_ENV);
    expect(RUNBOOK).toContain(String(L3_HOST_PORT));
  });

  it("the runbook probes BOTH surfaces: unauthenticated health + a guarded route", () => {
    expect(RUNBOOK).toContain(HEALTH_PATH);
    expect(RUNBOOK).toContain(GUARDED_PROBE_PATH);
  });

  it("publishArg is unqualified (Apple resets on the loopback-qualified form) and refuses ephemeral 0", () => {
    expect(publishArg(L3_HOST_PORT)).toBe(`${L3_HOST_PORT}:${CONTAINER_PORT}`);
    expect(publishArg(L3_HOST_PORT)).not.toContain("127.0.0.1");
    expect(() => publishArg(0)).toThrow(/explicit positive integer/);
  });

  it("rig READS carry the TERMINAL token env — distinct name, same value under this procedure", () => {
    expect(TERMINAL_BEARER_ENV).toBe("OPENRIG_TERMINAL_BEARER_TOKEN");
    expect(TERMINAL_BEARER_ENV).not.toBe(BEARER_ENV); // separate concepts; coincide only via the non-trusted-bind copy
    expect(rigReadEnv("t", "http://127.0.0.1:19433")).toEqual({
      [TERMINAL_BEARER_ENV]: "t",
      OPENRIG_URL: "http://127.0.0.1:19433",
    });
    expect(() => rigReadEnv("", "http://x")).toThrow(/non-empty token/);
  });

  it("the runbook keeps the NEGATIVE CONTROL — the only assertion that the guard is armed", () => {
    // A null terminal token leaves the guarded route wide open (middleware passes
    // through), so an auth-probe-only runbook could go green while proving nothing.
    expect(RUNBOOK).toMatch(/NEGATIVE CONTROL/i);
    expect(RUNBOOK).toMatch(/401/);
  });

  it("the env helper refuses an empty bearer — the guard is satisfied, never weakened", () => {
    expect(publishedDaemonEnv("t")).toEqual({ [BIND_ENV]: BIND_VALUE, [BEARER_ENV]: "t" });
    expect(() => publishedDaemonEnv("")).toThrow(/REFUSES a non-loopback bind/);
  });
});

describe("staging helpers — one method for runbook and adapter", () => {
  it("stage paths are in-container under the exec user's home, and reject host/escaping paths", async () => {
    const m = await import("./helpers/testbed-published-daemon.js");
    expect(m.containerStagePath("topologies")).toBe("/home/openrig/topologies");
    expect(() => m.containerStagePath("/abs")).toThrow(/simple relative name/);
    expect(() => m.containerStagePath("../escape")).toThrow(/simple relative name/);
  });

  it("delivery extracts as the DEFAULT exec user — no -u root, no chown (ownership by construction)", async () => {
    const m = await import("./helpers/testbed-published-daemon.js");
    const argv = m.stageExtractArgv("H_A", "/home/openrig/topologies");
    expect(argv).toEqual(["exec", "-i", "H_A", "tar", "-C", "/home/openrig/topologies", "-xf", "-"]);
    expect(argv).not.toContain("-u");
    expect(argv.join(" ")).not.toMatch(/chown/);
  });

  it("the stage fence probes the FULL contract by DOING it (read + touch/rm), not by reading mode bits", async () => {
    const m = await import("./helpers/testbed-published-daemon.js");
    const cmd = m.stageFenceArgv("H_A", "/home/openrig/topologies").join(" ");
    expect(cmd).toMatch(/test -r/);
    expect(cmd).toMatch(/touch/);
    expect(cmd).toMatch(/rm -f/);
    expect(cmd).not.toMatch(/stat|ls -l/); // mode bits are not the assertion
  });
});
