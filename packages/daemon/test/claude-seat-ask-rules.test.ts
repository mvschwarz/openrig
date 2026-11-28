// 0.7.26/04: a seat's selected Claude ask rules are recorded beside allow and deny and reach every supported launch,
// including a same-conversation continuation from captured arguments. Offline: stub harnesses only. Whether Claude
// prompts for an ask rule under a given mode is Claude's own behaviour and isn't claimed here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigSpecCodec, LegacyRigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { readClaudePermissionRules, validateClaudePermissionRules } from "../src/domain/claude-permission-rules.js";
import { operationalLaunchArgs, KERNEL_CLAUDE_ALLOW, TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK } from "../src/adapters/kernel-authority.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { composedSeatPermissionPolicy, sendsSeatPermissionPolicy } from "../src/domain/claude-continuation-launch.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const selected = {
  allow: ["Bash(rig ps *)", "Bash(rig queue show *)"],
  ask: ["Bash(rig seat restart *)", "Bash(rig config set *)"],
  deny: ["Read(./private/**)"],
};
const allowDeny = { allow: selected.allow, deny: selected.deny };

/** The 0.7.25-and-earlier reader of a seat's recorded rules, kept verbatim so a rollback can be checked against it. */
function olderReader(stored: string): { allow: string[]; deny: string[] } {
  const raw = JSON.parse(stored) as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (key !== "allow" && key !== "deny") throw new Error(`claude_permissions.${key}: unsupported key; only allow and deny are supported`);
  return { allow: (raw.allow as string[] | undefined) ?? [], deny: (raw.deny as string[] | undefined) ?? [] };
}

const settingsOf = (args: string[]) => {
  expect(args.filter(arg => arg === "--settings")).toHaveLength(1);
  return JSON.parse(args[args.indexOf("--settings") + 1]!) as Record<string, any>;
};

const opened: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const db = new Database(":memory:"); opened.push(db);
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), rig = rigRepo.createRig("rules");
  const a = rigRepo.addNode(rig.id, "dev.a", { runtime: "claude-code", cwd: "/project" });
  const registry = new SessionRegistry(db), session = registry.registerSession(a.id, "dev-a@rules");
  registry.updateStatus(session.id, "running");
  const eventBus = new EventBus(db);
  const tmux = new Proxy({}, { get: (_, key) => key === "deliveryGuard" ? undefined : () => { throw new Error("No native or lifecycle effect allowed"); } }) as TmuxAdapter;
  const service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux });
  return { db, rigRepo, a, service };
}
const stored = (db: Database.Database, id: string) => (db.prepare("SELECT claude_permissions_json v FROM nodes WHERE id=?").get(id) as { v: string | null }).v;
const update = (rules: unknown) => ({ seatRef: "dev-a@rules", rules, actor: "operator@rules", reason: "Record the selected policy" });

describe("the rules record carries ask beside allow and deny", () => {
  it("accepts and validates ask entries as it does allow and deny", () => {
    expect(validateClaudePermissionRules(selected)).toEqual(selected);
    expect(() => validateClaudePermissionRules({ ask: ["Bash\nRead"] })).toThrow(/claude_permissions\.ask\[0\]/);
    expect(() => validateClaudePermissionRules({ ask: ["mcp__server__tool(argument)"] })).toThrow(/claude_permissions\.ask\[0\]/);
    expect(() => validateClaudePermissionRules({ ask: "Bash" })).toThrow(/claude_permissions\.ask/);
    expect(() => validateClaudePermissionRules({ defaultMode: "auto" })).toThrow(/only allow, ask and deny are supported/);
  });

  it("leaves a record without asks exactly as before: no ask key, so an older reader still reads it", () => {
    expect(validateClaudePermissionRules(allowDeny)).toEqual(allowDeny);
    expect(validateClaudePermissionRules({ ...allowDeny, ask: [] })).toEqual(allowDeny);
    expect(JSON.stringify(validateClaudePermissionRules({ ...allowDeny, ask: [] }))).toBe(JSON.stringify(allowDeny));
  });
});

describe("launch composition puts the seat's asks in the one --settings value", () => {
  it("adds native permissions.ask beside allow and deny under an explicit auto mode, changing nothing else", () => {
    const base = { permissionMode: "auto", managedCompaction: true };
    const without = operationalLaunchArgs("claude-code", { ...base, claudePermissions: allowDeny });
    const withAsk = operationalLaunchArgs("claude-code", { ...base, claudePermissions: selected });
    const before = settingsOf(without), after = settingsOf(withAsk);
    expect(after.permissions).toEqual({ ...before.permissions, ask: selected.ask });
    for (const key of Object.keys(before).filter(key => key !== "permissions")) expect(after[key]).toEqual(before[key]);
    expect(after.idleCompaction).toBe(false);
    const rest = (args: string[]) => args.filter((_, i) => args[i] !== "--settings" && args[i - 1] !== "--settings");
    expect(rest(withAsk)).toEqual(rest(without));
  });

  it("composes a seat without asks byte for byte as before", () => {
    const choice = { permissionMode: "default", managedCompaction: false, claudePermissions: allowDeny };
    expect(operationalLaunchArgs("claude-code", choice)).toEqual(["--settings", JSON.stringify({ permissions: allowDeny })]);
    expect(operationalLaunchArgs("claude-code", { ...choice, claudePermissions: validateClaudePermissionRules({ ...allowDeny, ask: [] }) }))
      .toEqual(operationalLaunchArgs("claude-code", choice));
  });

  it("keeps the team default's grants and hooks, and the seat's stricter deny, beside its asks", () => {
    const choice = { teamPermissionDefault: true, managedCompaction: true, claudePermissions: selected };
    const settings = settingsOf(operationalLaunchArgs("claude-code", choice));
    expect(settings.permissions.allow).toEqual([...TEAM_CLAUDE_ALLOW, ...selected.allow]);
    expect(settings.permissions.deny).toEqual(selected.deny);
    expect(settings.permissions.ask).toEqual(expect.arrayContaining(selected.ask));
    expect(settings.hooks).toEqual(settingsOf(operationalLaunchArgs("claude-code", { teamPermissionDefault: true, managedCompaction: true })).hooks);
  });
});

describe("the audited set-permissions path records, plans and exports the complete selection", () => {
  it("round-trips allow, ask and deny through the store, status, export and import", async () => {
    const f = fixture();
    expect(await f.service.setPermissions(update(selected))).toMatchObject({ ok: true, changed: true, from: null, to: selected });
    expect(readClaudePermissionRules(f.db, f.a.id)).toEqual(selected);
    const event = JSON.parse((f.db.prepare("SELECT payload FROM events WHERE type='node.permission_rules_changed'").get() as { payload: string }).payload);
    expect(event).toMatchObject({ to: selected, effect: "future_launches_only" });
    const planned = new NativePermissionStore(f.db).launchOverride(f.a.id, "claude-code");
    expect(planned.claudePermissions).toEqual(selected);
    expect(settingsOf(operationalLaunchArgs("claude-code", planned)).permissions.ask).toEqual(expect.arrayContaining(selected.ask));
    const status = new SeatStatusService({ rigRepo: f.rigRepo }).getStatus("dev-a@rules");
    expect(status).toMatchObject({ ok: true, status: { permissions: { account: { basis: "planned",
      openRigAdds: { claudeAsk: expect.arrayContaining(selected.ask), claudeDeny: selected.deny } } } } });

    const legacy = new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: new SessionRegistry(f.db) }).exportRig(f.a.rigId);
    const flat = LegacyRigSpecCodec.parse(LegacyRigSpecCodec.serialize(legacy as import("../src/domain/types.js").LegacyRigSpec));
    expect(LegacyRigSpecSchema.normalize(flat).nodes[0]!.claudePermissions).toEqual(selected);

    const podRepo = new PodRepository(f.db), pod = podRepo.createPod(f.a.rigId, "dev", "Dev");
    f.db.prepare("UPDATE nodes SET pod_id=? WHERE rig_id=?").run(pod.id, f.a.rigId);
    const podded = new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: new SessionRegistry(f.db), podRepo }).exportRig(f.a.rigId);
    const parsed = RigSpecCodec.parse(RigSpecCodec.serialize(podded as import("../src/domain/types.js").RigSpec));
    // This bare fixture exports without an agent_ref, so only the rules' own validation is read here.
    expect(RigSpecSchema.validate(parsed as unknown as Record<string, unknown>).errors.join(" ")).not.toContain("claude_permissions");
    expect(RigSpecSchema.normalize(parsed).pods[0]!.members[0]!.claudePermissions).toEqual(selected);
    const authored = { version: "0.2", name: "authored", pods: [{ id: "dev", label: "Dev", members: [
      { id: "reader", agent_ref: "local:reader.agent.yaml", profile: "default", runtime: "claude-code", cwd: "/project", claude_permissions: selected },
    ], edges: [] }], edges: [] };
    expect(RigSpecSchema.validate(authored)).toMatchObject({ valid: true });
  });

  it("stores a selection without asks in exactly the bytes it stored before", async () => {
    const f = fixture();
    expect(await f.service.setPermissions(update({ ...allowDeny, ask: [] }))).toMatchObject({ ok: true });
    expect(stored(f.db, f.a.id)).toBe(JSON.stringify(allowDeny));
  });
});

describe("rollback to an older OpenRig", () => {
  it("an older reader refuses a record with asks by name, and the audited conversion it can read keeps the asks in the audit", async () => {
    const f = fixture();
    const set = await f.service.setPermissions(update(selected));
    expect(set).toMatchObject({ ok: true, effect: expect.stringMatching(/older OpenRig.*refuses.*ask/i) });
    // What an older daemon does with this record before its next launch: refuse it with the repair, never drop the asks.
    expect(() => olderReader(stored(f.db, f.a.id)!)).toThrow(/claude_permissions\.ask: unsupported key/);
    // The rollback step, run on this daemon before the downgrade: record the allow and deny lists alone.
    expect(await f.service.setPermissions({ ...update(allowDeny), reason: "Before downgrading to 0.7.25" })).toMatchObject({ ok: true, changed: true, from: selected, to: allowDeny });
    expect(olderReader(stored(f.db, f.a.id)!)).toEqual(allowDeny);
    const events = (f.db.prepare("SELECT payload FROM events WHERE type='node.permission_rules_changed' ORDER BY seq").all() as { payload: string }[]).map(row => JSON.parse(row.payload));
    expect(events.at(-1)).toMatchObject({ from: selected, to: allowDeny });
  });
});

// ---- Launch paths, with stub harnesses ----

function resumeTmux() {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })), sendKeys: vi.fn(async () => ({ ok: true as const })),
    sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"), getPanePid: vi.fn(async () => null), setSessionEnv: vi.fn(async () => {}),
    capturePaneContent: vi.fn(async () => `Claude Code v2.1.316\n${"─".repeat(60)}\n❯ \n${"─".repeat(60)}\n  ⏵⏵ auto mode on`),
    createSession: async () => ({ ok: true as const }), killSession: async () => ({ ok: true as const }),
    listSessions: async () => [], listWindows: async () => [], listPanes: async () => [], hasSession: async () => true,
  } as unknown as TmuxAdapter;
}
/** The words a POSIX shell reads from a launch command: single quotes, double quotes (shellQuote writes a quote as
 *  '"'"'), and backslashes. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "", inWord = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'" || c === '"') { const end = command.indexOf(c, i + 1); word += command.slice(i + 1, end); i = end; inWord = true; }
    else if (c === "\\") { word += command[++i] ?? ""; inWord = true; }
    else if (/\s/.test(c)) { if (inWord) words.push(word); word = ""; inWord = false; }
    else { word += c; inWord = true; }
  }
  if (inWord) words.push(word);
  return words;
}
// The --settings value as the shell passes it, whether the flag is quoted (a continuation) or not (a classic command).
const inlineSettings = (command: string) => {
  const words = shellWords(command);
  return JSON.parse(words[words.indexOf("--settings") + 1]!) as Record<string, any>;
};

describe("restore's resume composes the stored asks", () => {
  it("an ordinary restore sends them in its --settings value", async () => {
    const tmux = resumeTmux();
    const args: Parameters<ClaudeResumeAdapter["resume"]> = ["seat@rig", "claude_id", "same", "/repo", "floor"];
    args[14] = selected;
    await new ClaudeResumeAdapter(tmux, { maxWaitMs: 1, sleep: async () => {} }).resume(...args);
    const command = vi.mocked(tmux.sendText).mock.calls[0]![1];
    expect(inlineSettings(command).permissions).toMatchObject({ ask: selected.ask, deny: selected.deny });
    expect(command).toContain("--resume 'same'");
  });

  describe("a same-conversation continuation from captured arguments", () => {
    // The running process was launched before the seat's selection: its settings lack the asks and carry an old allow
    // and an old ask, beside permissions fields the record doesn't own.
    const running = { permissions: { allow: ["Bash(stale *)"], ask: ["Bash(stale-ask *)"], additionalDirectories: ["/selected/docs"], defaultMode: "auto" },
      custom: "kept", idleCompaction: false };
    const continueWith = async (rules: unknown, args = ["--settings", JSON.stringify(running), "--model", "opus"], managed = true) => {
      const tmux = resumeTmux();
      const nativeCommand = vi.fn((_args: string[]) => "retained-launch");
      const prepare = vi.fn(async () => ({ command: nativeCommand, warnings: [], assertCurrent: () => {} }));
      const resumeArgs: Parameters<ClaudeResumeAdapter["resume"]> = ["seat@rig", "claude_id", "same-conversation", "/repo", "auto", undefined, managed ? "auto" : undefined, "node"];
      resumeArgs[14] = rules as never;
      resumeArgs[16] = "/native/claude";
      resumeArgs[19] = { args, configDir: null, warnings: [] };
      const result = await new ClaudeResumeAdapter(tmux, { maxWaitMs: 1, sleep: async () => {},
        ...(managed ? { claudeManagedLaunch: { prepare } as unknown as ClaudeManagedLaunch } : {}) }).resume(...resumeArgs);
      if (!managed) {
        const command = vi.mocked(tmux.sendText).mock.calls[0]![1];
        return { result, sent: [command], settings: inlineSettings(command) };
      }
      const sent = nativeCommand.mock.calls[0]![0];
      const value = sent[sent.indexOf("--settings") + 1]!;
      return { result, sent, settings: value.startsWith("{") ? JSON.parse(value) as Record<string, any> : value };
    };

    it("sends the stored selection instead of the running process's rule lists, keeping its other settings and conversation", async () => {
      const { sent, settings } = await continueWith(selected);
      expect(settings.permissions.ask).toEqual(selected.ask);
      expect(settings.permissions.deny).toEqual(selected.deny);
      expect(settings.permissions.allow).toEqual(expect.arrayContaining(selected.allow));
      expect(settings.permissions.allow).not.toContain("Bash(stale *)");
      expect(settings.custom).toBe("kept");
      expect(sent.slice(-2)).toEqual(["--resume", "same-conversation"]);
      expect(sent).toEqual(expect.arrayContaining(["--model", "opus"]));
    });

    it.each([true, false])("keeps the running process's other permissions fields, such as additionalDirectories (managed: %s)", async managed => {
      for (const rules of [selected, allowDeny]) {
        const { settings } = await continueWith(rules, undefined, managed);
        expect(settings.permissions.additionalDirectories).toEqual(running.permissions.additionalDirectories);
        expect(settings.permissions.defaultMode).toBe("auto");
        expect(settings.custom).toBe("kept");
      }
    });

    it("drops a running ask the seat's record no longer holds, as it does a running allow", async () => {
      const { settings } = await continueWith(allowDeny);
      expect(settings.permissions).not.toHaveProperty("ask");
      expect(settings.permissions.allow).not.toContain("Bash(stale *)");
      expect(settings.permissions.deny).toEqual(allowDeny.deny);
    });

    it.each([true, false])("leaves the running settings as they are for a seat that records no rules (managed: %s)", async managed => {
      const { settings } = await continueWith(undefined, undefined, managed);
      expect(settings).toEqual(running);
    });

    it("says so when the running settings are a file it can't read, instead of dropping the selection silently", async () => {
      const { result, sent } = await continueWith(selected, ["--settings", "/custom/settings.json", "--model", "opus"]);
      expect(sent).toContain("/custom/settings.json");
      expect(result).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.stringMatching(/recorded Claude rules.*not applied/)]) });
    });
  });
});

describe("a continuation sends the team default's permission hook with the team's allows (review C1)", () => {
  const TEAM_HOOK = "claude-team-permissions.cjs";
  // A launch policy encoded the way OpenRig wrote it before #2640: base64 of JSON with allow and ask.
  const encodedPolicy = (word: string) => {
    try { const policy = JSON.parse(Buffer.from(word, "base64").toString("utf8")); return Object.keys(policy ?? {}).length === 2 && Array.isArray(policy?.allow) && Array.isArray(policy?.ask); }
    catch { return false; }
  };
  // OpenRig's own hook by its words (node, the script, the kind or encoded policy), not by a substring of its command.
  const ownsHook = (hook: any) => {
    const words = shellWords(String(hook?.command ?? ""));
    return hook?.type === "command" && words.length === 3 && /^node(?:js)?(?:\.exe)?$/.test(path.basename(words[0]!))
      && path.basename(words[1]!) === TEAM_HOOK && (["team", "kernel"].includes(words[2]!) || encodedPolicy(words[2]!));
  };
  /** A hook as OpenRig launched it before #2640, with the launch policy encoded in its third word. */
  const legacyHook = (allow: string[], ask: string[]) => ({ type: "command", timeout: 5,
    command: ["/usr/local/bin/node", "/old install/claude-team-permissions.cjs", Buffer.from(JSON.stringify({ allow, ask })).toString("base64")].map(shellQuote).join(" ") });
  const teamHookEntries = (settings: Record<string, any>) => (settings.hooks?.PreToolUse ?? []).flatMap((entry: any) => (entry.hooks ?? []).filter(ownsHook));
  const allPreToolUseHooks = (settings: Record<string, any>) => (settings.hooks?.PreToolUse ?? []).flatMap((entry: any) => entry.hooks ?? []);
  const otherHook = { matcher: "Write", hooks: [{ type: "command", command: "/usr/local/bin/my-check", timeout: 5 }] };
  const oldOwn = { type: "command", command: 'node "/old install/claude-team-permissions.cjs" team', timeout: 5 };
  const sibling = { type: "command", command: "/usr/local/bin/my-project-check", timeout: 8 };
  // A classic continuation (no managed mode), so the team default applies: teamPermissionDefault, no explicit mode.
  const continueTeam = async (running: Record<string, unknown>, teamDefault = true) => {
    const tmux = resumeTmux();
    const args: Parameters<ClaudeResumeAdapter["resume"]> = ["seat@rig", "claude_id", "same-conversation", "/repo", "floor", undefined, undefined, "node"];
    args[11] = teamDefault; args[14] = selected; args[16] = "/native/claude";
    args[19] = { args: ["--settings", JSON.stringify(running), "--model", "opus"], configDir: null, warnings: [] };
    await new ClaudeResumeAdapter(tmux, { maxWaitMs: 1, sleep: async () => {} }).resume(...args);
    return inlineSettings(vi.mocked(tmux.sendText).mock.calls[0]![1]);
  };

  it("adds the team hook when the running process started without it (an explicit mode or a policy, then the team default)", async () => {
    const settings = await continueTeam({ permissions: { allow: ["Bash(stale *)"] }, custom: "kept" });
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(TEAM_CLAUDE_ALLOW));
    expect(teamHookEntries(settings)).toHaveLength(1);
    expect(settings.permissions.ask).toEqual(selected.ask);
    expect(settings.custom).toBe("kept");
  });

  it("replaces a running process's static team asks with the team hook, and keeps its unrelated hooks", async () => {
    const settings = await continueTeam({ permissions: { allow: [...TEAM_CLAUDE_ALLOW], ask: ["Bash(rig down*)"] },
      hooks: { PreToolUse: [otherHook], SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/start" }] }] } });
    expect(teamHookEntries(settings)).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toEqual(expect.arrayContaining([otherHook]));
    expect(settings.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: "/usr/local/bin/start" }] }]);
    expect(settings.permissions.ask).toEqual(selected.ask);
  });

  it("sends one team hook, not two, when the running process already has it", async () => {
    const composed = settingsOf(operationalLaunchArgs("claude-code", { teamPermissionDefault: true, managedCompaction: false, claudePermissions: selected }));
    const settings = await continueTeam({ permissions: composed.permissions, hooks: { PreToolUse: [...composed.hooks.PreToolUse, otherHook] } });
    expect(teamHookEntries(settings)).toEqual(teamHookEntries(composed));
    expect(settings.hooks.PreToolUse).toEqual(expect.arrayContaining([otherHook]));
  });

  it("drops a running team hook when the seat's choice no longer uses the team default, keeping other hooks", async () => {
    const composed = settingsOf(operationalLaunchArgs("claude-code", { teamPermissionDefault: true, managedCompaction: false }));
    const settings = await continueTeam({ permissions: composed.permissions, hooks: { PreToolUse: [...composed.hooks.PreToolUse, otherHook] } }, false);
    expect(teamHookEntries(settings)).toHaveLength(0);
    expect(settings.permissions.allow).not.toEqual(expect.arrayContaining(TEAM_CLAUDE_ALLOW));
    expect(settings.hooks.PreToolUse).toEqual([otherHook]);
  });

  it("replaces only OpenRig's hook inside a shared entry, keeping its sibling hook and the entry's other fields (review R2-F1)", async () => {
    const settings = await continueTeam({ permissions: { allow: ["Bash(stale *)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", note: "mine", hooks: [oldOwn, sibling] }] } });
    expect(settings.hooks.PreToolUse).toEqual(expect.arrayContaining([{ matcher: "Bash", note: "mine", hooks: [sibling] }]));
    expect(teamHookEntries(settings)).toHaveLength(1);
    expect(teamHookEntries(settings)[0].command).not.toBe(oldOwn.command);
  });

  it("replaces an older install's hook written with other quoting, once", async () => {
    const settings = await continueTeam({ permissions: { allow: ["Bash(stale *)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [oldOwn] }, otherHook] } });
    expect(allPreToolUseHooks(settings).filter((hook: any) => hook.command === oldOwn.command)).toHaveLength(0);
    expect(teamHookEntries(settings)).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toEqual(expect.arrayContaining([otherHook]));
  });

  it.each([
    ["a longer file name", "node '/custom/claude-team-permissions.cjs.audit'"],
    ["a command that only names the file", "/usr/local/bin/my-project-check --label claude-team-permissions.cjs"],
    ["another program run on the file", "/usr/bin/cat '/x/claude-team-permissions.cjs' team"],
  ])("keeps an unrelated hook with %s (review R2-F1)", async (_label, command) => {
    const unrelated = { type: "command", command, timeout: 8 };
    const settings = await continueTeam({ permissions: { allow: ["Bash(stale *)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [unrelated] }] } });
    expect(allPreToolUseHooks(settings)).toEqual(expect.arrayContaining([unrelated]));
    expect(teamHookEntries(settings)).toHaveLength(1);
  });

  it("leaving the team default removes only OpenRig's hook from a shared entry", async () => {
    const settings = await continueTeam({ permissions: { allow: ["Bash(stale *)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [oldOwn, sibling] }] } }, false);
    expect(teamHookEntries(settings)).toHaveLength(0);
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [sibling] }]);
  });

  it("replaces a hook launched before #2640 with its policy encoded, keeping a sibling (review R3-F1)", async () => {
    const legacy = legacyHook([...TEAM_CLAUDE_ALLOW], [...TEAM_CLAUDE_ASK]);
    const settings = await continueTeam({ permissions: { allow: ["Bash(stale *)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [legacy, sibling] }] } });
    expect(allPreToolUseHooks(settings).filter((hook: any) => hook.command === legacy.command)).toHaveLength(0);
    expect(teamHookEntries(settings)).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toEqual(expect.arrayContaining([{ matcher: "Bash", hooks: [sibling] }]));
  });

  it("removes a pre-#2640 kernel hook when the seat no longer uses that default (review R3-F1)", async () => {
    const legacy = legacyHook([...KERNEL_CLAUDE_ALLOW], []);
    const settings = await continueTeam({ permissions: { allow: ["Bash(stale *)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [legacy, sibling] }] } }, false);
    expect(teamHookEntries(settings)).toHaveLength(0);
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [sibling] }]);
  });

  it.each([
    ["base64 that isn't a launch policy", Buffer.from(JSON.stringify({ foo: [] })).toString("base64")],
    ["a policy with another key", Buffer.from(JSON.stringify({ allow: [], ask: [], deny: [] })).toString("base64")],
    ["a word that isn't a kind", "team2"],
  ])("keeps a hook whose third word is %s", async (_label, word) => {
    const unrelated = { type: "command", timeout: 5, command: ["node", "/x/claude-team-permissions.cjs", word].map(shellQuote).join(" ") };
    const settings = await continueTeam({ permissions: { allow: ["Bash(stale *)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [unrelated] }] } });
    expect(allPreToolUseHooks(settings)).toEqual(expect.arrayContaining([unrelated]));
  });

  it("the sent-policy check fails when an old OpenRig hook would still be sent", () => {
    const composed = operationalLaunchArgs("claude-code", { teamPermissionDefault: true, managedCompaction: false, claudePermissions: selected });
    const policy = composedSeatPermissionPolicy(composed)!;
    const settings = settingsOf(composed);
    expect(sendsSeatPermissionPolicy(composed, policy)).toBe(true);
    const withOld = ["--settings", JSON.stringify({ ...settings, hooks: { PreToolUse: [...settings.hooks.PreToolUse, { matcher: "Bash", hooks: [legacyHook([...TEAM_CLAUDE_ALLOW], [...TEAM_CLAUDE_ASK])] }] } })];
    expect(sendsSeatPermissionPolicy(withOld, policy)).toBe(false);
  });

  it("the pod-aware continuation adds the team hook too", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ask-")); dirs.push(stateDir);
    const tmux = resumeTmux();
    const fsOps = { readFile: () => { throw new Error("none"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {}, listFiles: () => [] } as unknown as ClaudeAdapterFsOps;
    await new ClaudeCodeAdapter({ tmux, fsOps, stateDir, sleep: async () => {} }).launchHarness({ id: "b1", nodeId: "n1", tmuxSession: "seat", tmuxWindow: null, tmuxPane: null,
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", teamPermissionDefault: true, claudePermissions: selected, claudeExecutable: "/native/claude",
      claudeLaunch: { args: ["--settings", JSON.stringify({ permissions: { allow: ["Bash(stale *)"] } })], warnings: [] } }, { name: "seat", resumeToken: "same" });
    const settings = inlineSettings(vi.mocked(tmux.sendText).mock.calls[0]![1]);
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(TEAM_CLAUDE_ALLOW));
    expect(teamHookEntries(settings)).toHaveLength(1);
  });
});

describe("the pod-aware launch composes the stored asks on fresh, resume, fork and continuation", () => {
  const fsOps = (): ClaudeAdapterFsOps => ({ readFile: () => { throw new Error("none"); }, writeFile: () => {}, exists: () => false,
    mkdirp: () => {}, copyFile: () => {}, listFiles: () => [] } as unknown as ClaudeAdapterFsOps);
  const binding = (extra: Partial<NodeBinding> = {}): NodeBinding => ({ id: "b1", nodeId: "n1", tmuxSession: "seat", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", claudePermissions: selected, ...extra });
  const launch = async (extra: Partial<NodeBinding>, opts: Record<string, unknown>) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ask-")); dirs.push(stateDir);
    const tmux = resumeTmux();
    const result = await new ClaudeCodeAdapter({ tmux, fsOps: fsOps(), stateDir, sleep: async () => {} }).launchHarness(binding(extra), { name: "seat", ...opts } as never);
    return { result, command: vi.mocked(tmux.sendText).mock.calls[0]![1] };
  };

  it.each([["fresh", {}], ["resume", { resumeToken: "same" }], ["fork", { forkSource: { kind: "native_id", value: "parent" } }]] as const)("%s", async (_kind, opts) => {
    const { result, command } = await launch({}, opts);
    expect(result).toMatchObject({ ok: true });
    expect(inlineSettings(command).permissions).toMatchObject({ ask: selected.ask, deny: selected.deny });
  });

  it("a continuation from captured arguments sends the stored selection, not the running rule lists", async () => {
    const running = { permissions: { allow: ["Bash(stale *)"], additionalDirectories: ["/selected/docs"] }, custom: "kept" };
    const { result, command } = await launch({ claudeExecutable: "/native/claude", claudeLaunch: { args: ["--settings", JSON.stringify(running)], warnings: [] } },
      { resumeToken: "same" });
    expect(result).toMatchObject({ ok: true });
    const settings = inlineSettings(command);
    expect(settings.permissions).toMatchObject({ ask: selected.ask, deny: selected.deny });
    expect(settings.permissions.allow).not.toContain("Bash(stale *)");
    expect(settings.permissions.additionalDirectories).toEqual(["/selected/docs"]);
    expect(settings.custom).toBe("kept");
    expect(command).toContain("'--resume' 'same'");
  });
});
