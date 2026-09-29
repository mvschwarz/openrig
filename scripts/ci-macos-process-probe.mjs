// Hosted macOS only. Run inside the package suite's existing sandbox, before PATH changes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { join } from "node:path";

function inspect(file) {
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Not a regular file: ${file}`);
  return { mode: (stat.mode & 0o7777).toString(8), sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

function observe(file, pids) {
  const r = spawnSync(file, ["-p", pids.join(","), "-o", "pid="], { encoding: "utf8", timeout: 5000 });
  return { status: r.status, signal: r.signal, code: r.error?.code,
    stderr: (r.stderr ?? "").slice(0, 2048),
    visible: (r.stdout ?? "").trim().split(/\s+/).filter(Boolean).map(Number) };
}

function requireCopy(original, copy, observed, pids) {
  assert.equal(copy.mode, "755");
  assert.equal(copy.sha256, original.sha256);
  assert.equal(observed.status, 0, JSON.stringify(observed));
  assert.equal(observed.signal, null);
  assert.equal(observed.code, undefined);
  assert.deepEqual([...observed.visible].sort((a, b) => a - b), [...pids].sort((a, b) => a - b));
}

async function listen(address) {
  const server = net.createServer(socket => socket.end("probe"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, resolve);
  });
  return server;
}

async function connect(address) {
  return new Promise(resolve => {
    const socket = net.createConnection(address);
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.resume();
    socket.once("end", () => done("connected"));
    socket.once("error", error => done(error.code));
    socket.setTimeout(2000, () => done("timeout"));
  });
}

function requireConfinement(result) {
  assert.ok(["EPERM", "EACCES"].includes(result.external), JSON.stringify(result));
  assert.equal(result.loopback, "connected");
  assert.equal(result.ownedUnix, "connected");
}

assert.equal(process.platform, "darwin");
assert.equal(process.env.CI, "true");
const root = realpathSync(process.env.TMPDIR);
assert.equal(realpathSync(process.env.HOME), join(root, "home"));
assert.equal(realpathSync(process.env.TMUX_TMPDIR), root);
const copyPath = join(root, "bin", "ps");
assert.equal(realpathSync(copyPath), copyPath);
const original = inspect("/bin/ps"), copy = inspect(copyPath);
console.log("CI_PS_FILES " + JSON.stringify({ original, copy }));
// Validate bytes/mode before executing the job-owned copy.
assert.equal(copy.mode, "755");
assert.equal(copy.sha256, original.sha256);

const child = spawn(process.execPath, ["-e", "process.stdin.resume(); setTimeout(() => process.exit(0), 30000)"], { stdio: ["pipe", "ignore", "ignore"] });
const childExit = once(child, "exit");
try {
  await once(child, "spawn");
  const pids = [process.pid, child.pid];
  const pair = { original: observe("/bin/ps", pids), copy: observe(copyPath, pids) };
  console.log("CI_PS_PAIR " + JSON.stringify(pair));
  requireCopy(original, copy, pair.copy, pids);

  const servers = [];
  try {
    const unixPath = join(root, "process-probe.sock");
    servers.push(await listen(unixPath));
    const tcp = await listen({ host: "127.0.0.1", port: 0 });
    servers.push(tcp);
    const confinement = {
      external: await connect({ host: "192.0.2.1", port: 9 }), // documentation-only TEST-NET; no provider
      loopback: await connect({ host: "127.0.0.1", port: tcp.address().port }),
      ownedUnix: await connect({ path: unixPath }),
    };
    console.log("CI_PS_CONFINEMENT " + JSON.stringify(confinement));
    requireConfinement(confinement);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
} finally {
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try { await childExit; } finally { clearTimeout(timer); }
}
console.log("CI_PS_COPY_ADMITTED");
