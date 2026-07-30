import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Command } from "commander";
import { hostCommand, doctorLegs, postureCheck, type DoctorDeps, type CheckRow } from "../src/commands/host.js";
import type { HostEntry } from "../src/host-registry.js";
import type { CrossHostResult } from "../src/cross-host-executor.js";

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
  });

  it("add surfaces the loader's own validation error at add-time (both bearers)", async () => {
    const { err, exitCode } = await capture(() => run(["add", "--id", "h1", "--transport", "http", "--url", "http://x", "--bearer-env", "A", "--bearer-file", "/b"]));
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("not both");
  });

  it("list renders pointers and NEVER a resolved secret value (qa1 hygiene guard)", async () => {
    vi.stubEnv("FACTORY_TOKEN", "super-secret-bearer-value");
    await capture(() => run(["add", "--id", "f1", "--transport", "http", "--url", "http://100.64.0.9:7433", "--bearer-env", "FACTORY_TOKEN"]));
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
    const inRange = await postureCheck(sshHost, mk("100.103.199.127"));
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

  // seed a registry for the doctor CLI test above
  async function capturePrelude(): Promise<void> {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(hostCommand());
    const ol = console.log; console.log = () => {};
    try { await prog.parseAsync(["node", "rig", "host", "add", "--id", "seeded", "--transport", "ssh", "--target", "s.host"]); } finally { console.log = ol; }
  }
});
