import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { writeWindowsNodeFixture } from "./windows-node-fixture.mjs";

const [installed] = process.argv.slice(2);
if (!installed) throw new Error("An isolated installed CLI root is required");
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
}
console.log(JSON.stringify({ nativeControl: process.platform === "win32", literalArgv: true, sftpControl: true, mappedSingleAttach: process.platform === "win32" }));
