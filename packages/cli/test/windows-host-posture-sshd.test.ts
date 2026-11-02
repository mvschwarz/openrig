import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { WINDOWS_POSTURE_ARGV, WINDOWS_POSTURE_SCRIPT, windowsPostureRows } from "../src/windows-host-posture.js";

// Explicit owned OpenSSH binaries only. No server/listener or Windows service starts.
const binaries = process.env.OPENRIG_TEST_OPENSSH_DIR;
it.runIf(process.platform === "win32" && !!binaries)("queries the selected sshd configuration and Match context without service effects", async () => {
  const { execWindowsJobFile } = await import("../../daemon/src/domain/windows-job-exec.js");
  const { spawnWindowsJobProcess } = await import("../../daemon/src/domain/windows-job-process.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sshd-posture-owned-"));
  const key = path.join(root, "owned_host_key"), config = path.join(root, "server # 配置.conf"), log = path.join(root, "must-not-create.log");
  try {
    await execWindowsJobFile(path.join(binaries!, "ssh-keygen.exe"), ["-q", "-t", "ed25519", "-N", "", "-f", key], { timeout: 10000 });
    fs.writeFileSync(config, [`HostKey ${key.replaceAll("\\", "/")}`, "UseDNS no", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes", "AuthenticationMethods publickey", "DenyGroups administrators", "Match User openrig LocalPort 22222",
      "  PasswordAuthentication yes", "  AuthenticationMethods any", "Match User fixtureadmin LocalPort 22222", "  DenyGroups nobody", ""].join("\n"));
    const command = `"${path.join(binaries!, "sshd.exe")}" -D -e -f "${config}" -o "PubkeyAuthentication yes" -p 22222 -E "${log}"`;
    async function collect(serviceCommand: string, connection: string) {
      // Synthetic service/account inventory, real native argv reader and real sshd query.
      const prefix = `function Get-CimInstance { [pscustomobject]@{PathName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(serviceCommand).toString("base64")}'))} }
function Get-LocalUser { [pscustomobject]@{Name='openrig';Enabled=$true;SID=[pscustomobject]@{Value='S-1-5-21-1-2-3-1001'}};[pscustomobject]@{Name='fixtureadmin';Enabled=$true;SID=[pscustomobject]@{Value='S-1-5-21-1-2-3-500'}} }
function Get-LocalGroupMember {}
function Get-LocalGroup { [pscustomobject]@{Name='administrators'} }
function Get-NetFirewallProfile {}
function Get-NetAdapter {}
function Get-NetTCPConnection {}
function tailscale.exe { throw 'owned unavailable' }
`;
      const child = spawnWindowsJobProcess(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), WINDOWS_POSTURE_ARGV.slice(1),
        { env: { ...process.env, SSH_CONNECTION: connection }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (value: string) => stdout += value); child.stderr!.on("data", (value: string) => stderr += value);
      const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
      const diagnostic = WINDOWS_POSTURE_SCRIPT.replace("  $profiles=@(", "  if ($Error.Count) { [Console]::Error.WriteLine($Error[0].Exception.Message) }\n  $profiles=@(");
      child.stdin!.end(prefix + diagnostic);
      const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); }).finally(() => clearTimeout(timer));
      expect(code, stderr).toBe(0);
      return { ...JSON.parse(stdout.trim()), ownedDiagnostic: stderr };
    }
    for (const port of [22221, 22222]) {
      const facts = await collect(command, `127.0.0.1 12345 127.0.0.1 ${port}`);
      expect(facts.ssh, facts.ownedDiagnostic).toMatchObject({ scope: "service-login-context", administratorContextQualified: true,
        password: port === 22222 ? "yes" : "no", methods: port === 22222 ? "any" : "publickey", denyGroups: port === 22222 ? "nobody" : "administrators" });
      expect(windowsPostureRows(facts).slice(1, 3).map(row => row.status)).toEqual(port === 22222 ? ["unknown", "fail"] : ["pass", "pass"]);
      expect(fs.existsSync(log)).toBe(false);
    }
    for (const [service, connection] of [[command, ""], [command + " -Z", "127.0.0.1 12345 127.0.0.1 22222"],
      [`"${path.join(binaries!, "sshd.exe")}" -f relative.conf`, "127.0.0.1 12345 127.0.0.1 22222"]]) {
      const facts = await collect(service!, connection!);
      expect(facts.ssh).toBeNull();
      expect(windowsPostureRows(facts).slice(1, 3).every(row => row.status === "unknown")).toBe(true);
    }
    // A resolver-dependent Host Match cannot be certified from a guessed host name.
    fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("UseDNS no", "UseDNS yes"));
    expect((await collect(command, "127.0.0.1 12345 127.0.0.1 22222")).ssh).toBeNull();
    expect(fs.existsSync(log)).toBe(false);
  } finally {
    // Only exact files created by this attempt, no recursive or link-following deletion.
    for (const file of [config, key, key + ".pub", log]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
}, 60000);
