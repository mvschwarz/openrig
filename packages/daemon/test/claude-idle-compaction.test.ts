// While OpenRig's managed compaction acts on Claude seats, every Claude launch it makes turns Claude's own idle
// compaction off inside the session's one --settings value: fresh launch, fork, resume and restore, for ordinary,
// kernel, team-default and full-bypass seats. Off (or an out-of-contract threshold, which the enforcer treats as off)
// leaves the command as it was. Through the real command builders with an inert transport: nothing is executed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { managedCompactionActive, operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { claudeCommandSessionToken } from "../src/domain/native-process-lineage.js";
import { SettingsStore, type ClaudeCompactionPolicy } from "../src/domain/user-settings/settings-store.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const POLICY: ClaudeCompactionPolicy = {
  enabled: true, thresholdPercent: 80, preCompactInstruction: "", compactInstruction: "", messageInline: "",
  messageFilePath: "", postRestoreAuditInstruction: "",
};
/** The real resolver path, answered without a config file. */
function policy(over: Partial<ClaudeCompactionPolicy> | "off"): void {
  vi.spyOn(SettingsStore.prototype, "resolveClaudeCompactionPolicy").mockReturnValue(over === "off" ? { ...POLICY, enabled: false } : { ...POLICY, ...over });
}

type Kind = "ordinary" | "kernel" | "team" | "full-bypass";
const KINDS: Kind[] = ["ordinary", "kernel", "team", "full-bypass"];
function binding(kind: Kind): NodeBinding {
  return {
    id: "binding", nodeId: "node", cwd: "/inert/seat", tmuxSession: "seat@rig", launchPosture: kind === "full-bypass" ? "full_bypass" : "floor",
    ...(kind === "kernel" ? { kernelAuthority: true } : {}), ...(kind === "team" ? { teamPermissionDefault: true } : {}),
    ...(kind === "full-bypass" ? { nonInterruptive: true } : {}),
  } as NodeBinding;
}

function inert() {
  const send = vi.fn(async () => ({ ok: false as const, message: "inert transport: no native execution" }));
  const tmux = { sendShellCommand: send, sendText: send } as unknown as TmuxAdapter;
  const fsOps = { readFile: () => { throw new Error("missing"); }, exists: () => false,
    writeFile: vi.fn(() => { throw new Error("unexpected settings write"); }), mkdirp: vi.fn(), copyFile: vi.fn() };
  return { send, tmux, fsOps };
}

type Path = "fresh" | "fork" | "resume" | "restore";
const PATHS: Path[] = ["fresh", "fork", "resume", "restore"];
/** The composed command each path sends to the pane. */
async function command(path: Path, kind: Kind): Promise<string> {
  vi.stubEnv("OPENRIG_YOLO", kind === "full-bypass" ? "1" : "0");
  const t = inert();
  const b = binding(kind);
  if (path === "restore") {
    await new ClaudeResumeAdapter(t.tmux).resume("seat@rig", "claude_id", "original", b.cwd, b.launchPosture as "floor" | "full_bypass",
      null, undefined, b.nodeId, null, b.nonInterruptive, b.kernelAuthority, b.teamPermissionDefault);
  } else {
    await new ClaudeCodeAdapter({ ...t, sessionIdFactory: () => "fixed-session-id" }).launchHarness(b, { name: "seat", ...(path === "resume" ? { resumeToken: "original" } : {}),
      ...(path === "fork" ? { forkSource: { kind: "native_id" as const, value: "original" } } : {}) });
  }
  expect(t.fsOps.writeFile).not.toHaveBeenCalled();
  return t.send.mock.calls[0]![1] as string;
}

/** Every --settings value in a shell command line (the flag and value as shellQuote writes them). */
function settingsValues(cmd: string): string[] {
  // shellQuote writes a quote inside a value as '"'"'.
  return [...cmd.matchAll(/ '?--settings'? ('(?:[^']|'"'"')*'|\S+)/g)].map((m) => {
    const raw = m[1]!;
    return raw.startsWith("'") ? raw.slice(1, -1).replace(/'"'"'/g, "'") : raw;
  });
}

describe("managed compaction turns Claude's idle compaction off in the one --settings value", () => {
  for (const path of PATHS) for (const kind of KINDS) {
    it(`${path}, ${kind} seat: on adds idleCompaction:false to its one settings value; off leaves the command as it was`, async () => {
      policy("off");
      const off = await command(path, kind);
      vi.restoreAllMocks();
      policy({});
      const on = await command(path, kind);

      const onSettings = settingsValues(on);
      expect(onSettings).toHaveLength(1);
      const parsed = JSON.parse(onSettings[0]!) as Record<string, unknown>;
      expect(parsed.idleCompaction).toBe(false);
      // Every other key is the off command's own, unchanged (permissions, hooks, skipDangerousModePermissionPrompt).
      const offSettings = settingsValues(off);
      expect(offSettings.length).toBeLessThanOrEqual(1);
      const { idleCompaction: _, ...rest } = parsed;
      expect(rest).toEqual(offSettings[0] ? JSON.parse(offSettings[0]) : {});
      // The rest of the command is byte-identical: only the one settings value differs, or is added.
      const flag = (value: string) => ` ${shellQuote("--settings")} ${shellQuote(value)}`;
      if (offSettings[0]) expect(on).toBe(off.replace(flag(offSettings[0]), flag(onSettings[0]!)));
      else expect(on.replace(flag(onSettings[0]!), "")).toBe(off);
      expect(off).not.toContain("idleCompaction");
    });
  }

  it.each([0, 101, Number.NaN, 2.5])("an enabled policy with an out-of-contract threshold (%s) leaves every command as off", async (thresholdPercent) => {
    for (const path of PATHS) for (const kind of KINDS) {
      policy("off");
      const off = await command(path, kind);
      vi.restoreAllMocks();
      policy({ thresholdPercent });
      expect(await command(path, kind)).toBe(off);
      vi.restoreAllMocks();
    }
  });

  it("the argv form (managed launches) carries the same single merged value, beside an explicit native mode", () => {
    for (const choice of [{}, { kernelAuthority: true }, { teamPermissionDefault: true }, { nonInterruptive: true, launchPosture: "full_bypass" as const },
      { nonInterruptive: true, launchPosture: "full_bypass" as const, permissionMode: "bypassPermissions" }, { permissionMode: "plan" }]) {
      const off = operationalLaunchArgs("claude-code", { ...choice, managedCompaction: false });
      const on = operationalLaunchArgs("claude-code", { ...choice, managedCompaction: true });
      expect(on.filter((a) => a === "--settings")).toHaveLength(1);
      const at = on.indexOf("--settings");
      const { idleCompaction, ...rest } = JSON.parse(on[at + 1]!) as Record<string, unknown>;
      expect(idleCompaction).toBe(false);
      const offAt = off.indexOf("--settings");
      expect(rest).toEqual(offAt === -1 ? {} : JSON.parse(off[offAt + 1]!));
      expect([...on.slice(0, at), ...on.slice(at + 2)]).toEqual(offAt === -1 ? off : [...off.slice(0, offAt), ...off.slice(offAt + 2)]);
    }
    // Other runtimes are untouched whatever the policy.
    for (const runtime of ["codex", "pi", "terminal"]) {
      expect(operationalLaunchArgs(runtime, { managedCompaction: true })).toEqual(operationalLaunchArgs(runtime, { managedCompaction: false }));
    }
  });

  it("native identity still reads the session from a Claude command line carrying the merged settings", () => {
    for (const choice of [{}, { nonInterruptive: true, launchPosture: "full_bypass" as const }, { kernelAuthority: true }, { teamPermissionDefault: true }]) {
      for (const managedCompaction of [false, true]) {
        const argv = ["--permission-mode", "acceptEdits", ...operationalLaunchArgs("claude-code", { ...choice, managedCompaction }), "--session-id", "native-id"];
        // As `ps` prints it, with the settings value quoted where it holds spaces (the kernel and team hook command).
        const line = ["claude", ...argv.map((a) => (a.includes(" ") ? `'${a}'` : a))].join(" ");
        expect(claudeCommandSessionToken(line)).toBe("native-id");
        expect(claudeCommandSessionToken(`${line} --fork-session --resume parent`)).toBe("native-id");
      }
    }
  });

  it("the policy is read through the existing resolver and the enforcer's own threshold rule", () => {
    const store = (p: Partial<ClaudeCompactionPolicy>) => ({ resolveClaudeCompactionPolicy: () => ({ ...POLICY, ...p }) });
    expect(managedCompactionActive(store({}))).toBe(true);
    expect(managedCompactionActive(store({ enabled: false }))).toBe(false);
    for (const t of [0, 101, Number.NaN, 2.5]) expect(managedCompactionActive(store({ thresholdPercent: t }))).toBe(false);
    expect(managedCompactionActive({ resolveClaudeCompactionPolicy: () => { throw new Error("unreadable config"); } })).toBe(false);
  });
});
