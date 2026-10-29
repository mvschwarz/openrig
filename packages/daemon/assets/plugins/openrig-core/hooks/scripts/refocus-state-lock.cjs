"use strict";
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Windows pipe ownership is exclusive and dies with the process. A disk lease
// would survive a harness kill and could strand this occupant's next refocus.
async function acquireNativeStateLock(stateFile) {
  if (process.platform !== "win32") return;
  const parent = path.dirname(path.resolve(stateFile));
  fs.mkdirSync(parent, { recursive: true });
  const canonical = path.join(fs.realpathSync.native(parent), path.basename(stateFile));
  const key = crypto.createHash("sha256").update(canonical.toLowerCase()).digest("hex");
  const pipe = "\\\\.\\pipe\\openrig-refocus-state-" + key;
  const deadline = Date.now() + 52_000;
  for (;;) {
    const server = net.createServer(socket => socket.destroy());
    const error = await new Promise(resolve => {
      server.once("error", resolve);
      server.listen(pipe, () => resolve(null));
    });
    if (!error) {
      // Hold through the final stdout/persistence callback, without keeping an
      // otherwise finished hook alive. Normal exit and forced termination release it.
      server.unref();
      return;
    }
    if (error.code !== "EADDRINUSE") throw error;
    if (Date.now() >= deadline) throw new Error("refocus state is still owned by another hook; its occupant state file was not changed");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

module.exports = { acquireNativeStateLock };
