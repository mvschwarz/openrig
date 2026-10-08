import { describe, it, expect } from "vitest";
import { DAEMON_HEALTH_PATH, DAEMON_VERSION_PATH, isPlanAnswer, planSupportRefusal } from "../src/launch-plan-guard.js";

// A daemon as two read-only paths: /healthz (stamped semver on packaged builds) and the version route.
const daemon = (paths: Record<string, unknown>) => async (path: string) => paths[path];
const stamped = (semver: string) => daemon({ [DAEMON_HEALTH_PATH]: { status: "ok", semver }, [DAEMON_VERSION_PATH]: { version: "unknown" } });
const unstamped = (version: unknown) => daemon({ [DAEMON_HEALTH_PATH]: { status: "ok" }, [DAEMON_VERSION_PATH]: { version } });

describe("launch --plan guard", () => {
  it.each(["0.5.9", "0.5.10", "0.6.0", "0.6.4-rc.1", "0.6.8-rc.1", "1.0.0"])("allows a plan on stamped daemon %s even though its version route says unknown", async (version) => {
    // Packaged 0.5.9 to 0.6.5 answer "unknown" on the version route; /healthz carries the stamp.
    expect(await planSupportRefusal(stamped(version))).toBeNull();
  });

  it("allows a plan on an unstamped development daemon through the version route", async () => {
    expect(await planSupportRefusal(unstamped("0.6.7"))).toBeNull();
  });

  it.each(["0.5.8", "0.5.9-rc.1", "0.4.9"])("refuses before sending on stamped daemon %s", async (version) => {
    const refusal = await planSupportRefusal(stamped(version));
    expect(refusal).toContain(`reports version ${version}`);
    expect(refusal).toContain("0.5.9 or later");
  });

  it.each([
    ["an unstamped daemon reporting 0.5.8", unstamped("0.5.8")],
    ["an unstamped daemon reporting unknown", unstamped("unknown")],
    ["a daemon with neither a stamp nor the version route (before 0.4.1)", daemon({ [DAEMON_HEALTH_PATH]: { status: "ok" } })],
    ["a daemon that answers neither path", daemon({})],
  ])("refuses %s", async (_label, read) => {
    expect(await planSupportRefusal(read)).toContain("Not sent");
  });

  it("refuses when every read throws", async () => {
    expect(await planSupportRefusal(async () => { throw new Error("connection refused"); })).toContain("did not report its version");
  });

  it("accepts only an answer that says planOnly: true", () => {
    expect(isPlanAnswer({ ok: true, planOnly: true })).toBe(true);
    expect(isPlanAnswer({ ok: true, launched: [] })).toBe(false);
    expect(isPlanAnswer({ planOnly: "true" })).toBe(false);
    expect(isPlanAnswer(undefined)).toBe(false);
  });
});
