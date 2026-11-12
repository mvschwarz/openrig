import { afterEach, expect, it, vi } from "vitest";
import { TmuxAdapter, type ArgvExecFn } from "../src/adapters/tmux.js";
import { bindNativeSessionName } from "../src/domain/terminal/native-session-name.js";
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("persists a colon-bearing created stock session on the verified server", async () => {
  // The simulated native bootstrap constructs system binary paths; it never
  // executes them. Linux hosts have no SystemRoot unless this fixture supplies it.
  if (!process.env.SystemRoot) vi.stubEnv("SystemRoot", "C:\\Windows");
  const name = "owned:logical", binding = bindNativeSessionName(name), calls: string[][] = [];
  let present = false, marker = "";
  const invoke: ArgvExecFn = Object.assign(async (argv: string[]) => {
    calls.push(argv); const command = argv[1] === "-t" ? argv[3] : argv[1];
    if (command === "has-session") { if (present) return ""; throw Object.assign(new Error("absent"), { code: 1, stdout: "", stderr: "" }); }
    if (command === "show-options") return argv.includes("-t") ? marker + "\n" : "cmd.exe\n";
    if (command === "new-session") { expect(argv[argv.indexOf("-s") + 1]).toBe(binding.physical); present = true; return "%1\n"; }
    if (command === "if-shell") { marker = binding.marker!; return ""; }
    if (command === "source-file") { expect(argv[argv.indexOf("-t") + 1]).toBe("=" + binding.physical); return ""; }
    if (command === "list-panes") { expect(argv[argv.indexOf("-t") + 1]).toBe("=" + binding.physical + ":"); return `${binding.physical}|%1|0|C:/owned|80|24|1\n`; }
    if (command === "show-environment") return "CLAUDECODE=synthetic-parent\n";
    if (command === "set-environment") { expect(argv[argv.indexOf("-t") + 1]).toBe("=" + binding.physical); return ""; }
    if (command === "respawn-pane") {
      expect(argv.slice(0, 3)).toEqual(["tmux", "-t", "=" + binding.physical + ":.%1"]);
      expect(argv.slice(3)).toEqual(["respawn-pane", "-k", "-t", "%1"]); return "";
    }
    throw new Error("Unexpected command: " + command);
  }, { supportsEnvironment: true as const });
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, {
    tmpName: () => "C:/owned/bootstrap.cmd", bufferName: () => "owned", writeFile: async () => {}, unlink: async () => {},
    privateConfig: async () => ({ path: "C:/owned/private.conf", dispose: async () => {} }),
  }, invoke, [], "psmux");
  vi.spyOn(adapter, "isNativeWindows", "get").mockReturnValue(true);
  const created = await adapter.createSession(name, undefined, { "OTHER-KEY": "synthetic" });
  expect(created, JSON.stringify(created)).toEqual({ ok: true });
  expect(await adapter.probeSession(name)).toEqual({ state: "present" });
  expect(await adapter.listSessionPanes(name)).toHaveLength(1);
  expect(calls.some(argv => argv.includes("source-file"))).toBe(true);
  expect(calls.some(argv => argv.includes("set-environment") && argv.includes("-r") && argv.includes("CLAUDECODE"))).toBe(true);
  expect(calls.some(argv => argv.includes("respawn-pane"))).toBe(true);
  expect(calls.flat()).not.toContain("=owned");
});
