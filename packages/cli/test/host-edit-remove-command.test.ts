// OPR.0.4.6.MH1 FR-1 extension (issue #2128) — the `rig host edit` and
// `rig host remove` COMMANDS themselves: flag→field mapping, the id+transport
// fixed rule surfacing as loud CLI errors, empty-string clearing, plain
// selection notices (never a silent switch), and the --json shape.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Command } from "commander";
import { hostCommand } from "../src/commands/host.js";
import { addHostEntry, loadHostRegistry } from "../src/host-registry.js";

describe("rig host edit / rig host remove (issue #2128 command path)", () => {
  let dir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostedit-"));
    savedEnv = {};
    for (const k of ["OPENRIG_HOME", "RIGGED_HOME", "OPENRIG_URL", "RIGGED_URL", "OPENRIG_HOST_SELECTED"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.OPENRIG_HOME = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function capture(fn: () => Promise<void>): Promise<{ out: string[]; err: string[]; exitCode: number | undefined }> {
    const out: string[] = []; const err: string[] = [];
    const ol = console.log; const oe = console.error; const oc = process.exitCode;
    process.exitCode = undefined;
    console.log = (...a: unknown[]) => out.push(a.join(" "));
    console.error = (...a: unknown[]) => err.push(a.join(" "));
    let exitCode: number | undefined;
    try {
      await fn();
      exitCode = process.exitCode as number | undefined;
    } finally {
      console.log = ol;
      console.error = oe;
      process.exitCode = oc;
    }
    return { out, err, exitCode };
  }

  function run(argv: string[]) {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(hostCommand());
    return prog.parseAsync(["node", "rig", "host", ...argv]);
  }

  function seed() {
    expect(addHostEntry({ id: "vm-a", transport: "ssh", target: "vm-a.local", user: "admin", notes: "old" }).ok).toBe(true);
    expect(addHostEntry({ id: "h1", transport: "http", url: "http://h1:7433", bearer_env: "H1_TOKEN" }).ok).toBe(true);
  }

  it("edit changes fields through the writer; id+transport stay fixed", async () => {
    seed();
    const { out, exitCode } = await capture(() => run(["edit", "vm-a", "--target", "vm-b.local", "--user", "bob"]));
    expect(exitCode).toBeUndefined();
    const loaded = loadHostRegistry();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error);
    const entry = loaded.registry.hosts.find(h => h.id === "vm-a");
    expect(entry).toMatchObject({ id: "vm-a", transport: "ssh", target: "vm-b.local", user: "bob" });
    expect(out.join("\n")).toContain("Updated host 'vm-a'");
  });

  it("edit clears an optional field with an empty string", async () => {
    seed();
    const { exitCode } = await capture(() => run(["edit", "vm-a", "--user", ""]));
    expect(exitCode).toBeUndefined();
    const loaded = loadHostRegistry();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error);
    const entry = loaded.registry.hosts.find(h => h.id === "vm-a")!;
    expect(entry.user).toBeUndefined();
    expect(entry.notes).toBe("old");
  });

  it("edit on an unknown id is exit 1 naming the known ids", async () => {
    seed();
    const { err, exitCode } = await capture(() => run(["edit", "nope", "--target", "x"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("unknown host id 'nope'");
    expect(err.join("\n")).toContain("vm-a");
  });

  it("edit with NO flags is refused (nothing to change)", async () => {
    seed();
    const { err, exitCode } = await capture(() => run(["edit", "vm-a"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/no changes/i);
  });

  it("edit refuses a field that is not editable for the transport", async () => {
    seed();
    const { err, exitCode } = await capture(() => run(["edit", "vm-a", "--url", "http://x"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("not editable");
    const { err: err2, exitCode: code2 } = await capture(() => run(["edit", "h1", "--target", "somewhere"]));
    expect(code2).toBe(1);
    expect(err2.join("\n")).toContain("not editable");
  });

  it("edit of the SELECTED host says so plainly (selection unchanged)", async () => {
    seed();
    process.env.OPENRIG_HOST_SELECTED = "vm-a";
    const { out, exitCode } = await capture(() => run(["edit", "vm-a", "--notes", "moved"]));
    expect(exitCode).toBeUndefined();
    const joined = out.join("\n");
    expect(joined).toContain("selected host");
    expect(joined).toContain("selection");
    expect(process.env.OPENRIG_HOST_SELECTED).toBe("vm-a"); // never a silent switch
  });

  it("remove deletes only the entry and reports it plainly", async () => {
    seed();
    const { out, exitCode } = await capture(() => run(["remove", "vm-a"]));
    expect(exitCode).toBeUndefined();
    const loaded = loadHostRegistry();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.registry.hosts.map(h => h.id)).toEqual(["h1"]);
    expect(out.join("\n")).toContain("Removed host 'vm-a'");
  });

  it("remove of an unknown id is exit 1 naming known ids", async () => {
    seed();
    const { err, exitCode } = await capture(() => run(["remove", "nope"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("unknown host id 'nope'");
  });

  it("remove of the SELECTED host shows the dangling selection plainly — never a silent switch", async () => {
    seed();
    process.env.OPENRIG_HOST_SELECTED = "vm-a";
    const { out, exitCode } = await capture(() => run(["remove", "vm-a"]));
    expect(exitCode).toBeUndefined();
    const joined = out.join("\n");
    expect(joined).toContain("was the selected host");
    expect(joined).toContain("rig host select");
    expect(process.env.OPENRIG_HOST_SELECTED).toBe("vm-a"); // selection untouched
    expect(fs.existsSync(path.join(dir, "secrets"))).toBe(false); // no credential state touched
  });

  it("--json emits one parseable object with ok + entry", async () => {
    seed();
    const { out, exitCode } = await capture(() => run(["edit", "h1", "--notes", "n", "--json"]));
    expect(exitCode).toBeUndefined();
    const parsed = JSON.parse(out.join("\n")) as { ok: boolean; entry: { id: string; notes: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.entry).toMatchObject({ id: "h1", notes: "n" });
    const { out: out2, exitCode: code2 } = await capture(() => run(["remove", "h1", "--json"]));
    expect(code2).toBeUndefined();
    const parsed2 = JSON.parse(out2.join("\n")) as { ok: boolean; entry: { id: string } };
    expect(parsed2.ok).toBe(true);
    expect(parsed2.entry.id).toBe("h1");
  });

  it("edit on a MISSING registry is exit 1 with the loader's message", async () => {
    const { err, exitCode } = await capture(() => run(["edit", "vm-a", "--target", "x"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("host registry not found");
  });
});