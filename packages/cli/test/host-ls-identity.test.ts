// Slice 14 §2c — make the binding state LEGIBLE before a cross-machine failure.
//
// A registry entry that never learned its peer's self-id cannot resolve that peer's reply hint, and
// until now nothing said so: the operator found out when a message failed. `rig host ls` now shows
// the join key, or the word `unbound` where there isn't one.
//
// Also pins the write path end-to-end: `hostId` rides through `addHostEntry` because the writer
// routes through the shared validator. That is a claim about behavior, so it is tested, not asserted
// in a comment.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Command } from "commander";
import { hostCommand } from "../src/commands/host.js";
import { addHostEntry, loadHostRegistry, resolveHost } from "../src/host-registry.js";

describe("rig host ls — the hostId join key is visible, bound or not", () => {
  let dir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-ls-identity-"));
    savedEnv = {};
    for (const k of ["OPENRIG_HOME", "RIGGED_HOME", "OPENRIG_URL", "RIGGED_URL", "OPENRIG_HOST_SELECTED"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.OPENRIG_HOME = dir;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function capture(fn: () => Promise<unknown>): Promise<string[]> {
    return new Promise(async (resolve) => {
      const out: string[] = [];
      const ol = console.log; const oe = console.error;
      console.log = (...a: unknown[]) => out.push(a.join(" "));
      console.error = (...a: unknown[]) => out.push(a.join(" "));
      try { await fn(); } finally { console.log = ol; console.error = oe; }
      resolve(out);
    });
  }

  function run(argv: string[]) {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(hostCommand());
    return prog.parseAsync(["node", "rig", "host", ...argv]);
  }

  it("carries hostId through the WRITE path and resolves by it afterwards", () => {
    expect(addHostEntry({ id: "mm2-host", transport: "http", url: "http://x:7433", hostId: "host-84c37990" }).ok).toBe(true);
    const loaded = loadHostRegistry();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.registry.hosts[0]!.hostId).toBe("host-84c37990");

    // Both directions resolve to the same entry — that IS alias -> id -> transport.
    expect(resolveHost(loaded.registry, "mm2-host").ok).toBe(true);
    const byJoinKey = resolveHost(loaded.registry, "host-84c37990");
    expect(byJoinKey.ok).toBe(true);
    if (byJoinKey.ok) expect(byJoinKey.host.id).toBe("mm2-host");
  });

  it("shows the join key in --json, and null (not a missing key) when unbound", async () => {
    expect(addHostEntry({ id: "bound-host", transport: "http", url: "http://a:7433", hostId: "host-84c37990" }).ok).toBe(true);
    expect(addHostEntry({ id: "legacy-host", transport: "http", url: "http://b:7433" }).ok).toBe(true);

    const out = await capture(() => run(["ls", "--json"]));
    const rows = JSON.parse(out.find((l) => l.trim().startsWith("["))!) as Array<Record<string, unknown>>;
    const bound = rows.find((r) => r.id === "bound-host")!;
    const legacy = rows.find((r) => r.id === "legacy-host")!;

    expect(bound.hostId).toBe("host-84c37990");
    // Explicitly null rather than absent: "never learned" must be a value a consumer can read, not
    // an absence indistinguishable from a consumer that forgot to look.
    expect(legacy.hostId).toBeNull();
    expect("hostId" in legacy).toBe(true);
    // The shipped bare-array contract is additive-only — the pre-existing keys survive.
    expect(legacy.transport).toBe("http");
    expect(legacy.url).toBe("http://b:7433");
  });

  it("shows the join key or the word unbound in the human table", async () => {
    expect(addHostEntry({ id: "bound-host", transport: "http", url: "http://a:7433", hostId: "host-84c37990" }).ok).toBe(true);
    expect(addHostEntry({ id: "legacy-host", transport: "http", url: "http://b:7433" }).ok).toBe(true);

    const out = await capture(() => run(["ls"]));
    const text = out.join("\n");
    expect(text).toContain("HOST-ID");
    expect(text).toMatch(/bound-host\s+host-84c37990/);
    expect(text).toMatch(/legacy-host\s+unbound/);
  });
});
