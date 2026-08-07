import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireGateLane, GATE_LANE_PORT } from "./gate-lane-lock.mjs";

// F1 gate-lane (arch d6a6c1db; mechanism (B) bound-localhost-port, desk-concurred): a machine-wide
// kernel-released-on-death mutex. Acquire NON-BLOCKING; gate-vs-gate contention HARD-REFUSES naming the
// holder (pid/started-at); a FOREIGN process on the port with NO holder-info file is FAIL-CLOSED
// ("foreign-holder", load-115). flock(2) is anonymous → a holder-info file is needed under any mechanism.
const info = () => join(mkdtempSync(join(tmpdir(), "gl-")), "holder.json");

test("acquires the lane on a free port + writes holder-info (pid, started-at)", async () => {
  const p = info();
  const a = await acquireGateLane({ port: 45871, holderInfoPath: p });
  assert.equal(a.ok, true);
  assert.ok(existsSync(p));
  const h = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(h.pid, process.pid);
  assert.match(h.startedAt, /^\d{4}-\d\d-\d\dT/);
  await a.release();
  assert.equal(existsSync(p), false); // release unlinks the holder-info
});

test("gate-vs-gate contention → HARD-REFUSE naming the holder (pid/started-at), non-blocking", async () => {
  const p = info();
  const a = await acquireGateLane({ port: 45872, holderInfoPath: p });
  assert.equal(a.ok, true);
  const b = await acquireGateLane({ port: 45872, holderInfoPath: p });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "gate-holder");
  assert.equal(b.holder.pid, process.pid);
  assert.match(b.holder.startedAt, /^\d{4}-\d\d-\d\dT/);
  await a.release();
});

test("FOREIGN process on the port + NO holder-info → FAIL-CLOSED 'foreign-holder' (load-115)", async () => {
  const p = info(); // holder-info absent
  const foreign = net.createServer();
  await new Promise((r) => foreign.listen(45873, "127.0.0.1", r));
  try {
    const b = await acquireGateLane({ port: 45873, holderInfoPath: p });
    assert.equal(b.ok, false);
    assert.equal(b.reason, "foreign-holder");
  } finally {
    await new Promise((r) => foreign.close(r));
  }
});

test("P2 exclusivity (no SO_REUSEPORT): a second CONCURRENT bind on the same port MUST fail", async () => {
  // Load-bearing: with SO_REUSEPORT both binds would succeed and the mutex would silently vanish.
  const s1 = net.createServer();
  await new Promise((r) => s1.listen(45875, "127.0.0.1", r));
  const s2 = net.createServer();
  const err = await new Promise((resolve) => {
    s2.once("error", resolve);
    s2.listen(45875, "127.0.0.1", () => resolve(null));
  });
  try {
    assert.ok(err, "second concurrent bind must fail — exclusivity IS the mutex");
    assert.equal(err.code, "EADDRINUSE");
  } finally {
    await new Promise((r) => s1.close(r));
    if (!err) await new Promise((r) => s2.close(r));
  }
});

test("P3: GATE_LANE_PORT is the ONE named lock (numeric, valid range, env-overridable default)", async () => {
  assert.equal(typeof GATE_LANE_PORT, "number");
  assert.ok(GATE_LANE_PORT > 0 && GATE_LANE_PORT < 65536);
  // acquire uses the constant when no port is passed (one home).
  const p = info();
  const a = await acquireGateLane({ holderInfoPath: p });
  assert.equal(a.ok, true);
  await a.release();
});

test("P4 best-effort: a failed holder-info write does NOT lose the already-held lane (bind is the lock)", async () => {
  // Parent path is a FILE, so the holder-info mkdir/write fails — but the port bind still holds the lane.
  const f = join(mkdtempSync(join(tmpdir(), "gl-")), "notadir");
  writeFileSync(f, "x");
  const a = await acquireGateLane({ port: 45876, holderInfoPath: join(f, "holder.json") });
  assert.equal(a.ok, true); // lane held despite the failed naming-only write
  await a.release();
});

test("release frees the lane (kernel-released) so a subsequent acquire succeeds", async () => {
  const p = info();
  const a = await acquireGateLane({ port: 45874, holderInfoPath: p });
  assert.equal(a.ok, true);
  await a.release();
  const b = await acquireGateLane({ port: 45874, holderInfoPath: p });
  assert.equal(b.ok, true);
  await b.release();
});
