// OPR.0.4.6.MH1 FR-1/FR-2 — the persisted host selection: local read
// resolution, the routing shim's precedence (flag > selection > local),
// and the zero-regression negative (no selection ≡ pre-MH1 behavior by
// construction).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readOwnHostName, readSelectedHost, resolveEffectiveHost } from "../src/host-selection.js";

describe("host selection (OPR.0.4.6.MH1)", () => {
  let tmp: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mh1-sel-"));
    for (const k of ["OPENRIG_HOME", "RIGGED_HOME", "OPENRIG_HOST_SELECTED", "OPENRIG_HOST_NAME"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env["OPENRIG_HOME"] = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults to 'local' with no config file (the zero-regression posture)", () => {
    expect(readSelectedHost()).toBe("local");
    // FR-2: no selection → undefined → every command's --host branch is
    // byte-identically untaken.
    expect(resolveEffectiveHost(undefined)).toBeUndefined();
  });

  it("reads the persisted selection from config.json (the daemon-written file)", () => {
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ host: { selected: "vps-a" } }));
    expect(readSelectedHost()).toBe("vps-a");
    expect(resolveEffectiveHost(undefined)).toBe("vps-a");
  });

  it("explicit --host wins over the persisted selection (precedence: flag > selection)", () => {
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ host: { selected: "vps-a" } }));
    expect(resolveEffectiveHost("other-b")).toBe("other-b");
  });

  it("selection 'local' resolves to undefined (explicit return-to-local ≡ no selection)", () => {
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ host: { selected: "local" } }));
    expect(resolveEffectiveHost(undefined)).toBeUndefined();
  });

  it("the env override (OPENRIG_HOST_SELECTED) wins over the file (store precedence env > file)", () => {
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ host: { selected: "vps-a" } }));
    process.env["OPENRIG_HOST_SELECTED"] = "vps-env";
    expect(readSelectedHost()).toBe("vps-env");
  });

  it("a malformed config file falls back to 'local' — read paths never break", () => {
    writeFileSync(join(tmp, "config.json"), "{not json");
    expect(readSelectedHost()).toBe("local");
    expect(resolveEffectiveHost(undefined)).toBeUndefined();
  });

  // OPR.0.4.6.MH1 FR-4 — the own-host display name (same read discipline).
  it("own-host name defaults to 'localhost' with no config (the FR-4 zero-regression posture)", () => {
    expect(readOwnHostName()).toBe("localhost");
  });

  it("reads the persisted own-host name from config.json (the daemon-written file)", () => {
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ host: { name: "Mac mini 2" } }));
    expect(readOwnHostName()).toBe("Mac mini 2");
  });

  it("the env override (OPENRIG_HOST_NAME) wins over the file for the own-host name", () => {
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ host: { name: "Mac mini 2" } }));
    process.env["OPENRIG_HOST_NAME"] = "env-name";
    expect(readOwnHostName()).toBe("env-name");
  });

  it("a malformed config file falls back to 'localhost' for the own-host name", () => {
    writeFileSync(join(tmp, "config.json"), "{not json");
    expect(readOwnHostName()).toBe("localhost");
  });
});
