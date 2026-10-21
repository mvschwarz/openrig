import { describe, expect, it } from "vitest";
import { relayAttachCommand, matchesRelaySsh, parseSshTmuxRelay, parseRelaySnapshot, relayLocalFingerprint } from "../src/domain/ssh-tmux-relay.js";
import { observeCodexPaneProcess, verifyCodexPaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

const relay = { kind: "ssh-tmux" as const, host: "worker", session: "wm-test" };
const ssh = "ssh -o BatchMode=yes -o ConnectTimeout=8 -tt -R 127.0.0.1:1234:127.0.0.1:5678 worker " + relayAttachCommand(relay);
const row = (pid: number, ppid: number, command: string, executableName: string, group: number): NativeProcessRow =>
  ({ pid, ppid, command, executableName, pgid: group, tpgid: group, startedAt: "Wed Oct 21 01:02:03 2026" });
const local = [row(10, 1, ssh, "ssh", 10)];
const remote = [row(20, 1, "sh", "sh", 30), row(30, 20, "codex", "codex", 30)];
const snapshot = { panePid: 20, rows: remote, identity: "$1 100 %2 20" };
const input = () => ({ target: "%1", tmux: { getPanePid: async () => 10, getSshRelay: () => relay },
  listProcesses: () => local, readRelay: async () => snapshot });

describe("explicit SSH tmux Codex identity", () => {
  it("requires valid bounded identifiers and the exact canonical SSH route", () => {
    expect(parseSshTmuxRelay(relay)).toEqual(relay);
    for (const host of ["-oProxyCommand=x", "host;touch /tmp/x", "host\nother", "user@host:22"]) expect(parseSshTmuxRelay({ ...relay, host })).toBeNull();
    for (const session of ["-x", "a.b", "$(cmd)", "a;cmd"]) expect(parseSshTmuxRelay({ ...relay, session })).toBeNull();
    expect(matchesRelaySsh(ssh, relay)).toBe(true);
    for (const command of [ssh.replace("worker", "other"), ssh + " ; echo yes", ssh.replace("-tt", "-F elsewhere"), ssh.replace("-tt", "-T"), ssh.replace("-tt ", ""),
      ssh.replace("-tt", "-o ProxyCommand=other"), ssh.replace("=wm-test", "=other"), "echo " + ssh]) expect(matchesRelaySsh(command, relay)).toBe(false);
  });
  it("requires an unambiguous foreground SSH descendant with OS name and start identity", () => {
    expect(relayLocalFingerprint(local, 10, relay)).toBeTruthy();
    for (const rows of [[{ ...local[0]!, executableName: "sh" }], [{ ...local[0]!, startedAt: undefined }],
      [{ ...local[0]!, tpgid: 99 }], [...local, local[0]!]]) expect(relayLocalFingerprint(rows, 10, relay)).toBeNull();
  });
  it("qualifies remote Codex while retaining the local pane root for delivery", async () => {
    const found = await verifyCodexPaneProcess(input());
    expect(found).toMatchObject({ panePid: 10, process: { pid: 30, command: "codex" } });
    expect(found?.fingerprint).toContain("worker");
    expect(await verifyCodexPaneProcess({ ...input(), expectedToken: "expected", requireResume: true })).toBeNull();
  });
  it("refuses missing/stale/changed remote or local identity, without falling back to a local Codex", async () => {
    expect(await observeCodexPaneProcess({ ...input(), readRelay: async () => null })).toBeNull();
    expect(await observeCodexPaneProcess({ ...input(), readRelay: async () => ({ ...snapshot, rows: [row(20, 1, "sh", "sh", 20)] }) })).toBeNull();
    let count = 0;
    expect(await verifyCodexPaneProcess({ ...input(), readRelay: async () => ({ ...snapshot, identity: String(count++) }) })).toBeNull();
    count = 0;
    expect(await observeCodexPaneProcess({ ...input(), tmux: { ...input().tmux, getPanePid: async () => count++ ? 11 : 10 } })).toBeNull();
    expect(await observeCodexPaneProcess({ ...input(), listProcesses: () => [row(10, 1, "codex", "codex", 10)] })).toBeNull();
  });
  it("keeps ordinary local Codex proof unchanged", async () => {
    expect(await verifyCodexPaneProcess({ target: "%2", tmux: { getPanePid: async () => 20 }, listProcesses: () => remote }))
      .toMatchObject({ panePid: 20, process: { pid: 30 } });
  });
  it("parses one remote pane and refuses multi-pane or malformed snapshots", () => {
    const table = "PID PPID PGID TPGID UCOMM STARTED COMMAND\n20 1 30 30 sh Wed Oct 21 01:02:03 2026 sh\n30 20 30 30 codex Wed Oct 21 01:02:03 2026 codex\n";
    const bytes = "$1 100 %2 20\n\nOPENRIG_PROCESS_TABLE\n" + table;
    expect(parseRelaySnapshot(bytes)).toEqual(snapshot);
    expect(parseRelaySnapshot("$1 100 %3 21\n" + bytes)).toBeNull();
    expect(parseRelaySnapshot(bytes.replace("OPENRIG_PROCESS_TABLE", "wrong"))).toBeNull();
  });
  it("persists only on the binding and clears relay identity on transport rebinding", () => {
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const rigs = new RigRepository(db), rig = rigs.createRig("relay-test");
      const node = rigs.addNode(rig.id, "worker", { runtime: "codex" });
      const sessions = new SessionRegistry(db);
      sessions.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: "local", tmuxPane: "%1", relay });
      expect(new SessionRegistry(db).getBindingForNode(node.id)?.relay).toEqual(relay);
      sessions.updateBinding(node.id, { cmuxSurface: "label" });
      expect(sessions.getBindingForNode(node.id)?.relay).toEqual(relay);
      sessions.updateBinding(node.id, { tmuxPane: "%2" });
      expect(sessions.getBindingForNode(node.id)?.relay).toBeUndefined();
    } finally { db.close(); }
  });
});
