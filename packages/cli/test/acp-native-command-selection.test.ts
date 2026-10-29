import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAcpAgentCommand } from "../src/acp/agent-command.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
it.runIf(process.platform === "win32")("honors selected PATHEXT order and an explicitly empty extension list", () => {
  root = mkdtempSync(join(tmpdir(), "acp-native-selection-"));
  const bin = join(root, "bin"), pkg = join(bin, "node_modules", "@fixture", "agent");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@fixture/agent", bin: { agent: "main.js" } }));
  const entry = join(pkg, "main.js");
  writeFileSync(entry, "// synthetic selection only, never executed\n");
  const shim = join(bin, "agent.cmd"), native = join(bin, "agent.exe");
  writeFileSync(shim, '"%_prog%" "%dp0%\\node_modules\\@fixture\\agent\\main.js" %*\r\n');
  writeFileSync(native, "synthetic selection only, never executed");
  const env = { pAtH: `${bin};${dirname(process.execPath)}`, pAtHeXt: ".CMD;.EXE" };
  expect(resolveAcpAgentCommand("agent", root, env)).toEqual({ command: realpathSync(process.execPath), prefix: [realpathSync(entry)] });
  const selectedNative = resolveAcpAgentCommand("agent", root, { ...env, pAtHeXt: ".EXE;.CMD" });
  expect(selectedNative.command.toLowerCase()).toBe(realpathSync(native).toLowerCase());
  expect(selectedNative.prefix).toEqual([]);
  expect(resolveAcpAgentCommand("agent", root, { ...env, PATHEXT: "" })).toEqual({ command: "agent", prefix: [] });
  expect(resolveAcpAgentCommand(shim, root, { ...env, PATHEXT: "" }).prefix).toEqual([realpathSync(entry)]);
});
