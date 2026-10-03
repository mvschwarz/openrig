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
  "changed-after-paste", "bare-shell-helper", "bare-shell-job",
  "wrong-token-post-read-error", "wrong-token-post-read-empty",
  "bare-shell-post-read-error", "bare-shell-post-read-empty",
  "bare-shell-second-process-unavailable", "bare-shell-first-process-unavailable",
  "launcher-shim", "launcher-shim-mixed-token", "launcher-shim-siblings",
  "launcher-shim-match", "launcher-shim-match-after", "launcher-shim-child-differs",
  "launcher-shim-child-differs-after", "launcher-shim-child-unparsed",
  "launcher-shim-shims-differ", "launcher-shim-child-two-sessions", "settings-single",
];
// The real process behind a spawning shim carries its own argv.
const shimChild: Record<string, string> = {
  "launcher-shim-match": `--settings /shim/settings.json --session-id ${token}`,
  "launcher-shim-match-after": `--session-id ${token} --settings /shim/settings.json`,
  "launcher-shim-child-differs": "--settings /shim/settings.json --session-id different",
  "launcher-shim-child-differs-after": "--session-id different --settings /shim/settings.json",
  "launcher-shim-child-unparsed": "--settings /shim/settings.json --unrecognised-flag",
  "launcher-shim-child-two-sessions": `--settings /shim/settings.json --session-id ${token} --session-id different`,
};

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
    const bare = mode.startsWith("bare-shell");
    const shell = mode === "bare-shell-helper" ? "zsh" : "bash";
    const rows = [
      { pid: 100, ppid: 1, pgid: 100, tpgid: bare ? 100 : 101,
        executableName: shell, command: `-${shell}`, startedAt },
      ...(bare ? [] : [
        { pid: 101, ppid: 100, pgid: 101, tpgid: 101,
          executableName: "sh", command: "/bin/sh /fixture/launch", startedAt },
        { pid: 102, ppid: 101, pgid: mode === "background" ? 999 : 101, tpgid: 101,
          executableName: ["versioned", "versioned-comm-only", "other-semver", "versioned-direct-pane"].includes(mode) ? "2.1.285" : "claude",
          command: `${executable} --permission-mode auto ${mode === "settings-single" ? "--settings /fixture/settings.json " : ""}${mode === "missing-token" ? "" : `--session-id ${mode.startsWith("wrong-token") || mode === "launcher-shim-shims-differ" ? "different" : token}`} --name ${name}`, startedAt },
      ]),
    ];
    // The shell still owns the terminal; these children are in background groups.
    if (mode === "bare-shell-helper" || mode === "bare-shell-job") {
      rows.push({ pid: 103, ppid: 100, pgid: 103, tpgid: 100,
        executableName: mode === "bare-shell-helper" ? "gitstatusd" : "sleep",
        command: mode === "bare-shell-helper" ? "/fixture/gitstatusd" : "sleep 600", startedAt });
    }
    if (mode === "ambiguous-process") rows.push({ ...rows[2]!, pid: 103 });
    // A launcher shim spawns (not execs) the real binary: one chain of three claude processes.
    if (mode.startsWith("launcher-shim")) {
      rows.push(
        { ...rows[2]!, pid: 104, ppid: 102,
          command: `/shim/bin/claude --permission-mode auto --session-id ${["launcher-shim-mixed-token", "launcher-shim-shims-differ"].includes(mode) ? "different" : token} --name ${name}` },
        { ...rows[2]!, pid: 105, ppid: mode === "launcher-shim-siblings" ? 102 : 104, command: `/shim/claude ${shimChild[mode] ?? "--settings /shim/settings.json"} --permission-mode auto` },
      );
    }
    let reads = 0;
    const listProcesses = async () => {
      if (["unavailable", "unknown-both"].includes(mode)) throw new Error("fixture unavailable");
      reads++;
      if ((mode === "bare-shell-second-process-unavailable" && reads === 2)
        || (mode === "bare-shell-first-process-unavailable" && reads === 1)) throw new Error("process sample unavailable");
      return mode === "changed-process" && reads % 2 === 0
        ? rows.map(row => row.pid === 102 ? { ...row, startedAt: "replacement" } : row) : rows;
    };
    const calls: string[] = [];
    let paneReads = 0;
    const tmux = {
      hasSession: async () => true,
      probeSession: async () => ({ state: "present" }),
      getPanePid: async (target: string) => mode === "wrong-pane" && target === "%1" ? 999 : 100,
      getPaneCommand: async () => {
        if (["pane-command-unavailable", "unknown-both"].includes(mode)) throw new Error("fixture command unavailable");
        return mode === "versioned-direct-pane" ? "2.1.285" : "sh";
      },
      listPanes: async () => {
        paneReads++;
        if (paneReads > 1 && mode.endsWith("post-read-error")) throw new Error("later pane observation unavailable");
        if (paneReads > 1 && mode.endsWith("post-read-empty")) return [];
        return mode === "ambiguous-pane" ? [{ id: "%1" }, { id: "%2" }] : [{ id: "%1" }];
      },
      capturePaneContent: async () => {
        if (mode === "changed-binding") sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%2" });
        return mode === "onboarding" ? "Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit"
          : bare ? "admin@fixture ~ % " : autoScreen;
      },
      sendText: async () => {
        calls.push("text");
        if (mode === "changed-after-paste") sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%2" });
        return { ok: true };
      },
      sendKeys: async () => { calls.push("enter"); return { ok: true }; },
    } as unknown as TmuxAdapter;
    const observation = await verifyClaudePaneProcess({ target: "%1", tmux, listProcesses, expectedToken: token });
    reads = 0; // Each consumer starts its own observation sequence.
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, listProcesses, sleep: async () => {} });
    const sent = await transport.send(name, "harmless fixture message");
    const expectedSend = [
      "npm-name", "versioned", "pane-command-unavailable", "unknown-both", "versioned-direct-pane",
      "missing-token", "unavailable", "background", "other-semver", "missing-metadata",
      "versioned-argv-only", "versioned-comm-only", "launcher-shim",
      "launcher-shim-match", "launcher-shim-match-after", "launcher-shim-child-unparsed",
      "launcher-shim-child-two-sessions", "settings-single",
      "wrong-token", "wrong-token-post-read-error", "wrong-token-post-read-empty", "launcher-shim-shims-differ",
    ].includes(mode);
    if (bare) expect({ ok: sent.ok, calls }).toEqual({ ok: false, calls: [] });
    expect(sent.ok).toBe(expectedSend);
    expect(calls).toEqual(expectedSend ? ["text", "enter"] : mode === "changed-after-paste" ? ["text"] : []);
    // A strict process selector proves only the supplied process/token, not the DB/pane binding.
    expect(observation !== null).toBe([
      "npm-name", "versioned", "pane-command-unavailable", "versioned-direct-pane", "missing-metadata",
      "ambiguous-pane", "changed-binding", "onboarding", "changed-after-paste",
    ].includes(mode));
    if (expectedSend && ["unavailable", "unknown-both", "missing-token", "missing-metadata", "background", "other-semver", "versioned-argv-only", "versioned-comm-only", "launcher-shim", "launcher-shim-child-unparsed", "launcher-shim-child-two-sessions"].includes(mode)) {
      expect(sent.warning).toContain("without verified native identity");
    }
    // Static launch tokens alone cannot prove a different current recipient after
    // /clear. This also applies when only the shim has a parseable launch token.
    if (mode.startsWith("wrong-token") || mode === "launcher-shim-shims-differ") {
      expect(sent.warning).toContain("without verified native identity");
    }
    // --settings is delivery-only: the strict selector above still rejects it (observation === null).
    if (mode.startsWith("launcher-shim-match") || mode === "settings-single") expect(sent.warning ?? "").not.toContain("without verified native identity");
    if (mode.startsWith("launcher-shim-child-differs")) expect(sent.error).toContain("name different conversations");
    if (mode === "launcher-shim-mixed-token") expect(sent.error).toContain("name different conversations");
    // Two children of one shim are two runtimes, not a chain.
    if (mode === "launcher-shim-siblings") expect(sent.error).toContain("Multiple Claude processes");
    reads = 0; paneReads = 0;
    const queue = new QueueRepository(db, eventBus, { transport, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    // Exercise the actual wake consumer without an API, scheduler, or native process.
    const wake = await (queue as unknown as {
      performWakeSend(id: string, destination: string, sender: string): Promise<{ classified: string }>;
    }).performWakeSend("fixture-q197", name, "fixture-sender@native-test");
    expect(wake.classified).toBe(expectedSend ? "indeterminate" : "failed");
  } finally { db.close(); }
});
