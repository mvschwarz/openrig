import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { resolveConcreteHint, type NodeBinding, type ResolvedStartupFile } from "../src/domain/runtime-adapter.js";

// A spec written the documented way, with an agent's guidance/role.md as a startup file and no delivery_hint, gets
// `auto`. A seat's own role then goes to that seat by send_text, never into the guidance file its pod-mates share,
// where each launch would overwrite the last seat's role (ADR-0006; #1840 closed the same collision for projections).

const CWD = "/project";

function world() {
  const files: Record<string, string> = {
    "/agents/impl/guidance/role.md": "# You are `impl`",
    "/agents/qa/guidance/role.md": "# You are `qa`",
  };
  const sent: Array<[string, string]> = [];
  const ok = async () => ({ ok: true as const });
  const tmux = {
    sendText: vi.fn(async (session: string, text: string) => { sent.push([session, text]); return { ok: true as const }; }),
    sendKeys: vi.fn(ok), hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "agent"),
    capturePaneContent: vi.fn(async () => ""), createSession: vi.fn(ok), killSession: vi.fn(ok),
    listSessions: vi.fn(async () => []), listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter;
  const fsOps = {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`ENOENT: ${p}`); },
    writeFile: (p: string, c: string) => { files[p] = c; },
    exists: (p: string) => p in files,
    mkdirp: () => {}, copyFile: () => {}, listFiles: () => [],
  };
  return { files, sent, tmux, fsOps };
}

const sleep = async () => {};
const runtimes: Record<string, { shared: string; adapter: (w: ReturnType<typeof world>) => { deliverStartup: ClaudeCodeAdapter["deliverStartup"] } }> = {
  "claude-code": { shared: "CLAUDE.md", adapter: (w) => new ClaudeCodeAdapter({ tmux: w.tmux, fsOps: w.fsOps, sleep }) },
  codex: { shared: "AGENTS.md", adapter: (w) => new CodexRuntimeAdapter({ tmux: w.tmux, fsOps: w.fsOps, sleep }) },
  pi: { shared: "AGENTS.md", adapter: (w) => new PiRuntimeAdapter({ tmux: w.tmux, fsOps: w.fsOps, stateRoot: "/state", runnerEntryPath: "/runner.js", sleep }) },
  stub: { shared: "AGENTS.md", adapter: (w) => new StubRuntimeAdapter({ tmux: w.tmux, fsOps: w.fsOps, sleep }) },
};

const binding = (session: string): NodeBinding =>
  ({ id: session, nodeId: session, tmuxSession: session, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: CWD });
const roleFile = (seat: string): ResolvedStartupFile => ({
  path: "guidance/role.md", absolutePath: `/agents/${seat}/guidance/role.md`, ownerRoot: `/agents/${seat}`,
  deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"],
});

describe("a seat's own role as an auto-hinted startup file", () => {
  it.each(Object.keys(runtimes))("%s: two pod-mates each get their own role by send_text, and the shared file isn't written", async (runtime) => {
    const w = world();
    const { adapter, shared } = runtimes[runtime]!;
    const seats = adapter(w);
    for (const seat of ["impl", "qa"]) {
      expect(await seats.deliverStartup([roleFile(seat)], binding(`${seat}@team`))).toMatchObject({ delivered: 1, failed: [] });
    }
    expect(w.files[`${CWD}/${shared}`]).toBeUndefined();
    expect(w.sent).toEqual([["impl@team", "# You are `impl`"], ["qa@team", "# You are `qa`"]]);
  });

  it("is send_text when marked orientation: role at any path, or at an agent's guidance/role.md; other guidance still merges", () => {
    expect(resolveConcreteHint("guidance/role.md", "# role")).toBe("send_text");
    expect(resolveConcreteHint("agents/impl/guidance/role.md", "# role")).toBe("send_text");
    expect(resolveConcreteHint("roles/lead.md", "# role", "role")).toBe("send_text");
    expect(resolveConcreteHint("roles/lead.md", "# role")).toBe("guidance_merge");
    expect(resolveConcreteHint("guidance/team.md", "# shared")).toBe("guidance_merge");
    expect(resolveConcreteHint("skills/x/SKILL.md", "# SKILL")).toBe("skill_install");
  });

  it("an explicit hint is kept as written", async () => {
    const w = world();
    const file = { ...roleFile("impl"), deliveryHint: "guidance_merge" as const };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await new CodexRuntimeAdapter({ tmux: w.tmux, fsOps: w.fsOps, sleep }).deliverStartup([file], binding("impl@team"));
    log.mockRestore();
    expect(w.files[`${CWD}/AGENTS.md`]).toContain("# You are `impl`");
    expect(w.sent).toEqual([]);
  });
});
