"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function acquire(stateFile) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const base = `${stateFile}.guard`;
  const token = `${process.pid}-${randomUUID()}`;
  const until = performance.now() + 200;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let lock = base;
  do {
    try {
      fs.symlinkSync(token, lock);
      return () => {
        try {
          if (fs.readlinkSync(lock) === token) fs.unlinkSync(lock);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let owner;
    try {
      owner = fs.readlinkSync(lock);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const match = /^([1-9][0-9]*)-([0-9a-f-]{36})$/.exec(owner);
    if (!match) throw new Error("unrecognized state guard owner");
    if (!processExists(Number(match[1]))) {
      // The owner might have released the path before exiting. Recheck its
      // token after proving death; that same owner can no longer remove it.
      try {
        if (fs.readlinkSync(lock) === owner) lock = `${base}.${match[2]}`;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // Keep the dead link. Contenders follow it to one shared successor
      // without ever removing a guard another process might have acquired.
      continue;
    }
    Atomics.wait(wait, 0, 0, 10);
  } while (performance.now() < until);
  throw new Error("state guard still busy");
}

function openRefocusState(stateFile) {
  const report = (operation, error) =>
    process.stderr.write(`refocus: could not ${operation} (${error.code || error.message})\n`);
  let release;
  try {
    release = acquire(stateFile);
  } catch (error) {
    report("coordinate state. Continuing with available evidence", error);
  }
  function read(file) {
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (state && typeof state === "object" && !Array.isArray(state)) return state;
      throw new Error("expected a state object");
    } catch (error) {
      if (error.code !== "ENOENT") report("read state", error);
      return null;
    }
  }
  function write(file, state) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state), { flag: "wx", mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      report("record state", error);
      return false;
    }
  }

  return {
    exclusive: Boolean(release),
    close: release || (() => {}),
    read: () => read(stateFile),
    write: (state) => write(stateFile, state),
    readDeferred: (kind) => read(`${stateFile}.${kind}-pending`),
    writeDeferred: (kind, pending) => write(`${stateFile}.${kind}-pending`, pending),
  };
}

module.exports = { openRefocusState, processExists };
