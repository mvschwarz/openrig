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

const startedAt = "Fri Oct  2 20:00:00 2026";
type Row = { pid: number; ppid: number; pgid: number; tpgid: number; ucomm: string; command: string };
let rows: Row[] = [];
processMocks.execFile.mockImplementation((file: string, args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
  if (file !== "ps") return callback(new Error(`unexpected spawn: ${file}`), { stdout: "", stderr: "" });
  const columns = args[1]!.split(",");
  const line = (row: Row) => columns.map((column) => column === "lstart" ? startedAt
    : column === "command" ? row.command : String(row[column as keyof Row])).join(" ");
  callback(null, { stdout: [columns.join(" ").toUpperCase(), ...rows.map(line)].join("\n") + "\n", stderr: "" });
});

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function strictRestore(processRows: Row[], panePid = 100): Promise<{ ok: boolean; observedPid: number | null | undefined }> {
  rows = processRows;
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
});
