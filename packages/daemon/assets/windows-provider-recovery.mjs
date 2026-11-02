import { resolveWindowsProviderCommand, renderWindowsLaunchArgv } from "../dist/windows-launch-surface.js";

// Resolve only the provider named by structured data. No shell, provider,
// credential or daemon operation occurs in this finite renderer process.
try {
  if (process.platform !== "win32" || process.argv.length !== 3) throw new Error("Windows provider recovery requires one payload");
  const payload = process.argv[2];
  if (payload.length > 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error("Invalid recovery payload");
  const argv = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  if (!Array.isArray(argv) || !["claude", "codex"].includes(argv[0]) || argv.some(word => typeof word !== "string" || word.includes("\0"))) throw new Error("Invalid provider recovery argv");
  const selected = resolveWindowsProviderCommand(argv[0], process.env, process.cwd());
  const script = renderWindowsLaunchArgv([selected.command, ...selected.prefix, ...argv.slice(1)], {},
    { beforeStart: "$openrigStart.WorkingDirectory = (Get-Location).ProviderPath" });
  process.stdout.write(Buffer.from(script, "utf16le").toString("base64"));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Provider recovery resolution failed");
  process.exitCode = 1;
}
