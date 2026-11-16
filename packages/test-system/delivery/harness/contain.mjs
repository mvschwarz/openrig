// Run one cell with no network but loopback. The stand-in, the private daemon, its tmux server and the real program all
// run inside one network namespace whose only interface is lo, so nothing a program does in a cell can reach a real
// model service, an update server or telemetry, whatever its settings say. A base URL alone isn't that: it moves the
// model requests, not every request a program makes.
//
// The namespace needs no privilege: an unprivileged user namespace maps this user to root just long enough to bring lo
// up, then a nested one maps back to this user's own uid and gid, so the programs run as themselves, not as root.
// Installs happen before, outside it.

import { spawn, spawnSync } from "node:child_process";

/** The argv that runs `argv` inside a fresh loopback-only namespace, as this user. */
export function containedArgv(argv) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("containment needs Linux user namespaces");
  // "$@" carries the command through both shells unchanged, with no quoting of its own.
  const inner = `ip link set lo up && exec unshare --user --map-user=${uid} --map-group=${gid} -- "$@"`;
  return ["unshare", "--user", "--map-root-user", "--net", "--", "sh", "-c", inner, "contained", ...argv];
}

/** Whether this box can contain a cell, and why not when it can't: one namespace, lo up, egress refused. */
export function probeContainment() {
  const probe = `require("http").createServer((q, r) => r.end("lo")).listen(0, "127.0.0.1", function () {
    require("http").get("http://127.0.0.1:" + this.address().port, (res) => res.on("data", (d) => {
      require("dns").lookup("registry.npmjs.org", (error) => { console.log(JSON.stringify({ loopback: String(d), egress: error ? "refused" : "open", uid: process.getuid() })); process.exit(0); });
    }));
  });`;
  const [cmd, ...args] = containedArgv([process.execPath, "-e", probe]);
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) {
    return { ok: false, reason: `the loopback-only namespace didn't start: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}` };
  }
  let seen;
  try { seen = JSON.parse(result.stdout.trim().split("\n").at(-1)); } catch { return { ok: false, reason: `the containment probe printed no result: ${result.stdout.trim()}` }; }
  if (seen.loopback !== "lo") return { ok: false, reason: "loopback didn't answer inside the namespace" };
  if (seen.egress !== "refused") return { ok: false, reason: "a name outside the box resolved inside the namespace" };
  if (seen.uid !== process.getuid()) return { ok: false, reason: `the program ran as uid ${seen.uid}, not ${process.getuid()}` };
  return { ok: true };
}

/** Spawn `argv` contained, with the given options (env, cwd, stdio). */
export function spawnContained(argv, options = {}) {
  const [cmd, ...args] = containedArgv(argv);
  return spawn(cmd, args, options);
}
