import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

/** Read backwards in bounded chunks so a large daemon log need not fit in memory. */
export function lastLogLines(file: string, count = 10): { text: string; position: number } {
  const fd = fs.openSync(file, "r");
  try {
    const initial = readTail(fd, count);
    return { text: initial.bytes.toString("utf8"), position: initial.position };
  } finally { fs.closeSync(fd); }
}

function readTail(fd: number, count: number): { bytes: Buffer; position: number } {
    const size = fs.fstatSync(fd).size;
    let offset = size;
    let newlines = 0;
    const chunks: Buffer[] = [];
    while (offset > 0 && newlines <= count) {
      const length = Math.min(offset, 65536);
      offset -= length;
      const chunk = Buffer.alloc(length);
      const read = fs.readSync(fd, chunk, 0, length, offset);
      const bytes = chunk.subarray(0, read);
      chunks.unshift(bytes);
      for (const byte of bytes) if (byte === 10) newlines++;
    }
    const bytes = Buffer.concat(chunks);
    let remaining = count + (bytes.at(-1) === 10 ? 1 : 0);
    let start = 0;
    for (let index = bytes.length - 1; index >= 0; index--) {
      if (bytes[index] === 10 && --remaining === 0) { start = index + 1; break; }
    }
    return { bytes: bytes.subarray(start), position: size };
}

/** Follow the open file like tail -f, including truncation and split UTF-8 writes. */
export function followLog(file: string, write: (text: string) => void, interval = 250): () => void {
  const fd = fs.openSync(file, "r");
  let initial: ReturnType<typeof readTail>;
  const initialDecoder = new StringDecoder("utf8");
  try {
    initial = readTail(fd, 10);
    write(initialDecoder.write(initial.bytes));
  } catch (error) { fs.closeSync(fd); throw error; }
  let position = initial.position;
  let decoder = initialDecoder;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    fs.closeSync(fd);
  };
  const timer = setInterval(() => {
    try {
      const size = fs.fstatSync(fd).size;
      if (size < position) { position = 0; decoder = new StringDecoder("utf8"); }
      const chunk = Buffer.alloc(65536);
      while (position < size) {
        const length = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
        if (!length) break;
        position += length;
        write(decoder.write(chunk.subarray(0, length)));
      }
    } catch (error) {
      close();
      console.error(`Cannot follow daemon log: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }, interval);
  return close;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  try {
    if (!file) throw new Error("Missing daemon log path");
    if (process.argv.includes("--follow")) {
      const close = followLog(file, (text) => process.stdout.write(text));
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => close());
    } else process.stdout.write(lastLogLines(file).text);
  } catch (error) {
    console.error(`Cannot read daemon log: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
