import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { createFullTestDb } from "./helpers/test-app.js";

// Harmless terminal model: choices ignore bracketed paste, typed digits choose
// immediately, and Enter chooses the focused first option. A second prompt
// appears immediately after a choice. This is a transport control, not a native
// Claude/Codex UI or version claim. The actual adapter, transport and audit run.
describe("explicit prompt answer delivery", () => {
  let db: ReturnType<typeof createFullTestDb>;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  function fixture(mode: "choice" | "text" | "ordinary" = "choice", marker = "❯") {
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const rig = rigRepo.createRig("answer-test");
    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
    const name = "worker@answer-test";
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name });
    const eventBus = new EventBus(db);
    const activity = new AgentActivityStore({ db, eventBus });
    if (mode !== "ordinary") activity.recordHookEvent({ runtime: "claude-code", sessionName: name,
      hookEvent: "Notification", subtype: "permission_prompt" });
    const state = { selected: [] as number[], submitted: [] as string[], input: "", stored: "",
      received: [] as string[], commands: [] as string[][], capture: undefined as string | null | undefined };
    const tmux = new TmuxAdapter(async () => { throw new Error("argv executor expected"); }, {
      tmpName: () => "/tmp/answer-fixture", bufferName: () => "answer-fixture",
      writeFile: async (_path, text) => { state.stored = text; }, unlink: async () => {},
    }, async argv => {
      state.commands.push(argv);
      if (argv[1] === "paste-buffer") {
        state.received.push(state.stored);
        if (mode === "choice") {
          if (!argv.includes("-p")) state.selected.push(Number(state.stored));
        } else state.input += state.stored;
      }
      if (argv[1] === "send-keys" && argv.includes("Enter")) {
        if (mode === "choice") state.selected.push(1);
        else { state.submitted.push(state.input); state.input = ""; }
      }
      return "";
    });
    tmux.getPaneCommand = async () => null;
    tmux.getPanePid = async () => null;
    tmux.capturePaneContent = async () => state.capture !== undefined ? state.capture
      : mode === "choice" ? `Choose a harmless colour (${state.selected.length + 1})\n${marker} 1. Blue\n  2. Green\n  3. No`
      : `Text answer\n${marker} ${state.input}\n────────────────────\nenter to submit`;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry: registry, eventBus,
      agentActivityStore: activity, tmuxAdapter: tmux, sleep: async () => {} });
    return { name, state, tmux, transport, eventBus };
  }

  it("delivers the intended choice instead of the focused choice, with no Enter into the next prompt", async () => {
    const f = fixture();
    const result = await f.transport.send(f.name, "3", { dangerouslyInteract: true, reason: "choose No in the harmless control" });
    expect(result.ok).toBe(true);
    expect(f.state.selected).toEqual([3]); // Base selects [1]; an extra Enter produces [3, 1].
    expect(f.state.commands.filter(a => a[1] === "send-keys")).toEqual([]);
    expect(result).toMatchObject({ verified: false, outcome: "rendered-unconfirmed" });
    expect(result.warning).toContain("submission unverified");
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type = 'transport.prompt_override'").get()).toEqual({ n: 1 });
  });

  it.each(["❯", "›"])("submits a complete still-staged text answer at %s", async marker => {
    const f = fixture("text", marker);
    const result = await f.transport.send(f.name, "green please", { dangerouslyInteract: true, reason: "answer the text field" });
    expect(result.ok).toBe(true);
    expect(f.state.submitted).toEqual(["green please"]);
    expect(f.state.commands.find(a => a[1] === "paste-buffer")).not.toContain("-p");
    expect(f.state.commands.filter(a => a[1] === "send-keys")).toEqual([["tmux", "send-keys", "-t", f.name, "Enter"]]);
  });

  it.each([null, "Working...", "❯ green\n────────────────────\nenter to submit",
    "❯ green please but not this\n────────────────────\nenter to submit"])("does not guess submission from unavailable, consumed or partial input (%#)", async capture => {
    const f = fixture("text"); f.state.capture = capture;
    const result = await f.transport.send(f.name, "green please", { dangerouslyInteract: true, reason: "answer the text field" });
    expect(result).toMatchObject({ ok: true, sent: true, verified: false, outcome: "rendered-unconfirmed" });
    expect(f.state.received).toEqual(["green please"]);
    expect(f.state.submitted).toEqual([]);
    expect(f.state.commands.some(a => a[1] === "send-keys")).toBe(false);
  });

  it.each([";", "answer;", "answer\\;", "--", "Enter", "é🙂", "x".repeat(163840)])("preserves answer bytes outside argv and tmux command parsing (%#)", async answer => {
    const f = fixture("text");
    await f.transport.send(f.name, answer, { dangerouslyInteract: true, reason: "exact answer bytes" });
    expect(f.state.received).toEqual([answer]);
    expect(f.state.submitted).toEqual([answer]);
    expect(f.state.commands.find(a => a[1] === "paste-buffer")).toEqual([
      "tmux", "paste-buffer", "-t", f.name, "-b", "answer-fixture", "-d", "-r",
    ]);
    expect(f.state.commands.filter(a => a[1] !== "send-keys").every(a => !a.includes(answer))).toBe(true);
  });

  it("reports a failed post-input capture as unverified without a trailing Enter", async () => {
    const f = fixture("text");
    f.tmux.capturePaneContent = async () => { throw new Error("capture unavailable"); };
    const result = await f.transport.send(f.name, "green", { dangerouslyInteract: true, reason: "answer the text field" });
    expect(result).toMatchObject({ ok: true, sent: true, verified: false, outcome: "rendered-unconfirmed" });
    expect(f.state.received).toEqual(["green"]);
    expect(f.state.commands.some(a => a[1] === "send-keys")).toBe(false);
  });

  it.each([undefined, { dangerouslyInteract: true, reason: "no prompt to override" }])("keeps ordinary bracketed delivery and its Enter unchanged (%#)", async opts => {
    const f = fixture("ordinary");
    const result = await f.transport.send(f.name, "ordinary message", opts);
    expect(result.ok).toBe(true);
    expect(f.state.submitted).toEqual(["ordinary message"]);
    expect(f.state.commands.find(a => a[1] === "paste-buffer")).toContain("-p");
    expect(f.state.commands.filter(a => a[1] === "send-keys")).toEqual([["tmux", "send-keys", "-t", f.name, "Enter"]]);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type = 'transport.prompt_override'").get()).toEqual({ n: 0 });
  });
});
