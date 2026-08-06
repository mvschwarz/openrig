import { describe, it, expect } from "vitest";
import {
  DAEMON_TARGET_ENV_VARS,
  detectForeignDaemonTarget,
  assertNoForeignDaemon,
  HermeticEnvError,
} from "./helpers/hermetic-env.js";

// Slice 51-02 — the hermetic env-discipline helper's FAIL-CLOSED guard (proof item 4,
// the safety keystone). If a live-daemon TARGET the helper did not create is present in
// the ambient env, the runner must REFUSE with a hard error naming the foreign target and
// send ZERO traffic to it — never a silent fallback to the ambient daemon.
describe("hermetic-env fail-closed guard", () => {
  it("refuses with a named HermeticEnvError when an ambient OPENRIG_URL is present", () => {
    const env = { OPENRIG_URL: "http://foreign-daemon:9999" };
    expect(() => assertNoForeignDaemon(env)).toThrow(HermeticEnvError);
    let msg = "";
    try {
      assertNoForeignDaemon(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    // The error must NAME the foreign target (var + value) so the operator can see it.
    expect(msg).toContain("OPENRIG_URL");
    expect(msg).toContain("http://foreign-daemon:9999");
  });

  it("names every inherited daemon-target var as a foreign target", () => {
    for (const v of DAEMON_TARGET_ENV_VARS) {
      const hit = detectForeignDaemonTarget({ [v]: "some-value" });
      expect(hit).not.toBeNull();
      expect(hit!.name).toBe(v);
      expect(() => assertNoForeignDaemon({ [v]: "some-value" })).toThrow(
        new RegExp(v),
      );
    }
  });

  it("reports the FIRST foreign target found (deterministic, ordered)", () => {
    const env = { OPENRIG_PORT: "7433", OPENRIG_URL: "http://x:1" };
    const hit = detectForeignDaemonTarget(env);
    // DAEMON_TARGET_ENV_VARS ordering is the detection order — URL precedes PORT.
    expect(hit!.name).toBe("OPENRIG_URL");
  });

  it("passes for a clean env with no foreign daemon target", () => {
    expect(detectForeignDaemonTarget({ HOME: "/x", PATH: "/y" })).toBeNull();
    expect(() => assertNoForeignDaemon({ HOME: "/x", PATH: "/y" })).not.toThrow();
  });

  it("ignores empty-string daemon-target vars (unset-equivalent)", () => {
    // An exported-but-empty var does not point at a daemon; treat it as absent.
    expect(detectForeignDaemonTarget({ OPENRIG_URL: "" })).toBeNull();
    expect(() => assertNoForeignDaemon({ OPENRIG_URL: "" })).not.toThrow();
  });
});
