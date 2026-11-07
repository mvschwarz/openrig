import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_PIDS = 128;
const MAX_BYTES = 1024 * 1024;
const MAX_ARGS = 4096;
const MAX_OUTPUT = 2 * MAX_BYTES;

// KERN_PROCARGS2 begins with argc and the executable path, followed by argc NUL-delimited
// arguments and then the environment. Only the arguments are returned by this helper.
const MAC_ARGUMENTS = `ObjC.import("Foundation");
ObjC.bindFunction("sysctl", ["int", ["void *", "uint32_t", "void *", "void *", "void *", "size_t"]]);
function number(bytes, count) {
  var value = 0;
  for (var i = count - 1; i >= 0; i--) value = value * 256 + bytes.charCodeAt(i);
  return value;
}
function parse(data, used) {
  if (used < 7 || used > 1048576) return null;
  var exact = data.subdataWithRange({location: 0, length: used});
  var bytes = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(exact, $.NSISOLatin1StringEncoding));
  if (typeof bytes !== "string" || bytes.length !== used) return null;
  var argc = number(bytes, 4);
  if (argc < 1 || argc > 4096) return null;
  var pathEnd = bytes.indexOf("\\u0000", 4);
  if (pathEnd <= 4) return null;
  // XNU aligns ip_startargv after the saved path to the target's pointer size.
  // KERN_PROCARGS2 strips the 16-byte executable_path= prefix. Supported macOS
  // processes are 64-bit, so the path and its padding occupy whole 8-byte units.
  // Skipping every zero would also skip an empty argv[0] and read env as argv.
  var offset = 4 + Math.ceil((pathEnd - 4 + 1) / 8) * 8;
  if (offset >= used) return null;
  for (var padding = pathEnd + 1; padding < offset; padding++) {
    if (bytes.charCodeAt(padding) !== 0) return null;
  }
  var args = [];
  for (var index = 0; index < argc; index++) {
    if (offset >= used) return null;
    var end = bytes.indexOf("\\u0000", offset);
    if (end < 0 || end >= used) return null;
    var argument = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(exact.subdataWithRange({location: offset, length: end - offset}), $.NSUTF8StringEncoding));
    if (typeof argument !== "string") return null;
    // NSString consumes a UTF-8 BOM at the start of each decoded unit. Restore
    // it so a BOM-prefixed token cannot become an exact conversation UUID.
    if (end - offset >= 3 && bytes.charCodeAt(offset) === 239 && bytes.charCodeAt(offset + 1) === 187
      && bytes.charCodeAt(offset + 2) === 191) argument = String.fromCharCode(65279) + argument;
    args.push(argument);
    offset = end + 1;
  }
  return args[0] ? args : null;
}
function run(inputs) {
  var data = $.NSMutableData.dataWithLength(1048576);
  var outputSize = 0;
  return JSON.stringify(inputs.map(function(input) {
    var request = JSON.parse(input);
    if (outputSize > 2097152) return [request.pid, null];
    if (request.fixture) {
      var fixture = $.NSData.alloc.initWithBase64EncodedStringOptions(request.fixture, 0);
      return [request.pid, parse(fixture, Number(fixture.length))];
    }
    var mib = $.NSData.alloc.initWithBase64EncodedStringOptions(request.mib, 0);
    var size = $.NSData.alloc.initWithBase64EncodedStringOptions(request.size, 0).mutableCopy;
    if ($.sysctl(mib.bytes, 3, data.mutableBytes, size.mutableBytes, null, 0) !== 0) return [request.pid, null];
    var sizeBytes = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(size, $.NSISOLatin1StringEncoding));
    var used = typeof sizeBytes === "string" && sizeBytes.length === 8 ? number(sizeBytes, 8) : 0;
    var args = parse(data, used);
    if (args) {
      var answerSize = JSON.stringify(args).length;
      if (outputSize + answerSize > 2097152) return [request.pid, null];
      outputSize += answerSize;
    }
    return [request.pid, args];
  }));
}`;

/** Parse a Linux /proc cmdline without ever treating malformed bytes as an argument boundary. */
export function parseLinuxProcessArguments(bytes: Buffer): string[] | null {
  if (bytes.length < 2 || bytes.length > MAX_BYTES || bytes.at(-1) !== 0) return null;
  const args: string[] = [];
  // TextDecoder strips an initial BOM by default, even when decoding each argv
  // unit separately. Keep that byte sequence as U+FEFF so it cannot become a UUID.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let start = 0;
  try {
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 0) continue;
      args.push(decoder.decode(bytes.subarray(start, index)));
      if (args.length > MAX_ARGS) return null;
      start = index + 1;
    }
  } catch { return null; }
  return args[0] ? args : null;
}

async function boundedLinuxCmdline(pid: number, signal: AbortSignal): Promise<string[] | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of createReadStream(`/proc/${pid}/cmdline`, { highWaterMark: 64 * 1024, signal })) {
      length += chunk.length;
      if (length > MAX_BYTES) return null;
      chunks.push(chunk);
    }
    return parseLinuxProcessArguments(Buffer.concat(chunks, length));
  } catch { return null; }
}

/** Exercise the same macOS KERN_PROCARGS2 parser with a crafted buffer, without reading any process. */
export async function parseMacProcessArgumentsForTest(bytes: Buffer): Promise<string[] | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_ARGUMENTS,
      JSON.stringify({ pid: 0, fixture: bytes.toString("base64") })], { encoding: "utf8", timeout: 2000, maxBuffer: MAX_OUTPUT });
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) && Array.isArray(parsed[0]) && Array.isArray(parsed[0][1]) ? parsed[0][1] as string[] : null;
  } catch { return null; }
}

/** Exact OS argv for bounded native Codex candidates. Unavailable or malformed reads have no witness. */
export async function readNativeProcessArguments(requested: number[]): Promise<Map<number, string[]>> {
  const pids = [...new Set(requested.filter(pid => Number.isInteger(pid) && pid > 0 && pid <= 2147483647))].slice(0, MAX_PIDS);
  const result = new Map<number, string[]>();
  if (pids.length === 0) return result;
  let entries: unknown;
  try {
    if (process.platform === "linux") {
      const found: Array<[number, string[] | null]> = [];
      // Bounded concurrency and one overall deadline keep a slow /proc from holding observation indefinitely.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        for (let start = 0; start < pids.length; start += 16) {
          const batch = await Promise.all(pids.slice(start, start + 16).map(async (pid): Promise<[number, string[] | null]> =>
            [pid, await boundedLinuxCmdline(pid, controller.signal)]));
          found.push(...batch);
          if (controller.signal.aborted) break;
        }
      } finally { clearTimeout(timer); }
      entries = found;
    } else if (process.platform === "darwin") {
      const size = Buffer.alloc(8);
      size.writeBigUInt64LE(BigInt(MAX_BYTES));
      const requests = pids.map(pid => {
        const mib = Buffer.alloc(12);
        mib.writeInt32LE(1, 0); // CTL_KERN
        mib.writeInt32LE(49, 4); // KERN_PROCARGS2
        mib.writeInt32LE(pid, 8);
        return JSON.stringify({ pid, mib: mib.toString("base64"), size: size.toString("base64") });
      });
      const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_ARGUMENTS, ...requests], {
        encoding: "utf8", timeout: 2000, maxBuffer: MAX_OUTPUT,
      });
      entries = JSON.parse(stdout);
    } else return result;
    if (!Array.isArray(entries)) return result;
    const requestedPids = new Set(pids);
    for (const entry of entries) {
      if (!Array.isArray(entry) || !requestedPids.has(entry[0])) continue;
      const args: unknown = entry[1];
      if (Array.isArray(args) && args.length > 0 && args.length <= MAX_ARGS && typeof args[0] === "string" && args[0].length > 0
        && args.every(arg => typeof arg === "string" && !arg.includes("\0"))) result.set(entry[0], args);
    }
  } catch { /* No OS argv is unknown, never a fallback to flattened ps text. */ }
  return result;
}
