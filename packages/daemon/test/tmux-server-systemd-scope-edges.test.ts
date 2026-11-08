// #2710 edges around the systemd user scope of the seats' tmux server, beyond the main contract
// (tmux-server-systemd-scope.test.ts): who gets a scope, a systemd that refuses OOMPolicy= for scopes, and a scope
// whose server never answers. Every command reaches the injected exec; nothing touches the host's systemd or tmux.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

const NO_SERVER = Object.assign(new Error("Command failed: tmux has-session\nno server running on /tmp/tmux-1000/default"), {
  execStderr: "no server running on /tmp/tmux-1000/default\n",
});

/** A host where `tmux -D` (loose, or inside the scope's sh -c) brings the server up unless `scopedServerStarts` is false. */
function host(options: { systemdRun?: (cmd: string) => string; scopedServerStarts?: boolean; serverArgs?: string[] } = {}) {
  let up = false;
  const calls: string[] = [];
  const exec = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    if (cmd.startsWith("systemd-run ")) {
      const out = options.systemdRun ? options.systemdRun(cmd) : "";
      if (options.scopedServerStarts !== false) up = true;
      return out;
    }
    // `tmux [-S <socket>] -D` / `has-session`: the socket of serverArgs comes first when there is one
    if (/^tmux (-S \S+ )?-D/.test(cmd)) { up = true; return ""; }
    if (/^tmux (-S \S+ )?has-session/.test(cmd)) throw up ? new Error("can't find session: x") : NO_SERVER;
    return "";
  });
  return {
    adapter: new TmuxAdapter(exec, undefined, undefined, options.serverArgs ?? []),
    calls,
    systemdRuns: () => calls.filter(c => c.startsWith("systemd-run ")),
    /** The server goes away (killed, or never started): the next startServer starts it again. */
    down: () => { up = false; },
  };
}

const UNRECOGNIZED = (cmd: string) => Object.assign(
  new Error(`Command failed: ${cmd}\nsystemd-run: unrecognized option '--expand-environment=no'`),
  { execStderr: "systemd-run: unrecognized option '--expand-environment=no'\n" });
const NO_OOM = (cmd: string) => Object.assign(
  new Error(`Command failed: ${cmd}\nFailed to start transient scope unit: Cannot set property OOMPolicy, or unknown property.`),
  { execStderr: "Failed to start transient scope unit: Cannot set property OOMPolicy, or unknown property.\n" });

describe("seat tmux server systemd user scope: edges (#2710)", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let warnings: string[];

  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
    vi.stubEnv("MANAGERPID", "1234");
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("a daemon that is not a systemd user service (no MANAGERPID) starts the server as before, says why, and never calls systemd-run", async () => {
    vi.stubEnv("MANAGERPID", undefined);
    const h = host();
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    expect(h.systemdRuns()).toEqual([]);
    expect(h.calls.filter(c => /^tmux (-S \S+ )?-D/.test(c))).toHaveLength(1);
    expect(warnings.filter(w => w.includes("MANAGERPID"))).toHaveLength(1);
  });

  it("a systemd that refuses OOMPolicy= for a scope (before 253) still gets the scope, without the property", async () => {
    const h = host({
      systemdRun: cmd => {
        if (cmd.includes("OOMPolicy=continue")) {
          throw Object.assign(new Error(`Command failed: ${cmd}\nFailed to start transient scope unit: Cannot set property OOMPolicy, or unknown property.`), {
            execStderr: "Failed to start transient scope unit: Cannot set property OOMPolicy, or unknown property.\n",
          });
        }
        return "";
      },
    });
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    expect(h.systemdRuns()).toHaveLength(2);
    expect(h.systemdRuns()[1]).not.toContain("OOMPolicy");
    expect(h.calls.filter(c => /^tmux (-S \S+ )?-D/.test(c))).toEqual([]);
    expect(warnings.filter(w => w.includes("without OOMPolicy=continue"))).toHaveLength(1);
  });

  it("any other systemd-run failure is not retried", async () => {
    const h = host({
      systemdRun: cmd => {
        throw Object.assign(new Error(`Command failed: ${cmd}\nFailed to connect to bus: Connection refused`), {
          execStderr: "Failed to connect to bus: Connection refused\n",
        });
      },
    });
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    expect(h.systemdRuns()).toHaveLength(1);
    expect(h.calls.filter(c => /^tmux (-S \S+ )?-D/.test(c))).toHaveLength(1);
  });

  it("a socket path with a literal $ reaches the server unexpanded on a systemd that expands ${VAR} (258)", async () => {
    // systemd-run 258 expands ${VAR} in the command's arguments unless --expand-environment=no; 255 does not for --scope.
    const socket = "/tmp/rig-${USER}/s";
    const seen: string[] = [];
    const h = host({
      serverArgs: ["-S", socket],
      systemdRun: cmd => {
        seen.push(cmd.includes("--expand-environment=no") ? cmd : cmd.replace(/\$\{USER\}/g, "bruno"));
        return "";
      },
    });
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    expect(h.systemdRuns()).toHaveLength(1);
    expect(h.systemdRuns()[0]).toContain("--expand-environment=no");
    expect(seen[0]).toContain("${USER}");
    expect(seen[0]).not.toContain("rig-bruno");
    expect(h.calls.filter(c => /^tmux (-S \S+ )?-D/.test(c))).toEqual([]);
  });

  it("a systemd before 254 (no --expand-environment, which never expands) gets the scope on a retry without it", async () => {
    const h = host({ systemdRun: cmd => { if (cmd.includes("--expand-environment")) throw UNRECOGNIZED(cmd); return ""; } });
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    expect(h.systemdRuns()).toHaveLength(2);
    expect(h.systemdRuns()[1]).not.toContain("--expand-environment");
    expect(h.systemdRuns()[1]).toContain("OOMPolicy=continue");
    expect(h.calls.filter(c => /^tmux (-S \S+ )?-D/.test(c))).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a systemd-run timeout (empty stderr, the command echoed in the message) falls back without dropping an option", async () => {
    // The production exec (tmux-exec.ts) kills the client at 30 s: no stderr, and the message echoes the whole
    // command, --expand-environment=no and OOMPolicy=continue included. Neither may be read as an unsupported option.
    const h = host({
      systemdRun: cmd => {
        throw Object.assign(new Error(`tmux did not answer within 30 s and its client was ended; the write may still have happened. Check with rig capture before resending.\nCommand failed: /bin/sh -c ${cmd}\n`), {
          killed: true, signal: "SIGKILL", code: null, stdout: "", stderr: "", execStderr: "",
        });
      },
    });
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    expect(h.systemdRuns()).toHaveLength(1);
    expect(h.systemdRuns()[0]).toContain("--expand-environment=no");
    expect(h.calls.filter(c => /^tmux (-S \S+ )?-D/.test(c))).toHaveLength(1);
    expect(warnings.filter(w => w.includes("not in a systemd user scope"))).toHaveLength(1);
    expect(warnings.find(w => w.includes("not in a systemd user scope"))).toContain("30 s");
  });

  it("an unknown systemd-run failure whose message names the options falls back with its reason, without a retry", async () => {
    const h = host({
      systemdRun: cmd => {
        throw Object.assign(new Error(`Command failed: ${cmd}\nFailed to connect to bus: No medium found`), {
          code: 1, execStderr: "Failed to connect to bus: No medium found\n",
        });
      },
    });
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    expect(h.systemdRuns()).toHaveLength(1);
    expect(warnings.filter(w => w.includes("Failed to connect to bus"))).toHaveLength(1);
  });

  it("a systemd that knows neither (before 253) still gets the scope, dropping one option per retry", async () => {
    const h = host({
      systemdRun: cmd => {
        if (cmd.includes("--expand-environment")) throw UNRECOGNIZED(cmd);
        if (cmd.includes("OOMPolicy=continue")) throw NO_OOM(cmd);
        return "";
      },
    });
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    expect(h.systemdRuns()).toHaveLength(3);
    expect(h.systemdRuns()[2]).not.toMatch(/expand-environment|OOMPolicy/);
    expect(warnings.filter(w => w.includes("without OOMPolicy=continue"))).toHaveLength(1);
  });

  it("the reason no scope is tried is logged once per adapter, not at every server start", async () => {
    vi.stubEnv("MANAGERPID", undefined);
    const h = host();
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    h.down();
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    expect(h.calls.filter(c => /^tmux (-S \S+ )?-D/.test(c))).toHaveLength(2);
    expect(warnings.filter(w => w.includes("MANAGERPID"))).toHaveLength(1);
  });

  it("a scope whose server never answers falls back to the start of today with a log line", async () => {
    const h = host({ scopedServerStarts: false });
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    expect(h.systemdRuns()).toHaveLength(1);
    expect(h.calls.filter(c => /^tmux (-S \S+ )?-D/.test(c))).toHaveLength(1);
    expect(warnings.filter(w => w.includes("did not answer in time"))).toHaveLength(1);
  });
});
