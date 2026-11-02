import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

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
}
console.log(JSON.stringify({ nativeControl: process.platform === "win32", literalArgv: true, sftpControl: true }));
