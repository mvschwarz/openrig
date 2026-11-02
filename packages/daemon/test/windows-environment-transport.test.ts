import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

describe("psmux environment command transport", () => {
  it("creates the named stock session without values in argv and persists its private session environment", async () => {
    const calls: string[][] = [], content: string[] = [];
    const adapter = new TmuxAdapter(async () => { throw new Error("no shell transport"); }, {
      privateConfig: async text => { content.push(text); return { path: "C:/private/environment.conf", dispose: async () => {} }; },
      writeFile: async (_file, text) => { content.push(text); }, unlink: async () => {}, tmpName: () => "C:/private/bootstrap.ps1", bufferName: () => "unused",
    }, async argv => {
      calls.push(argv);
      if (argv[1] === "openrig-private-environment-capability") throw new Error("psmux: unknown command: openrig-private-environment-capability");
      if (argv.includes("default-shell")) return "powershell.exe -NoProfile";
      return argv[1] === "new-session" ? "%1\n" : "";
    }, "psmux");
    expect(await adapter.createSession("native-worker", "C:/work space", { EXAMPLE: "two words" })).toEqual({ ok: true });
    expect(calls.find(argv => argv[1] === "new-session")).toEqual(expect.arrayContaining(["-s", "native-worker", "-c", "C:/work space", "--"]));
    expect(calls.flat()).not.toContain("-e");
    expect(calls.flat().join(" ")).not.toContain("two words");
    expect(content.join("\n")).toContain("two words");
    expect(calls).toContainEqual(["tmux", "source-file", "-t", "=native-worker", "C:/private/environment.conf"]);
    expect(calls.some(argv => argv.includes("start-server"))).toBe(false);
  });

  it("uses a protected manifest only when the backend advertises the exact protocol", async () => {
    const calls: string[][] = [], contents: string[] = [];
    let disposed = false;
    const adapter = new TmuxAdapter(async () => { throw new Error("no shell"); }, {
      privateConfig: async text => { contents.push(text); return { path: "C:/private/environment.conf", dispose: async () => { disposed = true; } }; },
      writeFile: async () => {}, unlink: async () => {}, tmpName: () => "unused", bufferName: () => "unused",
    }, async argv => {
      calls.push(argv);
      if (argv[1] === "openrig-private-environment-capability") return "openrig-envfile-v1:new-session,respawn-pane\n";
      return "%1\n";
    }, "psmux");
    const value = 'literal\nCR\r中文 "\\ $ #{pid} ';
    expect(await adapter.createSession("native-worker", undefined, { EXAMPLE: value })).toEqual({ ok: true });
    expect(JSON.parse(contents[0]!).entries).toContainEqual(["EXAMPLE", value]);
    const launch = calls.find(argv => argv[1] === "new-session")!;
    expect(launch).toContain("@openrig-env-v1:C:/private/environment.conf");
    expect(launch.some(arg => arg.includes(value))).toBe(false);
    expect(disposed).toBe(true);
  });

  it("retains the file after uncertain execution and never retries with values", async () => {
    const calls: string[][] = [];
    let disposed = false;
    const adapter = new TmuxAdapter(async () => "", {
      privateConfig: async () => ({ path: "C:/private/environment.conf", dispose: async () => { disposed = true; } }),
      writeFile: async () => {}, unlink: async () => {}, tmpName: () => "unused", bufferName: () => "unused",
    }, async argv => {
      calls.push(argv);
      if (argv[1] === "openrig-private-environment-capability") return "openrig-envfile-v1:new-session,respawn-pane";
      throw new Error("transport observation unavailable");
    }, "psmux");
    expect((await adapter.createSession("native-worker", undefined, { EXAMPLE: "synthetic-private" })).ok).toBe(false);
    expect(disposed).toBe(false);
    expect(calls.filter(argv => argv[1] === "new-session")).toHaveLength(1);
    expect(calls.flat().some(arg => arg.includes("synthetic-private"))).toBe(false);
  });

  it("does not interpret a failed capability observation as permission for literal transport", async () => {
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(async () => "", undefined, async argv => { calls.push(argv); throw new Error("transport unavailable"); }, "psmux");
    expect((await adapter.createSession("native-worker", undefined, { EXAMPLE: "synthetic-private" })).ok).toBe(false);
    expect(calls).toEqual([["tmux", "openrig-private-environment-capability"]]);
  });

  it.each(["launch-unknown", "session-update-unknown"])("retains stock private files without literal retry after %s", async failure => {
    const calls: string[][] = []; let disposed = false;
    const adapter = new TmuxAdapter(async () => { throw Error("No shell"); }, {
      privateConfig: async () => ({ path: "C:/private/session.conf", dispose: async () => { disposed = true; } }),
      writeFile: async () => {}, unlink: async () => {}, tmpName: () => "C:/private/launch.ps1", bufferName: () => "unused",
    }, async argv => {
      calls.push(argv);
      if (argv.includes("openrig-private-environment-capability")) throw Error("unknown command: openrig-private-environment-capability");
      if (argv.includes("default-shell")) return "powershell.exe -NoProfile";
      if (argv.includes("new-session")) { if (failure === "launch-unknown") throw Error("launch outcome unknown"); return "%1"; }
      if (argv.includes("source-file")) throw Error("session update outcome unknown");
      return "";
    }, "psmux");
    expect((await adapter.createSession("owned", undefined, { SECRET: "synthetic-private-value" })).ok).toBe(false);
    expect(calls.filter(argv => argv.includes("new-session"))).toHaveLength(1);
    expect(calls.flat().join(" ")).not.toContain("synthetic-private-value");
    expect(disposed).toBe(false);
  });
});
