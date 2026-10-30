import type { ChildProcessWithoutNullStreams } from "node:child_process";

// SFTP v3 packets over an already authenticated OpenSSH subsystem stream.
// No SSH keys/config parsing and no remote shell or path interpolation here.
export interface SftpAttrs { size?: number; mode?: number; atime?: number; mtime?: number }
export class SftpStatusError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const u64 = (value: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; };
const str = (value: string | Buffer) => { const b = typeof value === "string" ? Buffer.from(value) : value; return Buffer.concat([u32(b.length), b]); };

class Packet {
  private offset = 0;
  constructor(private readonly data: Buffer) {}
  take(length: number): Buffer {
    if (length < 0 || length > this.data.length - this.offset) throw new Error("Truncated SFTP packet");
    const out = this.data.subarray(this.offset, this.offset + length); this.offset += length; return out;
  }
  uint(): number { return this.take(4).readUInt32BE(); }
  big(): number {
    const value = this.take(8).readBigUInt64BE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("SFTP file size exceeds supported precision");
    return Number(value);
  }
  bytes(): Buffer { return this.take(this.uint()); }
  text(): string { return this.bytes().toString("utf8"); }
  get remaining(): number { return this.data.length - this.offset; }
  attrs(): SftpAttrs {
    const flags = this.uint(), attrs: SftpAttrs = {};
    if (flags & 1) attrs.size = this.big();
    if (flags & 2) { this.uint(); this.uint(); } // uid/gid have no native Windows mapping
    if (flags & 4) attrs.mode = this.uint();
    if (flags & 8) { attrs.atime = this.uint(); attrs.mtime = this.uint(); }
    if (flags & 0x80000000) { const count = this.uint(); for (let i = 0; i < count; i++) { this.bytes(); this.bytes(); } }
    return attrs;
  }
}

export class SftpClient {
  readonly extensions = new Set<string>();
  readonly ready: Promise<void>;
  private buffered: Buffer = Buffer.alloc(0);
  private nextId = 0;
  private failure?: Error;
  private completeReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly pending = new Map<number, { resolve: (packet: { type: number; body: Packet }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly handshake: ReturnType<typeof setTimeout>;
  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly deadlineMs = 30_000) {
    this.ready = new Promise((resolve, reject) => { this.completeReady = resolve; this.rejectReady = reject; });
    this.handshake = setTimeout(() => this.fail(new Error("SFTP subsystem did not become ready")), deadlineMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      try {
        this.buffered = Buffer.concat([this.buffered, chunk]);
        while (this.buffered.length >= 4) {
          const size = this.buffered.readUInt32BE();
          if (size < 1 || size > 16 * 1024 * 1024) throw new Error("Invalid SFTP packet length");
          if (this.buffered.length < size + 4) break;
          const data = this.buffered.subarray(4, size + 4); this.buffered = this.buffered.subarray(size + 4);
          const type = data[0]!, body = new Packet(data.subarray(1));
          if (type === 2) {
            if (body.uint() !== 3) throw new Error("Remote SFTP server does not support version 3");
            while (body.remaining) { this.extensions.add(body.text()); body.text(); }
            clearTimeout(this.handshake); this.completeReady(); continue;
          }
          const id = body.uint(), waiter = this.pending.get(id);
          if (!waiter) throw new Error("Unexpected SFTP response identity");
          this.pending.delete(id); clearTimeout(waiter.timer); waiter.resolve({ type, body });
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    child.on("error", error => this.fail(error));
    child.on("close", () => this.fail(new Error("SFTP transport closed")));
    child.stdin.on("error", error => this.fail(error));
    this.send(1, u32(3));
  }
  private send(type: number, data: Buffer): void {
    this.child.stdin.write(Buffer.concat([u32(data.length + 1), Buffer.from([type]), data]));
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error; clearTimeout(this.handshake); this.rejectReady(error);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.buffered = Buffer.alloc(0);
    this.child.stdin.destroy(); this.child.stdout.destroy();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
  private async request(type: number, data: Buffer, expected: number): Promise<Packet> {
    await this.ready;
    if (this.failure) throw this.failure;
    const id = ++this.nextId;
    const response = await new Promise<{ type: number; body: Packet }>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("SFTP request timed out")), this.deadlineMs);
      this.pending.set(id, { resolve, reject, timer }); this.send(type, Buffer.concat([u32(id), data]));
    });
    if (response.type === 101) {
      const code = response.body.uint(), message = response.body.text(); response.body.text();
      if (code !== 0 || expected !== 101) throw new SftpStatusError(code, message || `SFTP status ${code}`);
    } else if (response.type !== expected) throw new Error("Unexpected SFTP response type");
    return response.body;
  }
  async lstat(file: string): Promise<SftpAttrs | undefined> {
    try { return (await this.request(7, str(file), 105)).attrs(); }
    catch (error) { if (error instanceof SftpStatusError && error.code === 2) return undefined; throw error; }
  }
  async readdir(file: string): Promise<string[]> {
    const handle = (await this.request(11, str(file), 102)).bytes(), names: string[] = [];
    try {
      for (;;) {
        let packet: Packet;
        try { packet = await this.request(12, str(handle), 104); }
        catch (error) { if (error instanceof SftpStatusError && error.code === 1) break; throw error; }
        const count = packet.uint();
        for (let i = 0; i < count; i++) { const name = packet.text(); packet.text(); packet.attrs(); if (name !== "." && name !== "..") names.push(name); }
      }
    } finally { await this.request(4, str(handle), 101); }
    return names;
  }
  async mkdir(file: string): Promise<void> { await this.request(14, Buffer.concat([str(file), u32(0)]), 101); }
  async readlink(file: string): Promise<string> {
    const packet = await this.request(19, str(file), 104);
    if (packet.uint() !== 1) throw new Error("Invalid SFTP link target");
    return packet.text();
  }
  async symlink(target: string, file: string): Promise<void> {
    // OpenSSH's established target/link order differs from the original v3 draft.
    await this.request(20, Buffer.concat([str(target), str(file)]), 101);
  }
  async *read(file: string): AsyncGenerator<Buffer> {
    const handle = (await this.request(3, Buffer.concat([str(file), u32(1), u32(0)]), 102)).bytes();
    try {
      for (let offset = 0;;) {
        let data: Buffer;
        try { data = (await this.request(5, Buffer.concat([str(handle), u64(offset), u32(32768)]), 103)).bytes(); }
        catch (error) { if (error instanceof SftpStatusError && error.code === 1) break; throw error; }
        if (!data.length) throw new Error("Empty SFTP read before EOF");
        offset += data.length; yield data;
      }
    } finally { await this.request(4, str(handle), 101); }
  }
  async write(file: string, chunks: AsyncIterable<Buffer>): Promise<void> {
    const handle = (await this.request(3, Buffer.concat([str(file), u32(2 | 8 | 32), u32(0)]), 102)).bytes();
    try {
      let offset = 0;
      for await (const data of chunks) { await this.request(6, Buffer.concat([str(handle), u64(offset), str(data)]), 101); offset += data.length; }
    } finally { await this.request(4, str(handle), 101); }
  }
  async setTimes(file: string, attrs: SftpAttrs): Promise<void> {
    const mode = attrs.mode === undefined ? [] : [u32(attrs.mode & 0o7777)];
    const times = attrs.atime === undefined || attrs.mtime === undefined ? [] : [u32(attrs.atime), u32(attrs.mtime)];
    const flags = (mode.length ? 4 : 0) | (times.length ? 8 : 0);
    if (flags) await this.request(9, Buffer.concat([str(file), u32(flags), ...mode, ...times]), 101);
  }
  async rename(src: string, dst: string, replacing: boolean): Promise<void> {
    if (this.extensions.has("posix-rename@openssh.com")) {
      await this.request(200, Buffer.concat([str("posix-rename@openssh.com"), str(src), str(dst)]), 101);
    } else {
      if (replacing) throw new Error("Remote SFTP server needs atomic replacement support; staged copy retained");
      await this.request(18, Buffer.concat([str(src), str(dst)]), 101);
    }
  }
  async close(): Promise<void> {
    clearTimeout(this.handshake);
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 3000);
      this.child.once("close", () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
    });
  }
}
