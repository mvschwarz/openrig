// #1091 round 5: strict restore through the production process lister. No listProcesses
// is injected; `ps` is stubbed at the spawn seam, answering whichever columns the caller
// asks for. These rows are process observations only, not a Claude session.
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { rebindAndVerifyPaneIdentity } from "../src/domain/seat-attention-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";

const processMocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<object>()), execFile: processMocks.execFile }));
// The executable-path witness is unavailable (as for exited or unreadable pids), so
// no fake pid here can resolve to a real process on the test host.
// Each case sets the witnesses it needs; any other pid has none.
const witnesses = vi.hoisted(() => new Map<number, string>());
vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<object>()),
  readlink: vi.fn(async (path: string) => {
    const witness = witnesses.get(Number(path.match(/^\/proc\/(\d+)\/exe$/)?.[1]));
    if (witness === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return witness;
  }) }));

const startedAt = "Fri Oct  2 20:00:00 2026";
type Row = { pid: number; ppid: number; pgid: number; tpgid: number; ucomm: string; command: string };
let rows: Row[] = [];
processMocks.execFile.mockImplementation((file: string, args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
  // macOS reads executable witnesses through osascript (pids follow the script argument).
  if (file === "/usr/bin/osascript") {
    const pids = args.slice(args.indexOf("-e") + 2).map(Number);
    return callback(null, { stdout: JSON.stringify(pids.map((pid) => [pid, witnesses.get(pid) ?? null])), stderr: "" });
  }
  if (file !== "ps") return callback(new Error(`unexpected spawn: ${file}`), { stdout: "", stderr: "" });
  const columns = args[1]!.split(",");
  const line = (row: Row) => columns.map((column) => column === "lstart" ? startedAt
    : column === "command" ? row.command : String(row[column as keyof Row])).join(" ");
  callback(null, { stdout: [columns.join(" ").toUpperCase(), ...rows.map(line)].join("\n") + "\n", stderr: "" });
});

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function strictRestore(processRows: Row[], panePid = 100, paths: Record<number, string> = {}): Promise<{ ok: boolean; observedPid: number | null | undefined }> {
  rows = processRows;
  witnesses.clear();
  for (const [pid, path] of Object.entries(paths)) witnesses.set(Number(pid), path);
  const db = createFullTestDb(); databases.push(db);
  const repo = new RigRepository(db), registry = new SessionRegistry(db);
  const rig = repo.createRig("prod1091"), name = "worker@prod1091";
  const node = repo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
  registry.registerSession(node.id, name);
  registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1091" });
  const tmux = {
    listSessions: vi.fn(async () => [{ name }] as never),
    listPanes: vi.fn(async () => [{ id: "%1091" }] as never),
    getPanePid: vi.fn(async () => panePid),
    getPaneCommand: vi.fn(async () => "claude"),
  };
  const result = await rebindAndVerifyPaneIdentity({ db, sessionRegistry: registry, tmux, nodeId: node.id,
    sessionName: name, runtime: "claude-code", expectedResumeToken: "review-token", requireExactResumeLineage: true });
  return { ok: result.ok, observedPid: new SeatIdentityStore(db).getForNode(node.id)?.evidence.observedPid };
}

describe("strict restore reads full process rows from the production lister", () => {
  it("refuses a shell script launcher's token over a Claude child on another conversation", async () => {
    expect(await strictRestore([
      { pid: 100, ppid: 1, pgid: 100, tpgid: 100, ucomm: "claude", command: "/bin/sh /shim/claude --resume review-token" },
      { pid: 101, ppid: 100, pgid: 100, tpgid: 100, ucomm: "claude", command: "claude --session-id different" },
    ])).toMatchObject({ ok: false });
  });
  it("keeps the #563/#567 company-launcher model verified, with the proof at the deepest link naming the token", async () => {
    expect(await strictRestore([
      { pid: 90, ppid: 1, pgid: 90, tpgid: 100, ucomm: "bash", command: "-bash" },
      { pid: 100, ppid: 90, pgid: 100, tpgid: 100, ucomm: "claude", command: "/opt/claude --permission-mode auto --session-id review-token --name worker@prod1091" },
      { pid: 101, ppid: 100, pgid: 100, tpgid: 100, ucomm: "claude", command: "/shim/bin/claude --permission-mode auto --session-id review-token --name worker@prod1091" },
      { pid: 102, ppid: 101, pgid: 100, tpgid: 100, ucomm: "claude", command: "/shim/claude --settings /shim/settings.json --permission-mode auto" },
    ], 90)).toMatchObject({ ok: true, observedPid: 101 });
  });
  it("keeps a Node-run Claude over a child Claude on another conversation verified", async () => {
    expect(await strictRestore([
      { pid: 100, ppid: 1, pgid: 100, tpgid: 100, ucomm: "node", command: "node /usr/local/bin/claude --resume review-token" },
      { pid: 101, ppid: 100, pgid: 100, tpgid: 100, ucomm: "claude", command: "claude --session-id different" },
    ])).toMatchObject({ ok: true });
  });

  // #1091 round 6: native Claude processes may report a version string (or a Nix wrapper
  // name) as their OS name, with no executable-path witness.
  const shellPane = { pid: 90, ppid: 1, pgid: 90, tpgid: 100, ucomm: "bash", command: "-bash" };
  const script = { pid: 100, ppid: 90, pgid: 100, tpgid: 100, ucomm: "claude", command: "/bin/sh /shim/claude --resume review-token" };
  const version = (pid: number, ppid: number, args: string) =>
    ({ pid, ppid, pgid: 100, tpgid: 100, ucomm: "2.1.286", command: `claude ${args}` });
  it.each([["version-titled", "2.1.286"], ["Nix-wrapped", ".claude-unwrapp"]])(
    "F1: a %s Claude parent over a child Claude on another conversation keeps main's proof", async (_name, ucomm) => {
      expect(await strictRestore([
        { pid: 100, ppid: 1, pgid: 100, tpgid: 100, ucomm, command: "claude --resume review-token" },
        { pid: 101, ppid: 100, pgid: 100, tpgid: 100, ucomm: "claude", command: "claude --session-id different" },
      ])).toMatchObject({ ok: true, observedPid: 100 });
    });
  // Round 7 (Root, eeea3f6e): a child with no readable witness keeps main's baseline.
  it("a script launcher over an unwitnessed version-titled child on another conversation keeps main's result", async () => {
    expect(await strictRestore([shellPane, script, version(101, 100, "--session-id different")], 90)).toMatchObject({ ok: true, observedPid: 100 });
  });
  it("a script and a helper on the token over an unwitnessed version-titled child keep main's result", async () => {
    expect(await strictRestore([shellPane, script,
      { pid: 99, ppid: 100, pgid: 100, tpgid: 100, ucomm: "ugrep", command: "ugrep -n claude --session-id review-token file.ts" },
      version(101, 100, "--session-id different")], 90)).toMatchObject({ ok: true, observedPid: 100 });
  });
  it("an unwitnessed version-titled child naming the token leaves the proof with the launcher, as on main", async () => {
    expect(await strictRestore([shellPane, script, version(101, 100, "--session-id review-token")], 90)).toMatchObject({ ok: true, observedPid: 100 });
  });
  it("an unwitnessed version-titled opaque intermediate owns its own child, so the launcher keeps main's proof", async () => {
    expect(await strictRestore([shellPane, script, version(101, 100, "--settings /shim/settings.json"),
      version(102, 101, "--session-id different")], 90)).toMatchObject({ ok: true, observedPid: 100 });
  });
  it("a helper with a version-shaped OS name over an unwitnessed version-titled child keeps main's result", async () => {
    expect(await strictRestore([shellPane,
      { pid: 100, ppid: 90, pgid: 100, tpgid: 100, ucomm: "2.1.286", command: "rg claude --resume review-token" },
      version(101, 100, "--session-id different")], 90)).toMatchObject({ ok: true, observedPid: 100 });
  });

  // Round 7 F1: Linux reports an unlinked running binary as `<path> (deleted)`.
  const versionsPath = "/home/u/.local/share/claude/versions/2.1.286";
  const nixPath = "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-claude-code-2.1.286/bin/.claude-unwrapped";
  it.each([["version-titled", "2.1.286", versionsPath], ["Nix-wrapped", ".claude-unwrapp", nixPath]])(
    "F1: a %s Claude parent whose witness is deleted, over a child Claude on another conversation, keeps main's proof", async (_name, ucomm, path) => {
      expect(await strictRestore([
        { pid: 100, ppid: 1, pgid: 100, tpgid: 100, ucomm, command: "claude --resume review-token" },
        { pid: 101, ppid: 100, pgid: 100, tpgid: 100, ucomm: "claude", command: "claude --session-id different" },
      ], 100, { 100: `${path} (deleted)` })).toMatchObject({ ok: true, observedPid: 100 });
    });
  it("a witnessed (deleted) version-titled child on another conversation refuses the script launcher", async () => {
    expect(await strictRestore([shellPane, script, version(101, 100, "--session-id different")], 90,
      { 101: `${versionsPath} (deleted)` })).toMatchObject({ ok: false });
  });
  it("a witnessed version-titled child naming the token is the proof process", async () => {
    expect(await strictRestore([shellPane, script, version(101, 100, "--session-id review-token")], 90,
      { 101: versionsPath })).toMatchObject({ ok: true, observedPid: 101 });
    expect(await strictRestore([shellPane, script, version(101, 100, "--session-id review-token")], 90,
      { 101: `${versionsPath} (deleted)` })).toMatchObject({ ok: true, observedPid: 101 });
  });
  it.each(["/usr/bin/python3", "/usr/bin/python3 (deleted)"])("a child with a known non-Claude witness (%s) is not recognised", async (path) => {
    expect(await strictRestore([shellPane, script, version(101, 100, "--session-id different")], 90,
      { 101: path })).toMatchObject({ ok: true, observedPid: 100 });
  });
  it("a direct Claude tool child (claude mcp serve) leaves the real Claude's proof unchanged", async () => {
    expect(await strictRestore([
      { pid: 100, ppid: 1, pgid: 100, tpgid: 100, ucomm: "claude", command: "claude --resume review-token" },
      { pid: 101, ppid: 100, pgid: 100, tpgid: 100, ucomm: "claude", command: "claude mcp serve" },
    ])).toMatchObject({ ok: true, observedPid: 100 });
  });
});
