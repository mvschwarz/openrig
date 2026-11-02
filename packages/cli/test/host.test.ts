import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Command } from "commander";
import { EventEmitter } from "node:events";
import type { connect } from "node:net";
import { hostCommand, doctorLegs, postureCheck, probeHostTcp, type DoctorDeps, type CheckRow } from "../src/commands/host.js";
import type { HostEntry } from "../src/host-registry.js";
import type { CrossHostResult } from "../src/cross-host-executor.js";
import { ConfigStore } from "../src/config-store.js";
import { configCommand } from "../src/commands/config.js";

// OPR.0.4.4.13 FR-1 — rig host add / list. Registry path is steered via
// OPENRIG_HOME so tests never touch the operator's real ~/.openrig.
describe("rig host add/list", () => {
  let dir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostcmd-"));
    savedHome = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = dir;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.OPENRIG_HOME;
    else process.env.OPENRIG_HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function capture(fn: () => Promise<void>): Promise<{ out: string[]; err: string[]; exitCode: number | undefined }> {
    return new Promise(async (resolve) => {
      const out: string[] = []; const err: string[] = [];
      const ol = console.log; const oe = console.error; const oc = process.exitCode;
      process.exitCode = undefined;
      console.log = (...a: unknown[]) => out.push(a.join(" "));
      console.error = (...a: unknown[]) => err.push(a.join(" "));
      try { await fn(); } finally { console.log = ol; console.error = oe; }
      const exitCode = process.exitCode as number | undefined;
      process.exitCode = oc;
      resolve({ out, err, exitCode });
    });
  }

  function run(argv: string[]) {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(hostCommand());
    return prog.parseAsync(["node", "rig", "host", ...argv]);
  }

  it("add writes the entry and teaches the doctor next step", async () => {
    const { out, exitCode } = await capture(() => run(["add", "--id", "vps-1", "--transport", "ssh", "--target", "vps-1.tailnet", "--user", "openrig"]));
    expect(exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("Added host 'vps-1' (ssh)");
    expect(out.join("\n")).toContain("rig host doctor vps-1");
    expect(out.join("\n")).toContain("Remote FEED requires an HTTP host entry");
    expect(out.join("\n")).not.toContain("rig config set feed.subscriptions.");
  });

  it.each(["laptop", "laptop.prod-1"])("HTTP add advertises a working opt-in command for %s", async (id) => {
    const configPath = path.join(dir, "config.json");
    const store = new ConfigStore(configPath);
    store.set("feed.subscriptions.progress", "false");
    const before = fs.readFileSync(configPath, "utf8");
    const { out, exitCode } = await capture(() => run(["add", "--id", id, "--transport", "http", "--url", "http://laptop:7433"]));
    expect(exitCode).toBeUndefined();
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);

    const nextStep = out.map((line) => line.trim()).find((line) => line.startsWith("rig config set "));
    expect(nextStep).toBeDefined();
    const program = new Command().addCommand(configCommand(configPath));
    const applied = await capture(() => program.parseAsync(["node", ...nextStep!.split(/\s+/)]));
    expect(applied.exitCode).toBeUndefined();
    expect(applied.err).toEqual([]);
    const saved = new ConfigStore(configPath);
    expect(saved.get(`feed.subscriptions.${id}.enabled`)).toBe(true);
    expect(saved.get("feed.subscriptions.progress")).toBe(false);
    expect(saved.get("feed.subscriptions.other-host.enabled")).toBe(false);
  });

  it("an HTTP host with a reserved feed name stays registered without an unusable command", async () => {
    const { out, exitCode } = await capture(() => run(["add", "--id", "progress", "--transport", "http", "--url", "http://laptop:7433"]));
    expect(exitCode).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "hosts.yaml"), "utf8")).toContain("id: progress");
    expect(out.join("\n")).toContain("reserved by feed settings");
    expect(out.join("\n")).not.toContain("rig config set feed.subscriptions.");
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false);
  });

  it("add surfaces the loader's own validation error at add-time (both bearers)", async () => {
    const { err, exitCode } = await capture(() => run(["add", "--id", "h1", "--transport", "http", "--url", "http://x", "--bearer-env", "A", "--bearer-file", "/b"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("not both");
  });

  it("list renders pointers and NEVER a resolved secret value (qa1 hygiene guard)", async () => {
    vi.stubEnv("FACTORY_TOKEN", "super-secret-bearer-value");
    const added = await capture(() => run(["add", "--id", "f1", "--transport", "http", "--url", "http://100.64.0.9:7433", "--bearer-env", "FACTORY_TOKEN", "--json"]));
    expect(JSON.parse(added.out.join("\n"))).toMatchObject({ ok: true, entry: { id: "f1" } });
    expect(added.err).toEqual([]);
    const { out } = await capture(() => run(["list"]));
    const text = out.join("\n");
    expect(text).toContain("env:FACTORY_TOKEN");
    expect(text).not.toContain("super-secret-bearer-value");
    const { out: jsonOut } = await capture(() => run(["list", "--json"]));
    expect(jsonOut.join("")).toContain("FACTORY_TOKEN");
    expect(jsonOut.join("")).not.toContain("super-secret-bearer-value");
  });

  it("list on an empty registry teaches add", async () => {
    const { out } = await capture(() => run(["list"]));
    expect(out.join("\n")).toContain("rig host add --id");
  });
});

// ---------------------------------------------------------------------------
// OPR.0.4.4.13 FR-1/FR-2 — doctor legs + posture (mocked deps; no network).
// ---------------------------------------------------------------------------
describe("rig host doctor — stepwise distinct errors + three-valued posture", () => {
  // Same OPENRIG_HOME steering as the add/list suite: the doctor-CLI case
  // seeds a registry via `host add` and must NEVER touch the operator's
  // real ~/.openrig (the shared-singleton doctrine).
  let dir: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostdoc-"));
    savedHome = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = dir;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.OPENRIG_HOME;
    else process.env.OPENRIG_HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const sshHost: HostEntry = { id: "vps-1", transport: "ssh", target: "vps-1.tailnet", user: "openrig" };

  const okRun = (stdout: string): CrossHostResult => ({ ok: true, failedStep: "none", stdout, stderr: "", remoteExitCode: 0 });
  const failRun = (): CrossHostResult => ({ ok: false, failedStep: "remote-command-failed", stdout: "", stderr: "not found", remoteExitCode: 127 });

  function depsFromScript(script: (argv: readonly string[]) => CrossHostResult, probe: "open" | "closed" = "closed"): DoctorDeps {
    return {
      run: async (_h, argv) => script(argv),
      httpGet: async () => ({ status: 200, body: "ok" }),
      tcpProbe: async () => probe,
    };
  }

  it("distinct error: SSH unreachable stops at the first leg", async () => {
    const deps = depsFromScript(() => ({ ok: false, failedStep: "ssh-unreachable", sshStderr: "connect refused" }));
    const rows = await doctorLegs(sshHost, deps);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step: "transport-reachability", status: "fail" });
    expect(rows[0]!.fix).toContain("ssh");
  });

  it("distinct error: SSH works but rig binary missing", async () => {
    const deps = depsFromScript((argv) => (argv[0] === "true" ? okRun("") : failRun()));
    const rows = await doctorLegs(sshHost, deps);
    expect(rows[0]!.status).toBe("pass");
    expect(rows[1]).toMatchObject({ step: "remote-rig-binary", status: "fail" });
    expect(rows[1]!.fix).toContain("npm install -g @openrig/cli");
  });

  it("distinct error: rig installed but daemon down", async () => {
    const deps = depsFromScript((argv) => {
      if (argv[0] === "true") return okRun("");
      if (argv[1] === "--version") return okRun("0.4.4");
      if (argv[1] === "daemon") return okRun("Daemon stopped");
      return okRun("{}");
    });
    const rows = await doctorLegs(sshHost, deps);
    expect(rows[2]).toMatchObject({ step: "remote-daemon-health", status: "fail" });
    expect(rows[2]!.fix).toContain("rig daemon start");
    expect(rows).toHaveLength(3); // identity leg not attempted without a daemon
  });

  it("reachable SSH host + unconfirmable daemon status reports health UNKNOWN, never unreachable or confirmed-down", async () => {
    const deps = depsFromScript((argv) => {
      if (argv[0] === "true") return okRun("");
      if (argv[1] === "--version") return okRun("0.4.7");
      if (argv[1] === "daemon") {
        return {
          ok: false,
          failedStep: "remote-daemon-unreachable",
          stdout: "",
          stderr: "Daemon not running",
          remoteExitCode: 1,
        };
      }
      return failRun();
    });

    const rows = await doctorLegs(sshHost, deps);
    expect(rows[0]).toMatchObject({ step: "transport-reachability", status: "pass" });
    expect(rows[1]).toMatchObject({ step: "remote-rig-binary", status: "pass" });
    expect(rows[2]).toMatchObject({ step: "remote-daemon-health", status: "unknown" });
    expect(rows[2]!.detail).toContain("could not confirm");
    expect(rows[2]!.detail).not.toContain("unreachable");
    expect(rows[2]!.fix).not.toContain("rig daemon start");
  });

  it("all legs green when the remote answers", async () => {
    const calls: string[][] = [];
    const deps = depsFromScript((argv) => {
      calls.push([...argv]);
      if (argv[0] === "true") return okRun("");
      if (argv[1] === "--version") return okRun("0.4.4");
      if (argv[1] === "daemon") return okRun("Daemon running (pid 1)");
      if (argv[1] === "ps") return okRun(JSON.stringify({ entries: [{ rigName: "kernel" }] }));
      return failRun();
    });
    const rows = await doctorLegs(sshHost, deps);
    expect(rows.map((r) => r.status)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(calls).toContainEqual(["rig", "ps", "--json", "--limit", "5"]);
    expect(calls).not.toContainEqual(["rig", "whoami", "--json"]);
  });

  it("posture: UNKNOWN is never pass — unreadable sshd/ufw report unknown WITH fixes", async () => {
    const deps = depsFromScript((argv) => {
      const cmd = String(argv[2] ?? "");
      if (cmd.startsWith("id -u")) return okRun("1001");
      return okRun(""); // sshd -T, ufw, tailscale, ss all unreadable
    });
    const rows = await postureCheck(sshHost, deps);
    const byStep = Object.fromEntries(rows.map((r) => [r.step, r]));
    expect(byStep["nonroot-openrig-user"]!.status).toBe("pass");
    for (const step of ["root-ssh-disabled", "key-only-ssh", "ufw-default-deny-incoming", "tailnet-ingress-allowed", "tailscale-minimal-trust", "daemon-bind-not-public"]) {
      expect(byStep[step]!.status, step).toBe("unknown");
      expect(byStep[step]!.fix, step).toBeTruthy();
    }
    // no public addr given -> probes are unknown, never silently pass
    expect(byStep["public-daemon-port-unreachable"]!.status).toBe("unknown");
  });

  it("posture: publicly reachable daemon port FAILS LOUDLY (the smoke-test hardening bar)", async () => {
    const deps = depsFromScript(() => okRun(""), "open");
    const rows = await postureCheck(sshHost, deps, { publicAddr: "203.0.113.7" });
    const probe = rows.find((r) => r.step === "public-daemon-port-unreachable")!;
    expect(probe.status).toBe("fail");
    expect(probe.detail).toContain("203.0.113.7:7433");
  });

  it("posture uses selected service ports and keeps unknown outside observations unknown", async () => {
    const run = vi.fn(async (_host: HostEntry, argv: readonly string[]) => okRun(String(argv[2]).startsWith("ss -tln") ? "LISTEN 0 511 127.0.0.1:17433 0.0.0.0:*" : ""));
    const tcpProbe = vi.fn(async () => "unknown" as const);
    const rows = await postureCheck(sshHost, { run, tcpProbe, httpGet: async () => ({ status: 200, body: "" }) },
      { publicAddr: "203.0.113.7", daemonPort: 17433, sshPort: 2222 });
    expect(rows.find(row => row.step === "daemon-bind-not-public")?.status).toBe("pass");
    expect(rows.find(row => row.step === "daemon-bind-not-public")?.detail).toContain(":17433");
    expect(rows.slice(-2).map(row => row.status)).toEqual(["unknown", "unknown"]);
    expect(tcpProbe).toHaveBeenNthCalledWith(1, "203.0.113.7", 17433, 5000);
    expect(tcpProbe).toHaveBeenNthCalledWith(2, "203.0.113.7", 2222, 5000);
    expect(run.mock.calls.some(([, argv]) => String(argv[2]).includes(":17433"))).toBe(true);
  });

  it("does not attribute a neighboring port with the same decimal prefix", async () => {
    const d = depsFromScript(argv => okRun(String(argv[2]).startsWith("ss -tln") ? "LISTEN 0 511 127.0.0.1:17433 0.0.0.0:*" : ""));
    const rows = await postureCheck(sshHost, d, { daemonPort: 1743 });
    expect(rows.find(row => row.step === "daemon-bind-not-public")).toMatchObject({ status: "unknown", detail: expect.stringContaining(":1743") });
  });

  it.each(["EACCES", "EPERM", "EAI_AGAIN"])("local TCP observer failure %s cannot certify closed public ingress", async code => {
    const sockets: Array<EventEmitter & { destroy: ReturnType<typeof vi.fn> }> = [];
    const dial = vi.fn(() => {
      const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() }); sockets.push(socket);
      queueMicrotask(() => socket.emit("error", Object.assign(new Error("observer unavailable"), { code })));
      return socket;
    });
    const d = depsFromScript(() => okRun(""));
    d.tcpProbe = (target, port, timeout) => probeHostTcp(target, port, timeout, dial as unknown as typeof connect);
    const rows = await postureCheck(sshHost, d, { publicAddr: "203.0.113.7", daemonPort: 17433, sshPort: 2222 });
    expect(rows.slice(-2).every(row => row.status === "unknown" && !!row.fix)).toBe(true);
    expect(sockets).toHaveLength(2); expect(sockets.every(socket => socket.destroy.mock.calls.length === 1)).toBe(true);
    expect(dial).toHaveBeenNthCalledWith(1, { host: "203.0.113.7", port: 17433, timeout: 5000 });
  });

  it.each(["connect", "timeout", "error", "close"])("TCP observer settles and closes its owned socket on %s", async event => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const dial = vi.fn(() => { queueMicrotask(() => socket.emit(event, Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))); return socket; });
    expect(await probeHostTcp("203.0.113.7", 17433, 5000, dial as unknown as typeof connect)).toBe(event === "connect" ? "open" : event === "close" ? "unknown" : "closed");
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["unresolved", "resolved", "lookup-error"])("TCP observer distinguishes DNS %s from a closed endpoint", async state => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const dial = vi.fn(() => {
      queueMicrotask(() => {
        if (state === "resolved") socket.emit("lookup", null, "203.0.113.7");
        if (state === "lookup-error") socket.emit("lookup", new Error("lookup unavailable"), undefined);
        socket.emit("timeout");
      }); return socket;
    });
    expect(await probeHostTcp("owned-host.invalid", 17433, 5000, dial as unknown as typeof connect)).toBe(state === "resolved" ? "closed" : "unknown");
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  // R2-B1 regressions — the two false-green classes, pinned.
  it("posture: a DENY rule on tailscale0 must NOT pass the ingress item", async () => {
    const deps = depsFromScript((argv) => {
      const cmd = String(argv[2] ?? "");
      if (cmd.includes("ufw status")) return okRun("Status: active\nDefault: deny (incoming), allow (outgoing)\nAnywhere on tailscale0 DENY IN Anywhere\n");
      return okRun("");
    });
    const rows = await postureCheck(sshHost, deps);
    const ingress = rows.find((r) => r.step === "tailnet-ingress-allowed")!;
    expect(ingress.status).toBe("fail");
    expect(ingress.detail).toContain("no ALLOW IN");
  });

  it("posture: daemon bound to a SPECIFIC public IP fails exactly like a wildcard", async () => {
    const deps = depsFromScript((argv) => {
      const cmd = String(argv[2] ?? "");
      if (cmd.includes("ss -tln")) return okRun("LISTEN 0 511 148.113.200.37:7433 0.0.0.0:*");
      return okRun("");
    });
    const rows = await postureCheck(sshHost, deps);
    const bind = rows.find((r) => r.step === "daemon-bind-not-public")!;
    expect(bind.status).toBe("fail");
    expect(bind.detail).toContain("148.113.200.37");
  });

  it("posture: tailnet CGNAT bind (100.64/10) passes; out-of-range 100.x fails", async () => {
    const mk = (addr: string) => depsFromScript((argv) => {
      const cmd = String(argv[2] ?? "");
      if (cmd.includes("ss -tln")) return okRun(`LISTEN 0 511 ${addr}:7433 0.0.0.0:*`);
      return okRun("");
    });
    const inRange = await postureCheck(sshHost, mk("100.88.0.21"));
    expect(inRange.find((r) => r.step === "daemon-bind-not-public")!.status).toBe("pass");
    const outOfRange = await postureCheck(sshHost, mk("100.1.2.3"));
    expect(outOfRange.find((r) => r.step === "daemon-bind-not-public")!.status).toBe("fail");
  });

  it("posture: multi-listener where ONE is public fails, naming the offender", async () => {
    const deps = depsFromScript((argv) => {
      const cmd = String(argv[2] ?? "");
      if (cmd.includes("ss -tln")) return okRun("LISTEN 0 511 127.0.0.1:7433 0.0.0.0:*\nLISTEN 0 511 203.0.113.9:7433 0.0.0.0:*");
      return okRun("");
    });
    const rows = await postureCheck(sshHost, deps);
    const bind = rows.find((r) => r.step === "daemon-bind-not-public")!;
    expect(bind.status).toBe("fail");
    expect(bind.detail).toContain("203.0.113.9");
    expect(bind.detail).not.toContain("127.0.0.1:");
  });

  it("posture: Tailscale SSH enabled FAILS the minimal-trust item", async () => {
    const deps = depsFromScript((argv) => {
      const cmd = String(argv[2] ?? "");
      if (cmd.includes("tailscale status")) return okRun(JSON.stringify({ Self: { PrimaryRoutes: [] } }));
      if (cmd.includes("tailscale debug prefs")) return okRun(JSON.stringify({ RunSSH: true }));
      return okRun("");
    });
    const rows = await postureCheck(sshHost, deps);
    const ts = rows.find((r) => r.step === "tailscale-minimal-trust")!;
    expect(ts.status).toBe("fail");
    expect(ts.detail).toContain("Tailscale SSH enabled: true");
    expect(ts.fix).toContain("tailscale set --ssh=false");
  });

  it("posture: green path parses real-shaped outputs", async () => {
    const deps = depsFromScript((argv) => {
      const cmd = String(argv[2] ?? "");
      if (cmd.startsWith("id -u")) return okRun("1001");
      if (cmd.includes("sshd -T")) return okRun("permitrootlogin no\npasswordauthentication no\n");
      if (cmd.includes("ufw status")) return okRun("Status: active\nDefault: deny (incoming), allow (outgoing)\nAnywhere on tailscale0 ALLOW IN Anywhere\n");
      if (cmd.includes("tailscale status")) return okRun(JSON.stringify({ Self: { PrimaryRoutes: [] } }));
      if (cmd.includes("tailscale debug prefs")) return okRun(JSON.stringify({ RunSSH: false }));
      if (cmd.includes("ss -tln")) return okRun("LISTEN 0 511 127.0.0.1:7433 0.0.0.0:*");
      return okRun("");
    });
    const rows = await postureCheck(sshHost, deps, { publicAddr: "203.0.113.7" });
    const nonPass = rows.filter((r) => r.status !== "pass");
    expect(nonPass).toEqual([]);
  });

  it("posture over http transport: EVERY item unknown with the ssh fix (honest, no shell)", async () => {
    const httpHost: HostEntry = { id: "h1", transport: "http", url: "http://x", bearer_env: "T" };
    const rows = await postureCheck(httpHost, { run: async () => okRun(""), httpGet: async () => ({ status: 200, body: "" }), tcpProbe: async () => "closed" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: CheckRow) => r.status === "unknown")).toBe(true);
  });

  it("does not misdiagnose a native Windows host using the POSIX VPS posture profile", async () => {
    const run = vi.fn(async () => ({ ok: false, failedStep: "remote-command-not-found", stdout: "", stderr: "sh unavailable", remoteExitCode: 127, hint: "" } as CrossHostResult));
    const tcpProbe = vi.fn(async () => "closed" as const);
    const rows = await postureCheck({ ...sshHost, remoteShell: "powershell", rigPath: "C:/OpenRig/bin.js" }, {
      run, httpGet: async () => ({ status: 200, body: "" }), tcpProbe,
    }, { publicAddr: "203.0.113.7" });
    expect(rows).toHaveLength(9);
    expect(rows.every(row => row.status === "unknown" && row.detail.includes("POSIX") && !!row.fix)).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(tcpProbe).not.toHaveBeenCalled();
  });

  it("doctor over http: anonymous (URL-only) host with an answering daemon passes auth-neutrally (no 'authenticated' claim)", async () => {
    const anonHost: HostEntry = { id: "anon-h", transport: "http", url: "http://x" };
    const rows = await doctorLegs(anonHost, { run: async () => okRun(""), httpGet: async () => ({ status: 200, body: "ok" }), tcpProbe: async () => "closed" });
    const reach = rows.find((r) => r.step === "transport-reachability")!;
    expect(reach.status).toBe("pass");
    const identity = rows.find((r) => r.step === "remote-identity")!;
    expect(identity.status).toBe("pass");
    expect(identity.detail).toContain("anonymous");
    expect(identity.detail).not.toContain("authenticated");
  });

  it("doctor over http: anonymous host that gets 401 is told to add a bearer to the hosts.yaml entry, NOT that a token is wrong", async () => {
    const anonHost: HostEntry = { id: "anon-h", transport: "http", url: "http://x" };
    const rows = await doctorLegs(anonHost, { run: async () => okRun(""), httpGet: async () => ({ status: 401, body: "no" }), tcpProbe: async () => "closed" });
    const reach = rows.find((r) => r.step === "transport-reachability")!;
    expect(reach.status).toBe("fail");
    expect(reach.detail).toContain("requires Authorization");
    expect(reach.fix).toContain("hosts.yaml");
    expect(reach.fix).not.toContain("token is wrong");
    expect(reach.fix).not.toContain("rig host add");
  });

  it("doctor over http: a CONFIGURED-token host that gets 401 keeps the wrong-token guidance (unchanged branch)", async () => {
    vi.stubEnv("DOCTOR_TOK", "tok-1");
    const cfgHost: HostEntry = { id: "cfg-h", transport: "http", url: "http://x", bearer_env: "DOCTOR_TOK" };
    const rows = await doctorLegs(cfgHost, { run: async () => okRun(""), httpGet: async () => ({ status: 401, body: "no" }), tcpProbe: async () => "closed" });
    const reach = rows.find((r) => r.step === "transport-reachability")!;
    expect(reach.status).toBe("fail");
    expect(reach.detail).toContain("rejected the bearer");
    expect(reach.fix).toContain("token is wrong");
  });

  it("doctor CLI: unknown host id is the DISTINCT registry error", async () => {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(hostCommand({ run: async () => okRun(""), httpGet: async () => ({ status: 200, body: "" }), tcpProbe: async () => "closed" }));
    const err: string[] = [];
    const oe = console.error; const oc = process.exitCode; process.exitCode = undefined;
    console.error = (...a: unknown[]) => err.push(a.join(" "));
    try {
      await capturePrelude();
      await prog.parseAsync(["node", "rig", "host", "doctor", "nope"]);
    } finally { console.error = oe; }
    const code = process.exitCode; process.exitCode = oc;
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("registry:");
    expect(err.join("\n")).toContain("unknown host id 'nope'");
  });

  it("doctor's reply route reads the same hosts.yaml and host-bindings.json rig send does", async () => {
    const { replyRouteFromDisk } = await import("../src/commands/host.js");
    const { resolveCrossHostTarget } = await import("../src/cross-host-target.js");
    fs.writeFileSync(path.join(dir, "hosts.yaml"), [
      "hosts:",
      "  - id: old-box-b",
      "    transport: http",
      "    url: http://10.0.0.9:7433",
      "  - id: box-b",
      "    transport: http",
      "    url: http://10.0.0.5:7433",
    ].join("\n") + "\n");
    // Both aliases learned one identity; hosts.yaml order, not sidecar order, picks the entry.
    const learned = { hostId: "host-0b0b0b0b", firstObservedAt: "x", lastObservedAt: "x" };
    fs.writeFileSync(path.join(dir, "host-bindings.json"), JSON.stringify({ version: 1, bindings: { "box-b": learned, "old-box-b": learned } }));
    expect(replyRouteFromDisk("host-0b0b0b0b")?.id).toBe("old-box-b");
    expect(resolveCrossHostTarget("pm@some-rig@host-0b0b0b0b", undefined)).toMatchObject({ ok: true, sugarHost: "old-box-b" });
    expect(replyRouteFromDisk("host-unknown")).toBeNull();
  });

  // seed a registry for the doctor CLI test above
  async function capturePrelude(): Promise<void> {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(hostCommand());
    const ol = console.log; console.log = () => {};
    try { await prog.parseAsync(["node", "rig", "host", "add", "--id", "seeded", "--transport", "ssh", "--target", "s.host"]); } finally { console.log = ol; }
  }
});
