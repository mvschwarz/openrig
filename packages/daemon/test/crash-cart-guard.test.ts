import { describe, it, expect, vi } from "vitest";
import { assertDaemonDown, DaemonLiveError } from "../src/domain/crash-cart-discovery.js";

// Crash-cart C2 — the fail-closed guard (arch a1344201 Q1). The daemon-down direct read
// is only safe when NO daemon is live: a live writer means the copy could race, and more
// importantly the crash-cart must never contend with the process it exists to recover.
// So the guard REFUSES if EITHER the recorded pid is alive OR a /healthz probe answers
// (honoring OPENRIG_URL) — both must be negative to proceed. Same fail-closed hermeticity
// discipline as the 51-02 env-helper's foreign-daemon refusal. All probes injected → hermetic.

const noDaemonJson = () => undefined;
const deadPid = () => false;
const silentHealthz = async () => false;

function deps(over: Partial<Parameters<typeof assertDaemonDown>[0]> = {}) {
  return {
    openrigHome: "/scratch/.openrig",
    readDaemonJson: noDaemonJson,
    isProcessAlive: deadPid,
    probeHealthz: silentHealthz,
    openrigUrl: undefined as string | undefined,
    ...over,
  };
}

describe("assertDaemonDown — fail-closed guard for the direct read", () => {
  it("passes (resolves) when there is no daemon.json, no OPENRIG_URL, and default healthz is silent", async () => {
    const probeHealthz = vi.fn(silentHealthz);
    await expect(assertDaemonDown(deps({ probeHealthz }))).resolves.toBeUndefined();
    // With no state file it still probes the default control-plane address before trusting "down".
    expect(probeHealthz).toHaveBeenCalledWith("http://127.0.0.1:7433/healthz");
  });

  it("REFUSES when daemon.json records a pid that is still alive (never copy a live-written WAL)", async () => {
    await expect(
      assertDaemonDown(
        deps({
          readDaemonJson: () => ({ pid: 4242, port: 7433, host: "127.0.0.1", db: "/x/openrig.sqlite" }),
          isProcessAlive: (pid) => pid === 4242,
        }),
      ),
    ).rejects.toBeInstanceOf(DaemonLiveError);
  });

  it("REFUSES when a /healthz probe answers even if the pid looks dead (wedged/foreign daemon)", async () => {
    const probeHealthz = vi.fn(async (url: string) => url.includes("7433"));
    await expect(
      assertDaemonDown(
        deps({
          readDaemonJson: () => ({ pid: 9, port: 7433, host: "127.0.0.1", db: "/x/openrig.sqlite" }),
          isProcessAlive: deadPid,
          probeHealthz,
        }),
      ),
    ).rejects.toBeInstanceOf(DaemonLiveError);
  });

  it("probes the daemon.json host:port (not just the default) when a state file is present", async () => {
    const probeHealthz = vi.fn(silentHealthz);
    await assertDaemonDown(
      deps({
        readDaemonJson: () => ({ pid: 9, port: 9999, host: "10.0.0.5", db: "/x/openrig.sqlite" }),
        isProcessAlive: deadPid,
        probeHealthz,
      }),
    );
    expect(probeHealthz).toHaveBeenCalledWith("http://10.0.0.5:9999/healthz");
  });

  it("honors OPENRIG_URL: probes it and REFUSES if it answers (bypassing the state file)", async () => {
    const probeHealthz = vi.fn(async (url: string) => url.startsWith("http://foreign"));
    await expect(
      assertDaemonDown(deps({ openrigUrl: "http://foreign-daemon:8080", probeHealthz })),
    ).rejects.toBeInstanceOf(DaemonLiveError);
    expect(probeHealthz).toHaveBeenCalledWith("http://foreign-daemon:8080/healthz");
  });
});
