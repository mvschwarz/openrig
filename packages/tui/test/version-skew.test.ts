import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveRefresh, QUIET_REFRESH_MS } from "../src/live.js";
import { renderScreen } from "../src/render.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { checkVersionSkew, compareBuilds, parseCliIdentity } from "../src/version-skew.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OLD = { semver: "0.6.10", commit: "3001cc43a1b2c3d4e5f60718293a4b5c6d7e8f90" };
const NEW = { semver: "0.6.12", commit: "9e5382dd21f90158e95f6ce5bd251f22f5dc6391" };

afterEach(() => {
  vi.useRealTimers();
});

describe("the TUI's build against the daemon's /healthz", () => {
  it("reads the identity rig tui passes, and treats an unstamped build as unknown", () => {
    expect(parseCliIdentity(`${NEW.semver} · ${NEW.commit}`)).toEqual(NEW);
    expect(parseCliIdentity(`${NEW.semver} · ${NEW.commit} · dirty`)).toEqual(NEW);
    expect(parseCliIdentity("version unstamped · commit unstamped")).toBeNull();
    expect(parseCliIdentity(undefined)).toBeNull();
  });

  it("a match changes nothing", async () => {
    expect(await checkVersionSkew(NEW, async () => ({ status: "ok", semver: NEW.semver, commit: NEW.commit }))).toEqual({ state: "match" });
    expect(compareBuilds({ semver: NEW.semver, commit: NEW.commit.slice(0, 8) }, { semver: NEW.semver, commit: NEW.commit })).toEqual({ state: "match" });
  });

  it("an old TUI against a newer daemon is a mismatch that says what to do", async () => {
    const skew = await checkVersionSkew(OLD, async () => ({ status: "ok", semver: NEW.semver, commit: NEW.commit }));
    expect(skew).toEqual({ state: "mismatch",
      message: "Restart rig tui: daemon is now 0.6.12 (9e5382dd); auto-refresh off." });
    expect(compareBuilds({ semver: NEW.semver, commit: OLD.commit }, NEW)).toMatchObject({ state: "mismatch" });
  });

  it("a failed /healthz read is unreadable, and one without a stamp is unknown; neither is a mismatch", async () => {
    expect(await checkVersionSkew(OLD, async () => { throw new Error("daemon read failed: GET /healthz → 503"); })).toEqual({ state: "unreadable" });
    expect(await checkVersionSkew(OLD, async () => ({ status: "ok" }))).toEqual({ state: "unknown" });
    expect(await checkVersionSkew(OLD, async () => null)).toEqual({ state: "unknown" });
    const read = vi.fn(async () => NEW);
    expect(await checkVersionSkew(null, read)).toEqual({ state: "unknown" });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("a mismatch stops the background refresh", () => {
  it("clears the quiet timer for good and shows the message, while an asked-for refresh still runs", async () => {
    vi.useFakeTimers();
    const hydrate = vi.fn(async () => emptySnapshot());
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => 0 });
    await live.refresh();
    expect(vi.getTimerCount()).toBe(1);

    live.stopBackground("Restart rig tui: daemon is now 0.6.12 (9e5382dd); auto-refresh off.");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(QUIET_REFRESH_MS * 3);
    expect(hydrate).toHaveBeenCalledTimes(1);

    live.connectionStatus("connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(hydrate).toHaveBeenCalledTimes(1);

    await live.refresh();
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(live.load().skew).toContain("Restart rig tui");
    live.close();
  });

  it("puts the whole message on the status line at 80 columns, action first", () => {
    const message = (compareBuilds(OLD, NEW) as { message: string }).message;
    for (const cols of [80, 100, 160]) {
      const screen = renderScreen(createViewState({ instanceId: "t" }).get(), emptySnapshot(), { cols, rows: 24, load: { inFlight: false, settled: true, skew: message } }, "");
      expect(screen.lines.some((line) => line.includes(message))).toBe(true);
    }
    expect(message.startsWith("Restart rig tui")).toBe(true);
  });

  it("main checks on the first connect and on every event-stream reconnect", () => {
    const main = readFileSync(join(repoRoot, "packages", "tui", "src", "main.ts"), "utf8");
    const enable = main.slice(main.indexOf("function enableLive"), main.indexOf("function commandContext"));
    expect(enable).toContain("if (!liveEnabled) checkDaemonBuild();");
    expect(enable).toContain('status === "connected" && eventsDropped');
    expect(main).toContain("live.stopBackground(skew.message)");
    expect(main).toContain('skew.state === "unreadable" && attempt < 2');
  });
});
