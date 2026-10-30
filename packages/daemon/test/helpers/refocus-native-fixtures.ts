import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterAll } from "vitest";

let python: string | undefined;
export function refocusTestPython(): string {
  if (process.platform !== "win32") return "python3";
  if (python) return python;
  const result = spawnSync("py", ["--list-paths"], { encoding: "utf8", timeout: 5000 });
  const installed = (result.stdout + result.stderr).split(/\r?\n/)
    .map(line => /-V:(\d+\.\d+)\s+\*?\s*(.+)$/.exec(line))
    .find(match => match && fs.existsSync(match[2]!.trim()));
  if (!installed) throw new Error("Native refocus tests require an installed Python 3 runtime");
  return python = installed[2]!.trim();
}

export function writeRefocusNpmFixture(bin: string, body: string): void {
  const pkg = path.join(bin, "node_modules", "@openrig", "cli");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openrig/cli", bin: { rig: "probe.cjs" } }));
  fs.writeFileSync(path.join(pkg, "probe.cjs"), body);
  fs.writeFileSync(path.join(bin, "rig.cmd"), '"%dp0%\\node_modules\\@openrig\\cli\\probe.cjs" %*');
}

let probeRoot: string | undefined;
let budgetRoot: string | undefined;
afterAll(() => { for (const root of [probeRoot, budgetRoot]) if (root) fs.rmSync(root, { recursive: true, force: true }); });

export function writeRefocusBudgetProbe(destination: string): string {
  if (!budgetRoot) {
    budgetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refocus-budget-probe-"));
    const source = `using System; using System.Threading; using System.Text;
public class RefocusBudget { public static int Main() {
  Console.OutputEncoding = new UTF8Encoding(false);
  var partial = Environment.GetEnvironmentVariable("STUB_TRACE_PARTIAL");
  if (!String.IsNullOrEmpty(partial)) { Console.WriteLine(partial); Console.Out.Flush(); }
  var delay = Environment.GetEnvironmentVariable("STUB_TRACE_MS");
  if (!String.IsNullOrEmpty(delay)) Thread.Sleep(Int32.Parse(delay));
  Console.WriteLine("TRACE OK: work and topology"); return 0;
} }`;
    const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Add-Type -TypeDefinition @'\n${source}\n'@ -OutputAssembly $env:REFOCUS_PROBE_EXE -OutputType ConsoleApplication`;
    execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, REFOCUS_PROBE_EXE: path.join(budgetRoot, "probe.exe") }, windowsHide: true, timeout: 15000 });
  }
  const file = destination + ".exe";
  fs.copyFileSync(path.join(budgetRoot, "probe.exe"), file);
  return file;
}
export function writeRefocusCaptureProbe(destination: string): string {
  if (!probeRoot) {
    probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refocus-packet-probe-"));
    const source = `using System; using System.IO; using System.Text;
public class RefocusCapture { public static int Main(string[] args) {
  var utf8 = new UTF8Encoding(false); Console.InputEncoding = utf8; Console.OutputEncoding = utf8;
  File.AppendAllText(Environment.GetEnvironmentVariable("REFOCUS_TEST_ARGV_LOG"), String.Join(" ", args) + "\\n", utf8);
  File.WriteAllText(Environment.GetEnvironmentVariable("REFOCUS_TEST_STDIN_LOG"), Console.In.ReadToEnd(), utf8);
  Console.Write("TRACE OK"); return 0;
} }`;
    const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Add-Type -TypeDefinition @'\n${source}\n'@ -OutputAssembly $env:REFOCUS_PROBE_EXE -OutputType ConsoleApplication`;
    execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, REFOCUS_PROBE_EXE: path.join(probeRoot, "probe.exe") }, windowsHide: true, timeout: 15000 });
  }
  const file = destination + ".exe";
  fs.copyFileSync(path.join(probeRoot, "probe.exe"), file);
  return file;
}
