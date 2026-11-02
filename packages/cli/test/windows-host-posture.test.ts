import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { WINDOWS_POSTURE_SCRIPT, WINDOWS_POSTURE_ARGV, windowsPostureRows, windowsPostureCheck, windowsPostureScriptForPort } from "../src/windows-host-posture.js";
import { resolvePosturePorts } from "../src/host-posture-options.js";
import { windowsSshCommand } from "../src/windows-ssh-command.js";
import { runCrossHostCommand, type SpawnFn } from "../src/cross-host-executor.js";
import { hostCommand, probeHostTcp, postureCheck } from "../src/commands/host.js";
import type { DoctorDeps } from "../src/commands/host.js";
import type { HostEntry } from "../src/host-registry.js";

const host: HostEntry = { id: "owned", transport: "ssh", target: "owned", remoteShell: "powershell", rigPath: "C:/OpenRig/bin.js" };
const green = () => ({ version: 1, daemonPort: 7433, account: { exists: true, enabled: true, administrator: false, indirectUnresolved: false },
  ssh: { scope: "service-login-context", administratorContextQualified: true, methods: "any", password: "no", keyboard: "no", publicKey: "yes", gssapi: "no", hostbased: "no", denyGroups: "administrators", administratorGroup: "administrators" },
  firewall: ["Domain", "Private", "Public"].map(name => ({ name, enabled: "True", inbound: "Block" })),
  tailnetAllow: true, tailscale: { routes: 0, exitNode: false, runSsh: false }, listeners: ["127.0.0.1", "::1", "100.64.0.1", "100.127.255.254"] });
const deps = (stdout: string): DoctorDeps => ({ run: vi.fn(async () => ({ ok: true, failedStep: "none", stdout, stderr: "", remoteExitCode: 0 })),
  httpGet: vi.fn(async () => ({ status: 200, body: "" })), tcpProbe: vi.fn(async () => "closed") });

it("uses the explicit native route with fixed encoded read-only collection and two bounded public probes", async () => {
  const d = deps(JSON.stringify(green()));
  const rows = await windowsPostureCheck(host, d, { publicAddr: "203.0.113.7" });
  expect(rows).toHaveLength(9); expect(rows.every(r => r.status === "pass")).toBe(true);
  expect(d.run).toHaveBeenCalledWith(host, WINDOWS_POSTURE_ARGV, { stdin: WINDOWS_POSTURE_SCRIPT });
  expect(windowsSshCommand(host, WINDOWS_POSTURE_ARGV).length).toBeLessThan(8191);
  expect(d.tcpProbe).toHaveBeenNthCalledWith(1, "203.0.113.7", 7433, 5000);
  expect(d.tcpProbe).toHaveBeenNthCalledWith(2, "203.0.113.7", 22, 5000);
});

it.each([null, {}, { version: 2 }, { ...green(), version: 2 }, { version: 1 }])("keeps missing or unsupported native observations unknown: %j", facts => {
  expect(windowsPostureRows(facts)).toHaveLength(7);
  expect(windowsPostureRows(facts).every(r => r.status === "unknown" && !!r.fix)).toBe(true);
});

it("does not turn nested group uncertainty, unknown ssh settings or NotConfigured profiles into pass", () => {
  const facts = green(); facts.account.indirectUnresolved = true; facts.ssh.denyGroups = "other-group"; facts.ssh.password = "unknown"; facts.firewall[0]!.inbound = "NotConfigured";
  const rows = windowsPostureRows(facts);
  expect(rows.slice(0, 4).map(r => r.status)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
});

it("does not certify global SSH settings without evaluated login contexts", () => {
  const facts = green(); facts.ssh.scope = "service-global-unqualified"; facts.ssh.administratorContextQualified = false;
  expect(windowsPostureRows(facts).slice(1, 3).map(r => r.status)).toEqual(["unknown", "unknown"]);
});

it.each(["administrators !administrators", "administrators,*", "administrators [a-z]*"])("leaves ambiguous administrator deny patterns unknown: %s", denyGroups => {
  const facts = green(); facts.ssh.denyGroups = denyGroups;
  expect(windowsPostureRows(facts)[1]?.status).toBe("unknown");
});

it("uses explicit public-key-only method lists without inventing omitted build-specific alternatives", () => {
  const facts = green();
  expect(windowsPostureRows({ ...facts, ssh: { ...facts.ssh, methods: "publickey,publickey publickey", gssapi: null } })[2]?.status).toBe("pass");
  expect(windowsPostureRows({ ...facts, ssh: { ...facts.ssh, methods: "any", gssapi: null } })[2]?.status).toBe("unknown");
  expect(windowsPostureRows({ ...facts, ssh: { ...facts.ssh, methods: "any", password: "yes", gssapi: null } })[2]?.status).toBe("fail");
  expect(windowsPostureRows({ ...facts, ssh: { ...facts.ssh, methods: "publickey,password", gssapi: null } })[2]?.status).toBe("unknown");
});

it("reports observed insecure account, auth, firewall, tailnet, trust and listener facts", () => {
  const facts = green(); facts.account.administrator = true; facts.ssh.password = "yes"; facts.firewall[1]!.enabled = "False";
  facts.tailnetAllow = false; facts.tailscale.runSsh = true; facts.listeners = ["0.0.0.0"];
  expect(windowsPostureRows(facts).filter(r => r.status === "fail").map(r => r.step)).toEqual([
    "nonadmin-openrig-user", "key-only-ssh", "firewall-default-deny-incoming", "tailnet-ingress-allowed", "tailscale-minimal-trust", "daemon-bind-not-public",
  ]);
});

it.each(["100.63.255.255", "100.128.0.1", "203.0.113.1", "::", "::ffff:127.0.0.1"])("rejects an unqualified listener address %s", address => {
  expect(windowsPostureRows({ ...green(), listeners: [address] }).at(-1)?.status).toBe("fail");
});

it("rejects malformed or duplicate firewall profiles as incomplete observations", () => {
  for (const firewall of [[], [green().firewall[0]], [...green().firewall, green().firewall[0]]]) {
    expect(windowsPostureRows({ ...green(), firewall })[3]?.status).toBe("unknown");
  }
});

it.each(["not json", "null", JSON.stringify({ version: 1 }), "x".repeat(65537)])("keeps unreadable native output unknown", async stdout => {
  const rows = await windowsPostureCheck(host, deps(stdout));
  expect(rows.every(r => r.status === "unknown")).toBe(true);
});

it.each<HostEntry>([{ id: "http", transport: "http", url: "http://127.0.0.1" }, { id: "posix", transport: "ssh", target: "owned" }])("never infers the remote OS from this process for $id", async selected => {
  const d = deps(JSON.stringify(green()));
  const rows = await windowsPostureCheck(selected, d, { publicAddr: "203.0.113.7" });
  expect(rows.every(r => r.status === "unknown")).toBe(true);
  expect(d.run).not.toHaveBeenCalled(); expect(d.tcpProbe).not.toHaveBeenCalled();
});

it("surfaces public connectivity and leaves failed probe observations unknown", async () => {
  const d = deps(JSON.stringify(green())); d.tcpProbe = vi.fn().mockResolvedValueOnce("open").mockRejectedValueOnce(new Error("unavailable"));
  const rows = await windowsPostureCheck(host, d, { publicAddr: "203.0.113.7" });
  expect(rows.slice(-2).map(r => r.status)).toEqual(["fail", "unknown"]);
});

it("uses selected service ports for the native collector and outside probes", async () => {
  const d = deps(JSON.stringify({ ...green(), daemonPort: 17433 }));
  const rows = await windowsPostureCheck(host, d, { daemonPort: 17433, sshPort: 2222, publicAddr: "203.0.113.7" });
  expect(rows.every(row => row.status === "pass")).toBe(true);
  expect(d.run).toHaveBeenCalledWith(host, WINDOWS_POSTURE_ARGV, { stdin: expect.stringContaining("$postureDaemonPort=17433") });
  expect(d.tcpProbe).toHaveBeenNthCalledWith(1, "203.0.113.7", 17433, 5000);
  expect(d.tcpProbe).toHaveBeenNthCalledWith(2, "203.0.113.7", 2222, 5000);
});

it("does not attribute a different listener port to the selected daemon", () => {
  expect(windowsPostureRows(green(), { daemonPort: 17433 }).at(-1)?.status).toBe("unknown");
});

it.each([false, true])("selects the Windows profile through the real host doctor CLI and registry (custom ports=%s)", async custom => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-posture-cli-"));
  const priorHome = process.env.OPENRIG_HOME, priorExit = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    process.env.OPENRIG_HOME = root; process.exitCode = 0;
    fs.writeFileSync(path.join(root, "hosts.yaml"), JSON.stringify({ hosts: [host] }));
    const facts = { ...green(), daemonPort: custom ? 17433 : 7433 };
    const d = deps(JSON.stringify(facts));
    d.run = vi.fn(async (_host, argv) => ({ ok: true, failedStep: "none", remoteExitCode: 0, stderr: "",
      stdout: argv[0] === "powershell.exe" ? JSON.stringify(facts) : argv[1] === "--version" ? "0.0.1" : argv[1] === "daemon" ? "Daemon running on port 7433" : "[]" }));
    await hostCommand(d).parseAsync(["doctor", host.id, "--posture", "product-factory-windows", "--json",
      ...(custom ? ["--daemon-port", "17433", "--ssh-port", "2222", "--public-addr", "203.0.113.7"] : [])], { from: "user" });
    expect(error).not.toHaveBeenCalled();
    const rows = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(rows).toHaveLength(13);
    expect(rows.find((r: { step: string }) => r.step === "nonadmin-openrig-user").status).toBe("pass");
    expect(rows.find((r: { step: string }) => r.step === "daemon-bind-not-public").status).toBe("pass");
    expect(rows.slice(-2).every((r: { status: string }) => r.status === (custom ? "pass" : "unknown"))).toBe(true);
    expect(d.run).toHaveBeenCalledWith(host, WINDOWS_POSTURE_ARGV, { stdin: custom ? expect.stringContaining("$postureDaemonPort=17433") : WINDOWS_POSTURE_SCRIPT });
    if (custom) expect(d.tcpProbe).toHaveBeenNthCalledWith(2, "203.0.113.7", 2222, 5000);
  } finally {
    log.mockRestore(); error.mockRestore(); process.exitCode = priorExit;
    if (priorHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = priorHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each([0, -1, 65536, 1.5, NaN, Infinity, "", "22;exit", "17433junk", null])("refuses invalid service ports before native dispatch: %s", async value => {
  expect(() => resolvePosturePorts({ daemonPort: value })).toThrow(/1 to 65535/);
  expect(() => resolvePosturePorts({ sshPort: value })).toThrow(/1 to 65535/);
  const d = deps(JSON.stringify(green()));
  await expect(windowsPostureCheck(host, d, { daemonPort: value as number })).rejects.toThrow(/1 to 65535/);
  await expect(postureCheck({ ...host, remoteShell: "posix" }, d, { daemonPort: value as number })).rejects.toThrow(/1 to 65535/);
  expect(d.run).not.toHaveBeenCalled(); expect(d.tcpProbe).not.toHaveBeenCalled();
});

it("accepts bounded target ports without consulting this process's daemon environment", () => {
  expect(resolvePosturePorts()).toEqual({ daemonPort: 7433, sshPort: 22 });
  expect(resolvePosturePorts({ daemonPort: "1", sshPort: "65535" })).toEqual({ daemonPort: 1, sshPort: 65535 });
});

it.each([
  { flag: "--daemon-port", value: "0", posture: true }, { flag: "--ssh-port", value: "65536", posture: true },
  { flag: "--daemon-port", value: "1.5", posture: true }, { flag: "--ssh-port", value: "22;exit", posture: true },
  { flag: "--daemon-port", value: "17433", posture: false },
])("CLI rejects $flag=$value (posture=$posture) before any host probe", async ({ flag, value, posture }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invalid-posture-port-"));
  const priorHome = process.env.OPENRIG_HOME, priorExit = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    process.env.OPENRIG_HOME = root; process.exitCode = 0;
    fs.writeFileSync(path.join(root, "hosts.yaml"), JSON.stringify({ hosts: [host] }));
    const d = deps(JSON.stringify(green()));
    await hostCommand(d).exitOverride().parseAsync(["doctor", host.id, ...(posture ? ["--posture", "product-factory-windows"] : []), flag, value], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join(" ")).toMatch(/1 to 65535|require --posture/);
    expect(d.run).not.toHaveBeenCalled(); expect(d.tcpProbe).not.toHaveBeenCalled(); expect(d.httpGet).not.toHaveBeenCalled();
  } finally {
    log.mockRestore(); error.mockRestore(); process.exitCode = priorExit;
    if (priorHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = priorHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.runIf(process.platform === "win32")("delivers the real read-only collector through both native PowerShell launch layers and stdin", async () => {
  const { spawnWindowsJobProcess } = await import("../../daemon/src/domain/windows-job-process.js");
  const execute: SpawnFn = (_file, args) => {
    const match = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(args.at(-1)!);
    if (!match) throw new Error("Expected the production fixed native SSH bootstrap");
    const child = spawnWindowsJobProcess(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", match[1]!], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill("SIGKILL"), 25000); child.once("close", () => clearTimeout(timer));
    return child;
  };
  const listener = net.createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const daemonPort = (listener.address() as net.AddressInfo).port;
  try {
    expect(await probeHostTcp("127.0.0.1", daemonPort, 1000)).toBe("open");
    const result = await runCrossHostCommand(host, WINDOWS_POSTURE_ARGV, { stdin: windowsPostureScriptForPort(daemonPort), spawn: execute });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!("stdout" in result)) throw new Error("Native collector returned no response");
    const facts = JSON.parse(result.stdout);
    expect(facts).toMatchObject({ version: 1, daemonPort });
    expect(windowsPostureRows(facts, { daemonPort }).at(-1)?.status).toBe("pass");
    expect(windowsPostureRows(facts, { daemonPort: daemonPort === 65535 ? 65534 : daemonPort + 1 }).at(-1)?.status).toBe("unknown");
  } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
}, 30000);
