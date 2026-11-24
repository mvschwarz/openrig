import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { alignPiSessionCwd, piSessionCwdNotice } from "../src/adapters/pi-session-cwd.js";
import { piSeatPaths, PI_RUNNER_READY_MARKER, PI_RUNNER_ERROR_MARKER } from "../src/adapters/pi-runner-protocol.js";

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-cwd-")));
  temps.push(dir);
  return dir;
}
afterEach(() => { for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const TAIL = [
  '{"type":"model_change","id":"a1","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z","provider":"p","modelId":"m"}',
  '{"type":"message","id":"b2","parentId":"a1","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"keep me \\u00e9"}]}}',
  "",
].join("\n");

function fixture(recordedCwd: string, opts: { inSessions?: boolean } = {}) {
  const root = tempDir();
  const oldDir = path.join(root, "old"), newDir = path.join(root, "new"), sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(oldDir); fs.mkdirSync(newDir); fs.mkdirSync(sessionsDir);
  const header = JSON.stringify({ type: "session", version: 3, id: "s-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: recordedCwd === "OLD" ? oldDir : recordedCwd });
  const sessionFile = path.join(opts.inSessions === false ? root : sessionsDir, "2026_s-1.jsonl");
  fs.writeFileSync(sessionFile, header + "\n" + TAIL, { mode: 0o600 });
  return { root, oldDir, newDir, sessionsDir, sessionFile, header };
}

describe("alignPiSessionCwd", () => {
  it("points the header at the seat's folder and keeps every other byte", () => {
    const f = fixture("OLD");
    const outcome = alignPiSessionCwd({ sessionFile: f.sessionFile, cwd: f.newDir, sessionsDir: f.sessionsDir, rewrite: true });
    expect(outcome).toEqual({ kind: "moved", from: f.oldDir, to: f.newDir });
    const [first, ...rest] = fs.readFileSync(f.sessionFile, "utf8").split("\n");
    expect(JSON.parse(first!)).toEqual({ ...JSON.parse(f.header), cwd: f.newDir });
    expect(rest.join("\n")).toBe(TAIL);
    expect(fs.statSync(f.sessionFile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(f.sessionsDir)).toEqual(["2026_s-1.jsonl"]);
    expect(piSessionCwdNotice(outcome, "pi")).toBe(
      `[pi-runner] resume: the conversation was recorded in ${f.oldDir}; it continues in the seat's folder ${f.newDir}`);
  });

  it("moves a conversation whose recorded folder is gone", () => {
    const f = fixture("OLD");
    fs.rmdirSync(f.oldDir);
    expect(alignPiSessionCwd({ sessionFile: f.sessionFile, cwd: f.newDir, sessionsDir: f.sessionsDir, rewrite: true }).kind).toBe("moved");
    expect(JSON.parse(fs.readFileSync(f.sessionFile, "utf8").split("\n")[0]!).cwd).toBe(f.newDir);
  });

  it("leaves a session already in the seat's folder alone, including through a symlinked seat path", () => {
    const f = fixture("OLD");
    const link = path.join(f.root, "link");
    fs.symlinkSync(f.oldDir, link);
    const before = fs.statSync(f.sessionFile).mtimeMs;
    for (const cwd of [f.oldDir, link]) {
      expect(alignPiSessionCwd({ sessionFile: f.sessionFile, cwd, sessionsDir: f.sessionsDir, rewrite: true })).toEqual({ kind: "unchanged" });
    }
    expect(fs.readFileSync(f.sessionFile, "utf8")).toBe(f.header + "\n" + TAIL);
    expect(fs.statSync(f.sessionFile).mtimeMs).toBe(before);
  });

  it("reports, without changing, a runtime it is not verified for", () => {
    const f = fixture("OLD");
    const outcome = alignPiSessionCwd({ sessionFile: f.sessionFile, cwd: f.newDir, sessionsDir: f.sessionsDir, rewrite: false });
    expect(outcome).toEqual({ kind: "mismatch", from: f.oldDir, to: f.newDir, reason: "runtime_unverified" });
    expect(fs.readFileSync(f.sessionFile, "utf8")).toBe(f.header + "\n" + TAIL);
    const notice = piSessionCwdNotice(outcome, "omp")!;
    expect(notice).toContain("[omp-runner] WARNING resume");
    expect(notice).toContain(`may read and edit files in ${f.oldDir}`);
    expect(notice).not.toContain("ERROR");
  });

  it("does not change a session file outside the seat's sessions folder", () => {
    const f = fixture("OLD", { inSessions: false });
    expect(alignPiSessionCwd({ sessionFile: f.sessionFile, cwd: f.newDir, sessionsDir: f.sessionsDir, rewrite: true }))
      .toEqual({ kind: "mismatch", from: f.oldDir, to: f.newDir, reason: "outside_seat_sessions" });
    expect(fs.readFileSync(f.sessionFile, "utf8")).toBe(f.header + "\n" + TAIL);
  });

  it("does not change a session for a seat folder that is missing", () => {
    const f = fixture("OLD");
    expect(alignPiSessionCwd({ sessionFile: f.sessionFile, cwd: path.join(f.root, "absent"), sessionsDir: f.sessionsDir, rewrite: true }).kind)
      .toBe("mismatch");
    expect(fs.readFileSync(f.sessionFile, "utf8")).toBe(f.header + "\n" + TAIL);
  });

  it("leaves files that are not a readable session header to the runtime", () => {
    const root = tempDir();
    const sessionsDir = path.join(root, "sessions"); fs.mkdirSync(sessionsDir);
    for (const [name, content] of [["junk", "fixture\n"], ["empty", ""], ["other", '{"type":"message","cwd":"/x"}\n'], ["nocwd", '{"type":"session"}\n']]) {
      const file = path.join(sessionsDir, `${name}.jsonl`);
      fs.writeFileSync(file, content);
      expect(alignPiSessionCwd({ sessionFile: file, cwd: root, sessionsDir, rewrite: true })).toEqual({ kind: "unchanged" });
      expect(fs.readFileSync(file, "utf8")).toBe(content);
    }
    expect(alignPiSessionCwd({ sessionFile: path.join(sessionsDir, "missing.jsonl"), cwd: root, sessionsDir, rewrite: true })).toEqual({ kind: "unchanged" });
  });
});

// The real runner and an offline stand-in for Pi that, like Pi, reads its folder from the --session header.
describe.skipIf(process.platform === "win32")("pi-runner resume after a seat moved", () => {
  it("starts Pi on the same session file with the header pointing at the seat's folder", async () => {
    const temp = tempDir();
    const oldDir = path.join(temp, "old"), newDir = path.join(temp, "new"), bin = path.join(temp, "bin");
    for (const dir of [oldDir, newDir, bin]) fs.mkdirSync(dir);
    const stateRoot = path.join(temp, "state");
    const { sessionsDir } = piSeatPaths(stateRoot, "fixture");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const session = path.join(sessionsDir, "2026_s-1.jsonl");
    fs.writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: "s-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: oldDir }) + "\n" + TAIL);
    const probe = path.join(temp, "pi-probe.json");
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("0.66.1"); process.exit(0); }
const file = process.argv[process.argv.indexOf("--session") + 1];
fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ file, processCwd: process.cwd(), headerCwd: JSON.parse(fs.readFileSync(file, "utf8").split("\\n")[0]).cwd }));
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const c = JSON.parse(line);
  if (c.type === "get_state") console.log(JSON.stringify({ type: "response", id: c.id, success: true, data: { sessionFile: file, sessionId: "s-1" } }));
});
`, { mode: 0o700 });
    const child = spawn(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("../src/adapters/pi-runner.ts", import.meta.url)),
      "--session-name", "fixture", "--state-root", stateRoot, "--cwd", newDir,
      "--launch-id", "cwd-attempt", "--no-approve", "--session", session], {
      env: { PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), HOME: temp, OPENRIG_HOME: path.join(temp, "home") },
      detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", ready = false, timedOut = false;
    const stop = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } };
    child.stdin.on("error", () => {});
    const take = (d: Buffer) => { output += d.toString(); if (!ready && output.includes(PI_RUNNER_READY_MARKER)) { ready = true; stop(); } };
    child.stdout.on("data", take); child.stderr.on("data", take);
    const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
    const timer = setTimeout(() => { timedOut = true; stop(); }, 8000);
    try { await closed; } finally { clearTimeout(timer); stop(); }
    expect(timedOut, output).toBe(false);
    expect(ready, output).toBe(true);
    expect(output).not.toContain(PI_RUNNER_ERROR_MARKER);
    expect(output).toContain(`resume: the conversation was recorded in ${oldDir}; it continues in the seat's folder ${newDir}`);
    expect(JSON.parse(fs.readFileSync(probe, "utf8"))).toEqual({ file: session, processCwd: newDir, headerCwd: newDir });
    expect(fs.readFileSync(session, "utf8").split("\n").slice(1).join("\n")).toBe(TAIL);
  }, 15000);
});
