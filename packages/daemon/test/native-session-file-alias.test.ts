import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { OmpResumeAdapter } from "../src/adapters/omp-resume.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

it.runIf(process.platform === "win32")("resumes the same owned native file through aliases and refuses a parent-file alias as a fork child", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-alias-"));
  try {
    const directory = path.join(root, "data"), alias = path.join(root, "alias");
    fs.mkdirSync(directory); fs.symlinkSync(directory, alias, "junction");
    const original = path.join(directory, "session.jsonl"), reported = path.join(alias, "session.jsonl");
    fs.writeFileSync(original, "owned history\n");
    const stateRoot = path.join(root, "state"), seat = "owned@fixture";
    const paths = piSeatPaths(stateRoot, seat);
    const ops = { readFile: (file: string) => fs.readFileSync(file, "utf8"), writeFile: (file: string, text: string) => fs.writeFileSync(file, text),
      exists: fs.existsSync, mkdirp: (directory: string) => { fs.mkdirSync(directory, { recursive: true }); } };
    const tmux = { sendShellCommand: vi.fn(async (_target: string, command: string) => {
      fs.mkdirSync(path.dirname(paths.runnerStatePath), { recursive: true });
      const launchId = /--launch-id '([^']+)'/.exec(command)?.[1];
      fs.writeFileSync(paths.runnerStatePath, JSON.stringify({ ready: true, launchId, sessionFile: reported, updatedAt: "t" }));
      return { ok: true };
    }), capturePaneContent: async () => "" } as unknown as TmuxAdapter;
    const adapter = new OmpRuntimeAdapter({ fsOps: ops, tmux, stateRoot, runnerEntryPath: path.join(root, "runner.js"), sleep: async () => {} });
    const binding = { tmuxSession: seat, cwd: root, launchPosture: "floor" } as never;
    expect(await adapter.launchHarness(binding, { name: seat, resumeToken: original.replaceAll("\\", "/") })).toMatchObject({ ok: true, resumeToken: reported });
    const resume = new OmpResumeAdapter(tmux, ops, { stateRoot, runnerEntryPath: path.join(root, "runner.js") }, { pollMs: 1, maxWaitMs: 1, sleep: async () => {} });
    expect(await resume.resume(seat, "omp_session_file", original, root)).toMatchObject({ ok: true });
    expect(await adapter.launchHarness(binding, { name: seat, forkSource: { kind: "native_id", value: original } })).toMatchObject({ ok: false, error: expect.stringContaining("parent session file") });
    const other = path.join(directory, "other.jsonl"); fs.writeFileSync(other, "different history\n");
    expect(await adapter.launchHarness(binding, { name: seat, resumeToken: other })).toMatchObject({ ok: false, error: expect.stringContaining("requested session file") });
    expect(fs.readFileSync(original, "utf8")).toBe("owned history\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
