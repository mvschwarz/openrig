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
      if (argv.includes("default-shell")) return "powershell.exe -NoProfile";
      return argv[1] === "new-session" ? "%1\n" : "";
    }, "psmux");
    expect(await adapter.createSession("native-worker", "C:/work space", { EXAMPLE: "two words" })).toEqual({ ok: true });
    expect(calls.find(argv => argv[1] === "new-session")).toEqual(expect.arrayContaining(["-s", "native-worker", "-c", "C:/work space", "--"]));
    expect(calls.flat()).not.toContain("-e");
    expect(calls.some(argv => argv[1]?.includes("capability"))).toBe(false);
    expect(calls.flat().join(" ")).not.toContain("two words");
    expect(content.join("\n")).toContain("two words");
    expect(calls).toContainEqual(["tmux", "source-file", "-t", "=native-worker", "C:/private/environment.conf"]);
    expect(calls.some(argv => argv.includes("start-server"))).toBe(false);
  });

  it.each(["launch-unknown", "session-update-unknown"])("retains stock private files without literal retry after %s", async failure => {
    const calls: string[][] = []; let disposed = false;
    const adapter = new TmuxAdapter(async () => { throw Error("No shell"); }, {
      privateConfig: async () => ({ path: "C:/private/session.conf", dispose: async () => { disposed = true; } }),
      writeFile: async () => {}, unlink: async () => {}, tmpName: () => "C:/private/launch.ps1", bufferName: () => "unused",
    }, async argv => {
      calls.push(argv);
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
