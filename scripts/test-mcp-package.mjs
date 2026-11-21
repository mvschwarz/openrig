// After building daemon, CLI and TUI: exercise the packed public entry without workspace aliases or a live daemon.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rewriteDaemonImports } from "./rewrite-daemon-imports.mjs";
import { packEntry } from "./npm-pack-json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages/cli");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-mcp-package-"));
const stage = path.join(temp, "stage");
const consumer = path.join(temp, "consumer");
const home = path.join(temp, "home");
const env = { PATH: process.env.PATH, HOME: home, OPENRIG_HOME: path.join(home, ".openrig"),
  ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) };
const run = (cmd, args, cwd = consumer, childEnv = env) => execFileSync(cmd, args, { cwd, env: childEnv, encoding: "utf8", timeout: 60_000 });

try {
  fs.mkdirSync(stage);
  fs.copyFileSync(path.join(cli, "package.json"), path.join(stage, "package.json"));
  for (const name of ["mcp.js", "mcp.d.ts"]) fs.copyFileSync(path.join(cli, name), path.join(stage, name));
  fs.cpSync(path.join(cli, "dist"), path.join(stage, "dist"), { recursive: true });
  fs.mkdirSync(path.join(stage, "daemon"));
  fs.cpSync(path.join(root, "packages/daemon/dist"), path.join(stage, "daemon/dist"), { recursive: true });
  fs.mkdirSync(path.join(stage, "tui"));
  fs.cpSync(path.join(root, "packages/tui/dist"), path.join(stage, "tui/dist"), { recursive: true });
  // Use the actual release import rewrite, including declaration imports, on the staged compiled bytes.
  rewriteDaemonImports({ cliDir: stage, daemonPackageJsonPath: path.join(root, "packages/daemon/package.json") });
  const packed = packEntry(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], stage,
    { ...env, HOME: path.join(temp, "pack-home"), npm_config_cache: path.join(temp, "npm-cache") }));
  const modules = path.join(consumer, "node_modules");
  fs.mkdirSync(path.join(modules, "@openrig"), { recursive: true });
  fs.mkdirSync(home);
  run("tar", ["-xzf", path.join(temp, packed.filename), "-C", temp], temp);
  fs.renameSync(path.join(temp, "package"), path.join(modules, "@openrig/cli"));
  // Reuse installed third-party dependencies only. In particular no @openrig/daemon workspace link is visible here.
  for (const name of fs.readdirSync(path.join(root, "node_modules"))) {
    if (name.startsWith(".") || name === "@openrig") continue;
    fs.symlinkSync(path.join(root, "node_modules", name), path.join(modules, name), "dir");
  }
  fs.writeFileSync(path.join(consumer, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(consumer, "import.mjs"), `
    import assert from "node:assert/strict";
    import { fileURLToPath } from "node:url";
    import fs from "node:fs";
    import http from "node:http";
    import childProcess from "node:child_process";
    import { createRequire, syncBuiltinESMExports } from "node:module";
    const unexpected = () => { throw new Error("import attempted to start a server, process or request"); };
    http.createServer = unexpected;
    http.request = unexpected;
    childProcess.spawn = unexpected;
    childProcess.execFile = unexpected;
    globalThis.fetch = unexpected;
    syncBuiltinESMExports();
    const entry = await import("@openrig/cli/mcp.js");
    const deep = await import("@openrig/cli/dist/mcp-http.js");
    assert.equal(typeof entry.startMcpHttpServer, "function");
    assert.equal(entry.startMcpHttpServer, deep.startMcpHttpServer);
    assert.equal(entry.McpHttpConfigError, deep.McpHttpConfigError);
    const require = createRequire(import.meta.url);
    assert.equal(require.resolve("@openrig/cli/dist/client"), fileURLToPath(import.meta.resolve("@openrig/cli/dist/client.js")));
    assert.equal(fileURLToPath(import.meta.resolve("@openrig/cli/mcp.js")), ${JSON.stringify(path.join(modules, "@openrig/cli/mcp.js"))});
    assert.equal(JSON.parse(fs.readFileSync(fileURLToPath(import.meta.resolve("@openrig/cli/package.json")), "utf8")).name, "@openrig/cli");
    assert.deepEqual(fs.readdirSync(process.env.HOME), []);
  `);
  run(process.execPath, [path.join(consumer, "import.mjs")]);
  fs.writeFileSync(path.join(consumer, "consumer.ts"), `
    import { startMcpHttpServer, McpHttpConfigError, type McpHttpOptions, type McpAccess } from "@openrig/cli/mcp.js";
    const options: McpHttpOptions = { daemonUrl: "http://127.0.0.1:1", host: "127.0.0.1", port: 0, tokenFile: "local.json" };
    // @ts-expect-error a typed endpoint port must not degrade to any through the package declarations
    const invalidPort: McpHttpOptions = { ...options, port: "not-a-port" };
    const scope: McpAccess = { principal: "local", owner: false, rigs: ["team"], roots: [], workspace: false };
    // @ts-expect-error typed access must not degrade to any either
    const invalidAccess: McpAccess = { ...scope, owner: "yes" };
    const endpoint: Promise<{ url: string; authenticated: boolean; close(): Promise<void> }> = startMcpHttpServer(options);
    const error: Error = new McpHttpConfigError("configuration");
    void endpoint; void error; void invalidPort; void invalidAccess;
  `);
  run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "consumer.ts"]);
  console.log("Packed MCP ESM import, legacy paths, side-effect checks and typed consumer passed (no live server).");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
