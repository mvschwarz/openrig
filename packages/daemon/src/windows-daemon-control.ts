import { createConnection, createServer } from "node:net";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const FILE = "windows-control/daemon-control.json";
interface ControlRecord { schema: "openrig.windows-control/v1"; pid: number; pipe: string; token: string }
const read = (file: string): any => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

/** Windows SIGTERM force-terminates Node. This instance capability requests the
 * same bounded drain used by POSIX signals, without accepting an HTTP command. */
export async function startWindowsDaemonControl(home: string, shutdown: () => void): Promise<() => Promise<void>> {
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  try {
    await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(import.meta.dirname, "../assets/windows-private-directory.ps1"), "-Path", path.join(home, "windows-control")], { windowsHide: true, timeout: 5000 });
  } catch { throw new Error("Windows private control directory unavailable; no capability published"); }
  const nonce = randomBytes(24).toString("hex");
  const record: ControlRecord = { schema: "openrig.windows-control/v1", pid: process.pid,
    pipe: `\\\\.\\pipe\\openrig-${createHash("sha256").update(home).digest("hex").slice(0, 16)}-${process.pid}-${nonce}`,
    token: randomBytes(32).toString("hex") };
  const file = path.join(home, FILE);
  const server = createServer(socket => {
    socket.setTimeout(2000, () => socket.destroy());
    let input = "";
    socket.on("error", () => {});
    socket.on("data", chunk => {
      input += chunk.toString("utf8");
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes("\n")) return;
      let request: any;
      try { request = JSON.parse(input); } catch { socket.destroy(); return; }
      const state = read(path.join(home, "daemon.json"));
      const token = typeof request.token === "string" ? Buffer.from(request.token) : Buffer.alloc(0);
      const expected = Buffer.from(record.token);
      if (request.pid !== record.pid || state?.pid !== record.pid || request.startedAt !== state.startedAt
        || token.length !== expected.length || !timingSafeEqual(token, expected)) { socket.destroy(); return; }
      socket.end("accepted\n", () => setImmediate(shutdown));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(record.pipe, () => { server.removeListener("error", reject); resolve(); }); });
  try { writeFileSync(file, JSON.stringify(record), { mode: 0o600 }); }
  catch { server.close(); throw new Error("Windows daemon control could not be published"); }
  return () => new Promise<void>((resolve, reject) => server.close(error => {
    if (read(file)?.token === record.token) { try { unlinkSync(file); } catch { /* retained evidence */ } }
    if (error) reject(new Error("Windows daemon control could not be closed")); else resolve();
  }));
}

export async function requestWindowsDaemonStop(home: string, state: { pid: number; startedAt: string }): Promise<void> {
  const record: ControlRecord | null = read(path.join(home, FILE));
  if (record?.schema !== "openrig.windows-control/v1" || record.pid !== state.pid
    || !/^\\\\\.\\pipe\\openrig-[a-f0-9]{16}-\d+-[a-f0-9]{48}$/.test(record.pipe)
    || !/^[a-f0-9]{64}$/.test(record.token)) throw new Error("Windows drain channel unavailable; no termination sent");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(record.pipe);
    let settled = false;
    const finish = (ok: boolean) => { if (settled) return; settled = true; socket.destroy(); if (ok) resolve(); else reject(new Error("Windows drain request unverified; no force termination sent")); };
    socket.setTimeout(2000, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));
    socket.on("connect", () => socket.write(JSON.stringify({ pid: state.pid, startedAt: state.startedAt, token: record.token }) + "\n"));
    let response = "";
    socket.on("data", chunk => { response += chunk.toString(); if (response.length > 64) finish(false); else if (response.includes("\n")) finish(response === "accepted\n"); });
  });
}
