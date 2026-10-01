import { it, expect } from "vitest";
import { verifyClaudePaneProcess } from "../src/domain/native-process-lineage.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const token = "00000000-0000-4000-8000-000000000197";
const startedAt = "Thu Oct  1 11:00:00 2026";
const autoScreen = "Restored conversation\n─────────\n❯\u00a0\n─────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n";
const modes = [
  "npm-name", "versioned", "versioned-argv-only", "versioned-comm-only", "wrong-token",
  "missing-token", "wrong-pane", "bare-shell", "unavailable", "pane-command-unavailable",
  "background", "other-semver", "unknown-both", "versioned-direct-pane", "missing-metadata",
  "ambiguous-pane", "changed-binding", "onboarding", "changed-process", "ambiguous-process",
  "changed-after-paste",
];

it.each(modes)("selector and ordinary transport: %s", async (mode) => {
  const db = createFullTestDb();
  try {
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
    const rig = rigRepo.createRig("native-test"), node = rigRepo.addNode(rig.id, "test.c", { runtime: "claude-code" });
    const name = "test-c@native-test", session = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(session.id, "running");
    if (mode !== "missing-metadata") sessionRegistry.updateResumeToken(session.id, "claude_id", token, "scrape");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    const executable = ["versioned", "versioned-argv-only", "versioned-direct-pane"].includes(mode)
      ? "/fixture/.local/share/claude/versions/2.1.285"
      : mode === "other-semver" ? "/unrelated/2.1.285" : "/opt/claude";
    const rows = [
      { pid: 100, ppid: 1, pgid: 100, tpgid: mode === "bare-shell" ? 100 : 101,
        executableName: "bash", command: "-bash", startedAt },
      ...(mode === "bare-shell" ? [] : [
        { pid: 101, ppid: 100, pgid: 101, tpgid: 101,
          executableName: "sh", command: "/bin/sh /fixture/launch", startedAt },
        { pid: 102, ppid: 101, pgid: mode === "background" ? 999 : 101, tpgid: 101,
          executableName: ["versioned", "versioned-comm-only", "other-semver", "versioned-direct-pane"].includes(mode) ? "2.1.285" : "claude",
          command: `${executable} --permission-mode auto ${mode === "missing-token" ? "" : `--session-id ${mode === "wrong-token" ? "different" : token}`} --name ${name}`, startedAt },
      ]),
    ];
    if (mode === "ambiguous-process") rows.push({ ...rows[2]!, pid: 103 });
    let reads = 0;
    const listProcesses = async () => {
      if (["unavailable", "unknown-both"].includes(mode)) throw new Error("fixture unavailable");
      reads++;
      return mode === "changed-process" && reads % 2 === 0
        ? rows.map(row => row.pid === 102 ? { ...row, startedAt: "replacement" } : row) : rows;
    };
    const calls: string[] = [];
    const tmux = {
      hasSession: async () => true,
      probeSession: async () => ({ state: "present" }),
      getPanePid: async (target: string) => mode === "wrong-pane" && target === "%1" ? 999 : 100,
      getPaneCommand: async () => {
        if (["pane-command-unavailable", "unknown-both"].includes(mode)) throw new Error("fixture command unavailable");
        return mode === "versioned-direct-pane" ? "2.1.285" : "sh";
      },
      listPanes: async () => mode === "ambiguous-pane" ? [{ id: "%1" }, { id: "%2" }] : [{ id: "%1" }],
      capturePaneContent: async () => {
        if (mode === "changed-binding") sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%2" });
        return mode === "onboarding" ? "Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit"
          : mode === "bare-shell" ? "admin@fixture ~ % " : autoScreen;
      },
      sendText: async () => {
        calls.push("text");
        if (mode === "changed-after-paste") sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%2" });
        return { ok: true };
      },
      sendKeys: async () => { calls.push("enter"); return { ok: true }; },
    } as unknown as TmuxAdapter;
    const observation = await verifyClaudePaneProcess({ target: "%1", tmux, listProcesses, expectedToken: token });
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, listProcesses, sleep: async () => {} });
    const sent = await transport.send(name, "harmless fixture message");
    const expectedSend = [
      "npm-name", "versioned", "pane-command-unavailable", "unknown-both", "versioned-direct-pane",
      "missing-token", "unavailable", "background", "other-semver", "missing-metadata",
      "versioned-argv-only", "versioned-comm-only",
    ].includes(mode);
    expect(sent.ok).toBe(expectedSend);
    expect(calls).toEqual(expectedSend ? ["text", "enter"] : mode === "changed-after-paste" ? ["text"] : []);
    // A strict process selector proves only the supplied process/token, not the DB/pane binding.
    expect(observation !== null).toBe([
      "npm-name", "versioned", "pane-command-unavailable", "versioned-direct-pane", "missing-metadata",
      "ambiguous-pane", "changed-binding", "onboarding", "changed-after-paste",
    ].includes(mode));
    if (expectedSend && ["unavailable", "unknown-both", "missing-token", "missing-metadata", "background", "other-semver", "versioned-argv-only", "versioned-comm-only"].includes(mode)) {
      expect(sent.warning).toContain("without verified native identity");
    }
    reads = 0;
    const queue = new QueueRepository(db, eventBus, { transport, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    // Exercise the actual wake consumer without an API, scheduler, or native process.
    const wake = await (queue as unknown as {
      performWakeSend(id: string, destination: string, sender: string): Promise<{ classified: string }>;
    }).performWakeSend("fixture-q197", name, "fixture-sender@native-test");
    expect(wake.classified).toBe(expectedSend ? "indeterminate" : "failed");
  } finally { db.close(); }
});
