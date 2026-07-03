// OPR.0.4.3.28 B1+B3 — the relay resolves the ingest URL + token without the
// operator seeding OPENRIG_URL/OPENRIG_ACTIVITY_HOOK_TOKEN into the shell.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  resolveEndpoint: (env: Record<string, string | undefined>) => { baseUrl?: string; token?: string };
};

describe("activity-relay resolveEndpoint (OPR.0.4.3.28 B1+B3)", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-relay-")); });
  afterEach(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("fast path: env OPENRIG_URL + token are used verbatim", () => {
    const r = relay.resolveEndpoint({ OPENRIG_URL: "http://d:9999", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" });
    expect(r).toEqual({ baseUrl: "http://d:9999", token: "tok" });
  });

  it("B1: synthesizes the base URL from OPENRIG_HOST + OPENRIG_PORT when URL is absent", () => {
    const r = relay.resolveEndpoint({ OPENRIG_HOST: "10.0.0.5", OPENRIG_PORT: "7433", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" });
    expect(r.baseUrl).toBe("http://10.0.0.5:7433");
    expect(r.token).toBe("tok");
  });

  it("B1: defaults host to 127.0.0.1 when only PORT is present", () => {
    const r = relay.resolveEndpoint({ OPENRIG_PORT: "7433", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" });
    expect(r.baseUrl).toBe("http://127.0.0.1:7433");
  });

  it("B3: file-discovery supplies url+token for a reconcile/restored seat (no env vars)", () => {
    fs.writeFileSync(nodePath.join(home, "activity-endpoint.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:7433", token: "filetok" }));
    // Frozen env has only OPENRIG_HOME (inherited), no url/token.
    const r = relay.resolveEndpoint({ OPENRIG_HOME: home });
    expect(r.baseUrl).toBe("http://127.0.0.1:7433");
    expect(r.token).toBe("filetok");
  });

  it("B3: file-discovery fills only the MISSING piece (env token wins, file supplies url)", () => {
    fs.writeFileSync(nodePath.join(home, "activity-endpoint.json"), JSON.stringify({ baseUrl: "http://file:1", token: "filetok" }));
    const r = relay.resolveEndpoint({ OPENRIG_HOME: home, OPENRIG_ACTIVITY_HOOK_TOKEN: "envtok" });
    expect(r.token).toBe("envtok"); // env token not overwritten
    expect(r.baseUrl).toBe("http://file:1");
  });

  it("safe no-op: nothing in env and no discoverable file → undefined url/token", () => {
    const r = relay.resolveEndpoint({ OPENRIG_HOME: home }); // home has no endpoint.json
    expect(r.baseUrl).toBeFalsy();
    expect(r.token).toBeFalsy();
  });
});
