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

  it("the env helper refuses an empty bearer — the guard is satisfied, never weakened", () => {
    expect(publishedDaemonEnv("t")).toEqual({ [BIND_ENV]: BIND_VALUE, [BEARER_ENV]: "t" });
    expect(() => publishedDaemonEnv("")).toThrow(/REFUSES a non-loopback bind/);
  });
});
