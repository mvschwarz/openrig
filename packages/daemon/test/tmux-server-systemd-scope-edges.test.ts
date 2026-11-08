// #2710 edges around the systemd user scope of the seats' tmux server, beyond the main contract
// (tmux-server-systemd-scope.test.ts): who gets a scope, a systemd that refuses OOMPolicy= for scopes, and a scope
// whose server never answers. Every command reaches the injected exec; nothing touches the host's systemd or tmux.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

const NO_SERVER = Object.assign(new Error("Command failed: tmux has-session\nno server running on /tmp/tmux-1000/default"), {
  execStderr: "no server running on /tmp/tmux-1000/default\n",
});

/** A host where `tmux -D` (loose, or inside the scope's sh -c) brings the server up unless `scopedServerStarts` is false. */
function host(options: { systemdRun?: (cmd: string) => string; scopedServerStarts?: boolean } = {}) {
  let up = false;
  const calls: string[] = [];
  const exec = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    if (cmd.startsWith("systemd-run ")) {
      const out = options.systemdRun ? options.systemdRun(cmd) : "";
      if (options.scopedServerStarts !== false) up = true;
      return out;
    }
    if (cmd.startsWith("tmux -D")) { up = true; return ""; }
    if (cmd.startsWith("tmux has-session")) throw up ? new Error("can't find session: x") : NO_SERVER;
    return "";
  });
  return { adapter: new TmuxAdapter(exec), calls, systemdRuns: () => calls.filter(c => c.startsWith("systemd-run ")) };
}

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
    expect(h.calls.filter(c => c.startsWith("tmux -D"))).toHaveLength(1);
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
    expect(h.calls.filter(c => c.startsWith("tmux -D"))).toEqual([]);
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
    expect(h.calls.filter(c => c.startsWith("tmux -D"))).toHaveLength(1);
  });

  it("a scope whose server never answers falls back to the start of today with a log line", async () => {
    const h = host({ scopedServerStarts: false });
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    expect(h.systemdRuns()).toHaveLength(1);
    expect(h.calls.filter(c => c.startsWith("tmux -D"))).toHaveLength(1);
    expect(warnings.filter(w => w.includes("did not answer in time"))).toHaveLength(1);
  });
});
