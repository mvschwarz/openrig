import fs from "node:fs";

// The provider's private explanation log is replaced atomically. Reopen by name
// on each observation rather than retaining the retired file's handle.
const file = process.argv[2];
if (!file) throw new Error("An explanation log path is required");
let previous;
const render = () => {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const offset = Math.max(0, size - 262144);
    const bytes = Buffer.alloc(Math.min(size, 262144));
    const count = fs.readSync(fd, bytes, 0, bytes.length, offset);
    let text = bytes.subarray(0, count).toString("utf8");
    if (offset) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.replace(/\n$/, "").split("\n").slice(-30).join("\n");
    if (lines !== previous) {
      process.stdout.write("\x1b[2J\x1b[H" + lines + "\n"); previous = lines;
    }
  } catch (error) {
    if (error.code !== "ENOENT") { process.stderr.write("Explanation log is unreadable\n"); process.exitCode = 1; clearInterval(timer); }
  } finally { if (fd !== undefined) fs.closeSync(fd); }
};
const timer = setInterval(render, 200);
render();
