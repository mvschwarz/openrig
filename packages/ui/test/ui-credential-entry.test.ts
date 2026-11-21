// A person who holds the daemon's tokens gives them to the UI in its address once: ?termToken=…&mcToken=…. The page
// keeps them in this browser, takes them out of the address, and its protected requests carry them.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MISSION_CONTROL_BEARER_STORAGE_KEY,
  TERMINAL_BEARER_STORAGE_KEY,
  missionControlAuthHeaders,
  primeMissionControlBearerTokenFromUrl,
  terminalAuthHeaders,
} from "../src/components/mission-control/missionControlAuth.js";

const TERM = "synthetic-terminal-token";
const MC = "synthetic-mission-control-token";

afterEach(() => {
  window.localStorage.removeItem(TERMINAL_BEARER_STORAGE_KEY);
  window.localStorage.removeItem(MISSION_CONTROL_BEARER_STORAGE_KEY);
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.doUnmock("../src/App.js");
  vi.resetModules();
});

describe("the UI's credential entry", () => {
  it("keeps both tokens from the address in this browser and takes them out of it, keeping the rest", () => {
    window.history.replaceState(null, "", `/rigs/rig-1?view=graph&termToken=${TERM}&mcToken=${MC}#node`);
    primeMissionControlBearerTokenFromUrl();
    expect(terminalAuthHeaders().Authorization).toBe(`Bearer ${TERM}`);
    expect(missionControlAuthHeaders().Authorization).toBe(`Bearer ${MC}`);
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe("/rigs/rig-1?view=graph#node");
  });

  it("changes nothing when the address carries no token", () => {
    window.localStorage.setItem(TERMINAL_BEARER_STORAGE_KEY, TERM);
    window.history.replaceState(null, "", "/specs?view=list");
    primeMissionControlBearerTokenFromUrl();
    expect(terminalAuthHeaders().Authorization).toBe(`Bearer ${TERM}`);
    expect(missionControlAuthHeaders()).toEqual({});
    expect(`${window.location.pathname}${window.location.search}`).toBe("/specs?view=list");
  });

  it("still loads and cleans the address when the browser refuses storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage blocked"); });
    window.history.replaceState(null, "", `/?termToken=${TERM}`);
    expect(() => primeMissionControlBearerTokenFromUrl()).not.toThrow();
    expect(window.location.search).toBe("");
    expect(terminalAuthHeaders()).toEqual({});
  });

  it("runs when the UI starts, before it renders", async () => {
    vi.doMock("../src/App.js", () => ({ App: () => null }));
    window.history.replaceState(null, "", `/?termToken=${TERM}&mcToken=${MC}`);
    await import("../src/main.js");
    expect(terminalAuthHeaders().Authorization).toBe(`Bearer ${TERM}`);
    expect(missionControlAuthHeaders().Authorization).toBe(`Bearer ${MC}`);
    expect(window.location.search).toBe("");
  }, 20_000); // the entry's first import compiles its styles, which took over 5 s on a loaded machine
});
