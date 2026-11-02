import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeWindowsNodeFixture } from "./windows-node-fixture.mjs";

const [installed] = process.argv.slice(2);
if (!installed) throw new Error("An isolated installed CLI root is required");
const watcherEntry = await readFile(join(installed, "dist", "chatroom-watch-child.js"), "utf8");
assert.ok(watcherEntry.includes("OPENRIG_HOME") && watcherEntry.includes("OPENRIG_URL"));
const watchHome = await mkdtemp(join(tmpdir(), "openrig-installed-watch-")), watchTrace = [];
const watchRig = "owned|用户 O'Brien", watchText = "installed SSE selected instance";
const watchServer = createServer((req, res) => {
  watchTrace.push({ method: req.method, url: req.url });
  if (req.url === "/healthz") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ status: "ok" })); }
  else if (req.url === "/api/rigs/summary") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify([{ id: "owned-watch-rig", name: watchRig, nodeCount: 0 }])); }
  else if (req.url === "/api/rigs/owned-watch-rig/chat/watch") { res.setHeader("Content-Type", "text/event-stream"); res.end("data: " + JSON.stringify({ sender: "owned-fixture", body: watchText, kind: "message" }) + "\n\n"); }
  else { res.statusCode = 404; res.end("not an owned route"); }
});
try {
  await new Promise((resolve, reject) => { watchServer.once("error", reject); watchServer.listen(0, "127.0.0.1", resolve); });
  const watchUrl = `http://127.0.0.1:${watchServer.address().port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENRIG|RIGGED|PSMUX)_/i.test(key)));
  Object.assign(env, { OPENRIG_HOME: join(watchHome, "wrong"), OPENRIG_URL: "http://127.0.0.1:1", RIGGED_HOME: join(watchHome, "legacy-wrong"), RIGGED_URL: "http://127.0.0.1:2" });
  const child = spawn(process.execPath, [join(installed, "dist", "chatroom-watch-child.js"), watchHome, watchUrl, watchRig], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const output = [], errors = []; child.stdout.on("data", bytes => output.push(bytes)); child.stderr.on("data", bytes => errors.push(bytes));
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Installed watcher SSE timed out")); }, 15000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", status => { clearTimeout(timeout); resolve(status); });
  });
  assert.equal(exit, 0, Buffer.concat(errors).toString("utf8"));
  assert.ok(Buffer.concat(output).toString("utf8").includes(`[owned-fixture] ${watchText}`));
  assert.ok(watchTrace.some(req => req.url === "/healthz"));
  assert.ok(watchTrace.some(req => req.url === "/api/rigs/summary"));
  assert.ok(watchTrace.some(req => req.url === "/api/rigs/owned-watch-rig/chat/watch"));
  assert.ok(watchTrace.every(req => req.method === "GET"));
} finally {
  await new Promise(resolve => { watchServer.close(resolve); watchServer.closeAllConnections(); });
  await rm(watchHome, { recursive: true, force: true });
}
const { defaultWindowDeps } = await import(pathToFileURL(join(installed, "dist", "terminal-window.js")).href);
const values = ["", 'embedded"quote', "end\\", "中文", "%PATH%!&|"];
const stdout = await defaultWindowDeps().exec(process.execPath,
  ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...values], 5000);
assert.deepEqual(JSON.parse(stdout), values);
const { spawnSftpTransport } = await import(pathToFileURL(join(installed, "dist", "lib", "native-sftp-copy.js")).href);
const bytes = Buffer.from([0, 255, 128, 1, 10, 0]);
const child = spawnSftpTransport(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"]);
const chunks = [];
child.stdout.on("data", chunk => chunks.push(chunk)); child.stderr.resume();
const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error("Installed SFTP transport timed out")); }, 5000);
  child.once("error", error => { clearTimeout(timer); reject(error); });
  child.once("close", status => { clearTimeout(timer); resolve(status); });
  child.stdin.end(bytes);
});
assert.equal(code, 0); assert.deepEqual(Buffer.concat(chunks), bytes);
if (process.platform === "win32") {
  const { runNativeLocalCopy } = await import(pathToFileURL(join(installed, "dist", "lib", "native-local-copy.js")).href);
  const root = await mkdtemp(join(tmpdir(), "openrig-installed-time-"));
  try {
    const source = join(root, "source"), destination = join(root, "destination");
    await writeFile(source, "installed native time");
    await utimes(source, new Date(-1000), new Date(-1000));
    const result = await runNativeLocalCopy({ src: { kind: "local", path: source }, dst: { kind: "local", path: destination }, dryRun: false });
    assert.equal(result.ok, true, result.stderr);
    assert.equal(await readFile(destination, "utf8"), "installed native time");
    const script = `(Get-Item -LiteralPath '${destination.replaceAll("'", "''")}').LastWriteTimeUtc.ToString('o')`;
    const observed = await defaultWindowDeps().exec(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], 10000);
    assert.equal(observed.trim(), "1969-12-31T23:59:59.0000000Z");
  } finally { await rm(root, { recursive: true, force: true }); }

  const { attachTmux } = await import(pathToFileURL(join(installed, "dist", "tmux-attachment.js")).href);
  const attachRoot = await mkdtemp(join(tmpdir(), "openrig-installed-attach-")), savedPath = process.env.PATH;
  try {
    const log = join(attachRoot, "calls.jsonl"), logical = "owned|installed-logical";
    const physical = "openrig-native-v1-" + createHash("sha256").update(logical, "utf8").digest("hex");
    const marker = Buffer.from(logical, "utf8").toString("base64url");
    writeWindowsNodeFixture(attachRoot, "tmux", `import fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]!=='-L'||a[1]!=='owned-installed')process.exit(9);if(a[2]==='has-session'){if(a[4]!==${JSON.stringify("=" + physical)})process.exit(9);process.exit(0);}if(a[2]!=='-t'||a[3]!==${JSON.stringify("=" + physical)})process.exit(9);if(a[4]==='show-options')console.log(${JSON.stringify(marker)});else if(a[4]==='display-message')console.log(${JSON.stringify("500 $1:" + physical)});else if(a[4]==='show-environment')console.log('OPENRIG_NODE_ID=owned-installed-node');else if(a[4]==='attach')process.exit(0);else process.exit(8);`);
    process.env.PATH = attachRoot + ";" + (savedPath ?? "");
    assert.equal(await attachTmux({ session: logical, serverArgs: ["-L", "owned-installed"], readOnly: true }), 0);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.filter(argv => argv[4] === "attach").length, 1);
    assert.equal(calls.filter(argv => argv[4] === "display-message").length, 1);
    assert.ok(calls.find(argv => argv[4] === "attach").includes("-r"));
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    await rm(attachRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  const { createTerminalCommandSession, stopTerminalSessionForCleanup } = await import(pathToFileURL(join(installed, "daemon", "dist", "terminal-cleanup-surface.js")).href);
  const commandRoot = await mkdtemp(join(tmpdir(), "openrig-installed-command-")), oldPath = process.env.PATH;
  try {
    const state = join(commandRoot, "state.json"), log = join(commandRoot, "calls.jsonl"), logical = "owned|installed-command";
    const physical = "openrig-native-v1-" + createHash("sha256").update(logical).digest("hex"), marker = Buffer.from(logical).toString("base64url");
    const backend = `import fs from 'node:fs';const raw=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(raw)+'\\n');const a=raw[0]==='--owned-prefix'?raw.slice(1):raw;if(a[0]!=='-L'||a[1]!=='owned-command')process.exit(9);const s=fs.existsSync(${JSON.stringify(state)})?JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8')):{present:false,marker:''};const c=a[2]==='-t'?a[4]:a[2];if(c==='has-session')process.exit(s.present?0:1);if(c==='new-session'){if(s.present||a[a.indexOf('-s')+1]!==${JSON.stringify(physical)})process.exit(8);s.present=true;console.log('$7 123');}else if(c==='show-options')console.log(s.marker);else if(c==='display-message')console.log('$7');else if(c==='if-shell'){if(a.some(v=>v.startsWith('set-option ')))s.marker=${JSON.stringify(marker)};else if(a.includes('kill-session'))s.present=false;else process.exit(7);}else process.exit(6);fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(s));`;
    const pinned = writeWindowsNodeFixture(commandRoot, "ownedmux", backend);
    writeWindowsNodeFixture(commandRoot, "tmux", backend);
    process.env.PATH = commandRoot + ";" + (oldPath ?? "");
    const literalChild = [process.execPath, join(installed, "dist", "chatroom-watch-child.js"), "owned home", "http://127.0.0.1:17439", "用户|rig"];
    assert.equal(await createTerminalCommandSession(logical, literalChild, ["-L", "owned-command"], [pinned, "--owned-prefix"]), "$7");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    const creation = calls.find(argv => argv.includes("new-session"));
    assert.equal(creation[0], "--owned-prefix"); assert.deepEqual(creation.slice(creation.indexOf("--") + 1), literalChild);
    assert.equal(await stopTerminalSessionForCleanup(logical, ["-L", "owned-command"]), "stopped");
    assert.equal(await stopTerminalSessionForCleanup(logical, ["-L", "owned-command"]), "missing");
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(commandRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
console.log(JSON.stringify({ nativeControl: process.platform === "win32", literalArgv: true, sftpControl: true, mappedSingleAttach: process.platform === "win32" }));
