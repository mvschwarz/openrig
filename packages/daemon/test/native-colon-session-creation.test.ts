import { afterEach, expect, it, vi } from "vitest";
import { TmuxAdapter, type ArgvExecFn } from "../src/adapters/tmux.js";
import { bindNativeSessionName } from "../src/domain/terminal/native-session-name.js";
afterEach(() => vi.unstubAllEnvs());

it.each([true, false])("persists a colon-bearing created session on the verified server (file protocol=%s)", async advertised => {
  // The simulated native bootstrap constructs system binary paths; it never
  // executes them. Linux hosts have no SystemRoot unless this fixture supplies it.
  if (!process.env.SystemRoot) vi.stubEnv("SystemRoot", "C:\\Windows");
  const name = "owned:logical", binding = bindNativeSessionName(name), calls: string[][] = [];
  let present = false, marker = "";
  const invoke: ArgvExecFn = Object.assign(async (argv: string[]) => {
    calls.push(argv); const command = argv[1] === "-t" ? argv[3] : argv[1];
    if (command === "openrig-private-environment-capability") {
      if (advertised) return "openrig-envfile-v1:new-session,respawn-pane";
      throw new Error("unknown command: openrig-private-environment-capability");
    }
    if (command === "has-session") { if (present) return ""; throw Object.assign(new Error("absent"), { code: 1, stdout: "", stderr: "" }); }
    if (command === "show-options") return argv.includes("-t") ? marker + "\n" : "cmd.exe\n";
    if (command === "new-session") { expect(argv[argv.indexOf("-s") + 1]).toBe(binding.physical); present = true; return "%1\n"; }
    if (command === "if-shell") { marker = binding.marker!; return ""; }
    if (command === "source-file") { expect(argv[argv.indexOf("-t") + 1]).toBe("=" + binding.physical); return ""; }
    if (command === "list-panes") { expect(argv[argv.indexOf("-t") + 1]).toBe("=" + binding.physical + ":"); return `${binding.physical}|%1|0|C:/owned|80|24|1\n`; }
    if (command === "show-environment") return "";
    throw new Error("Unexpected command: " + command);
  }, { supportsEnvironment: true as const });
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, {
    tmpName: () => "C:/owned/bootstrap.cmd", bufferName: () => "owned", writeFile: async () => {}, unlink: async () => {},
    privateConfig: async () => ({ path: "C:/owned/private.conf", dispose: async () => {} }),
  }, invoke, [], "psmux");
  const created = await adapter.createSession(name, undefined, { "OTHER-KEY": "synthetic" });
  expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
  expect(await adapter.probeSession(name)).toEqual({ state: "present" });
  expect(await adapter.listSessionPanes(name)).toHaveLength(1);
  expect(calls.some(argv => argv.includes("source-file"))).toBe(true);
  expect(calls.flat()).not.toContain("=owned");
});
