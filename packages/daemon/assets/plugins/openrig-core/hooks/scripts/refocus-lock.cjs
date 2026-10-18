"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");

// One refocus occupant's state lock: a file holding its owner's token, created exclusively. A lock is held for
// milliseconds, never across a lookup. Every path through `acquire` ends by its deadline:
// - a live holder is waited for until the deadline;
// - a lock older than `staleMs` (its owner was killed) is taken over, and only the lock that was seen stale: it is moved
//   aside, its token checked, and a competitor's fresh lock moved by mistake is put back;
// - a lock that can't be created, read or moved (an unwritable folder, a directory or dangling link at the path) fails
//   at once, so the caller can go on without it rather than wait.
// `release` removes the lock only while it still holds this owner's token.

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function createLock(lockFile, { staleMs, waitMs, now = Date.now, hooks = {} }) {
  const token = `${process.pid}:${crypto.randomUUID()}`;
  let held = false;

  function acquire() {
    const until = now() + waitMs;
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, "wx");
        try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
        held = true;
        return { ok: true };
      } catch (error) {
        if (error?.code !== "EEXIST") return { ok: false, reason: `can't create the lock (${error?.code ?? error})` };
      }
      let holder;
      let age;
      try {
        holder = fs.readFileSync(lockFile, "utf8");
        age = now() - fs.statSync(lockFile).mtimeMs;
      } catch (error) {
        if (error?.code !== "ENOENT") return { ok: false, reason: `can't read the lock (${error?.code ?? error})` };
        // Gone: released between our attempt and this read, so try again, still bounded by the deadline. Still there
        // (a dangling link): it can't be read or released by anyone, so give up now.
        try { fs.lstatSync(lockFile); return { ok: false, reason: "the lock path is a dangling link" }; } catch {}
      }
      if (holder !== undefined && age > staleMs) {
        hooks.beforeTakeover?.();
        const aside = `${lockFile}.${token.replace(/[^A-Za-z0-9]/g, "_")}.stale`;
        let moved = false;
        try {
          fs.renameSync(lockFile, aside);
          moved = true;
        } catch (error) {
          if (error?.code !== "ENOENT") return { ok: false, reason: `can't take over a stale lock (${error?.code ?? error})` };
        }
        if (moved) {
          let movedToken;
          try { movedToken = fs.readFileSync(aside, "utf8"); } catch {}
          if (movedToken !== holder) {
            // A competitor took the stale lock over first and this moved its fresh lock: put it back.
            try { fs.linkSync(aside, lockFile); } catch {}
          }
          try { fs.unlinkSync(aside); } catch {}
          if (movedToken === holder) continue;
        }
      }
      if (now() >= until) return { ok: false, reason: "another hook held the lock past the wait" };
      sleep(10);
    }
  }

  function release() {
    if (!held) return;
    held = false;
    try {
      if (fs.readFileSync(lockFile, "utf8") === token) fs.unlinkSync(lockFile);
    } catch {}
  }

  return { acquire, release, token, isHeld: () => held };
}

module.exports = { createLock };
