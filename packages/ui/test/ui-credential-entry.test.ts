// A person who holds the daemon's tokens gives them to the UI once, in its address's fragment: #termToken=…&mcToken=….
// A browser never sends a fragment in a request or a Referer. The page keeps the tokens in this browser, takes them out
// of the address, and its protected requests carry them.
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
const address = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

afterEach(() => {
  window.localStorage.removeItem(TERMINAL_BEARER_STORAGE_KEY);
  window.localStorage.removeItem(MISSION_CONTROL_BEARER_STORAGE_KEY);
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.doUnmock("../src/App.js");
  vi.resetModules();
});

describe("the UI's credential entry", () => {
  it("keeps both tokens from the fragment in this browser and takes only them out of the address", () => {
    window.history.replaceState(null, "", `/rigs/rig-1?view=graph#node&termToken=${TERM}&mcToken=${MC}`);
    primeMissionControlBearerTokenFromUrl();
    expect(terminalAuthHeaders().Authorization).toBe(`Bearer ${TERM}`);
    expect(missionControlAuthHeaders().Authorization).toBe(`Bearer ${MC}`);
    expect(address()).toBe("/rigs/rig-1?view=graph#node");
  });

  it("takes a token whose value needed encoding, and keeps a raw +", () => {
    window.history.replaceState(null, "", `/#termToken=${encodeURIComponent("a/b=c")}&mcToken=x+y`);
    primeMissionControlBearerTokenFromUrl();
    expect(terminalAuthHeaders().Authorization).toBe("Bearer a/b=c");
    expect(missionControlAuthHeaders().Authorization).toBe("Bearer x+y");
    expect(address()).toBe("/");
  });

  it("changes nothing when the fragment carries no token", () => {
    window.localStorage.setItem(TERMINAL_BEARER_STORAGE_KEY, TERM);
    window.history.replaceState(null, "", "/specs?view=list#section");
    primeMissionControlBearerTokenFromUrl();
    expect(terminalAuthHeaders().Authorization).toBe(`Bearer ${TERM}`);
    expect(missionControlAuthHeaders()).toEqual({});
    expect(address()).toBe("/specs?view=list#section");
  });

  it("takes no token from the query: only the fragment is an entry", () => {
    window.history.replaceState(null, "", `/?termToken=${TERM}`);
    primeMissionControlBearerTokenFromUrl();
    expect(terminalAuthHeaders()).toEqual({});
    expect(address()).toBe(`/?termToken=${TERM}`);
  });

  it("still loads and cleans the address when the browser refuses storage, keeping the token it held", () => {
    window.localStorage.setItem(TERMINAL_BEARER_STORAGE_KEY, "held-before");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage blocked"); });
    window.history.replaceState(null, "", `/#termToken=${TERM}`);
    expect(() => primeMissionControlBearerTokenFromUrl()).not.toThrow();
    expect(address()).toBe("/");
    expect(terminalAuthHeaders().Authorization).toBe("Bearer held-before");
  });

  it("runs when the UI starts, before it renders", async () => {
    vi.doMock("../src/App.js", () => ({ App: () => null }));
    window.history.replaceState(null, "", `/#termToken=${TERM}&mcToken=${MC}`);
    await import("../src/main.js");
    expect(terminalAuthHeaders().Authorization).toBe(`Bearer ${TERM}`);
    expect(missionControlAuthHeaders().Authorization).toBe(`Bearer ${MC}`);
    expect(address()).toBe("/");
  }, 20_000); // the entry's first import compiles its styles, which took over 5 s on a loaded machine
});
