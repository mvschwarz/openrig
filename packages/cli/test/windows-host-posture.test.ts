import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WINDOWS_POSTURE_SCRIPT, WINDOWS_POSTURE_ARGV, windowsPostureRows, windowsPostureCheck } from "../src/windows-host-posture.js";
import { windowsSshCommand } from "../src/windows-ssh-command.js";
import { runCrossHostCommand, type SpawnFn } from "../src/cross-host-executor.js";
import { hostCommand } from "../src/commands/host.js";
import type { DoctorDeps } from "../src/commands/host.js";
import type { HostEntry } from "../src/host-registry.js";

const host: HostEntry = { id: "owned", transport: "ssh", target: "owned", remoteShell: "powershell", rigPath: "C:/OpenRig/bin.js" };
const green = () => ({ version: 1, account: { exists: true, enabled: true, administrator: false, indirectUnresolved: false },
  ssh: { scope: "service-default-global", password: "no", keyboard: "no", publicKey: "yes", gssapi: "no", hostbased: "no", denyGroups: "administrators", administratorGroup: "administrators" },
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

it("selects the Windows profile through the real host doctor CLI and registry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-posture-cli-"));
  const priorHome = process.env.OPENRIG_HOME, priorExit = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    process.env.OPENRIG_HOME = root; process.exitCode = 0;
    fs.writeFileSync(path.join(root, "hosts.yaml"), JSON.stringify({ hosts: [host] }));
    const d = deps(JSON.stringify(green()));
    d.run = vi.fn(async (_host, argv) => ({ ok: true, failedStep: "none", remoteExitCode: 0, stderr: "",
      stdout: argv[0] === "powershell.exe" ? JSON.stringify(green()) : argv[1] === "--version" ? "0.0.1" : argv[1] === "daemon" ? "Daemon running on port 7433" : "[]" }));
    await hostCommand(d).parseAsync(["doctor", host.id, "--posture", "product-factory-windows", "--json"], { from: "user" });
    expect(error).not.toHaveBeenCalled();
    const rows = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(rows).toHaveLength(13);
    expect(rows.find((r: { step: string }) => r.step === "nonadmin-openrig-user").status).toBe("pass");
    expect(rows.slice(-2).every((r: { status: string }) => r.status === "unknown")).toBe(true);
    expect(d.run).toHaveBeenCalledWith(host, WINDOWS_POSTURE_ARGV, { stdin: WINDOWS_POSTURE_SCRIPT });
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
  const result = await runCrossHostCommand(host, WINDOWS_POSTURE_ARGV, { stdin: WINDOWS_POSTURE_SCRIPT, spawn: execute });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!("stdout" in result)) throw new Error("Native collector returned no response");
  expect(JSON.parse(result.stdout)).toMatchObject({ version: 1 });
  expect(windowsPostureRows(JSON.parse(result.stdout))).toHaveLength(7);
}, 30000);
