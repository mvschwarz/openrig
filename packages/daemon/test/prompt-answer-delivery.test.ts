import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { sendCommand, type SendDeps } from "../../cli/src/commands/send.js";
import type { DaemonClient } from "../../cli/src/client.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, type SendOpts } from "../src/domain/session-transport.js";
import { createFullTestDb } from "./helpers/test-app.js";

// Harmless terminal model: choices ignore bracketed paste, typed digits choose
// immediately, and Enter chooses the focused first option. A second prompt
// appears immediately after a choice. This is a transport control, not a native
// Claude/Codex UI or version claim. The actual adapter, transport and audit run.
describe("explicit prompt answer delivery", () => {
  let db: ReturnType<typeof createFullTestDb>;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  function fixture(mode: "choice" | "text" | "ordinary" | "overview" = "choice", runtime: "claude-code" | "codex" = "claude-code", withBus = true) {
    const marker = runtime === "codex" ? "›" : "❯";
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const rig = rigRepo.createRig("answer-test");
    const node = rigRepo.addNode(rig.id, "worker", { runtime });
    const name = "worker@answer-test";
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name });
    const eventBus = new EventBus(db);
    const activity = new AgentActivityStore({ db, eventBus });
    if (mode === "choice" || mode === "text") activity.recordHookEvent({ runtime, sessionName: name,
      hookEvent: "PermissionRequest", subtype: "Bash" });
    const state = { selected: [] as number[], submitted: [] as string[], input: "", stored: "",
      received: [] as string[], effects: [] as string[], commands: [] as string[][], capture: undefined as string | null | undefined };
    const tmux = new TmuxAdapter(async () => { throw new Error("argv executor expected"); }, {
      tmpName: () => "/tmp/answer-fixture", bufferName: () => "answer-fixture",
      writeFile: async (_path, text) => { state.stored = text; }, unlink: async () => {},
    }, async argv => {
      state.commands.push(argv);
      if (argv[1] === "paste-buffer") {
        state.received.push(state.stored);
        if (mode === "choice" || mode === "overview") {
          if (!argv.includes("-p")) {
            if (state.stored === "\r") { state.selected.push(1); state.effects.push("choose-focused"); }
            else if (state.stored === "\x1b") state.effects.push("close");
            else if (state.stored === "\t") state.effects.push("focus-next");
            else if (state.stored === " ") state.effects.push("toggle");
            else if (mode === "overview" && state.stored === "t") state.effects.push("shortcut:t");
            else state.selected.push(Number(state.stored));
          }
        } else state.input += state.stored;
      }
      if (argv[1] === "send-keys" && argv.includes("Enter")) {
        if (mode === "choice" || mode === "overview") state.selected.push(1);
        else { state.submitted.push(state.input); state.input = ""; }
      }
      return "";
    });
    tmux.getPaneCommand = async () => null;
    tmux.getPanePid = async () => null;
    tmux.capturePaneContent = async () => state.capture !== undefined ? state.capture
      : mode === "overview" ? ["Hooks", "4 hooks need review", "SessionStart 3/1/2", "UserPromptSubmit 2/1/1",
        "❯ Stop 2/1/1", "t trust all · enter review · esc close"].join("\n")
      : mode === "choice" ? `Choose a harmless colour (${state.selected.length + 1})\n${marker} 1. Blue\n  2. Green\n  3. No`
      // Composer/footer shapes from retained idle captures; answers are inserted
      // synthetically. This proves parsing, not native typed-answer consumption.
      : runtime === "codex" ? `› ${state.input}\n\n  test-model · ~/example`
      : `────────────────────\n❯\u00a0${state.input}\n────────────────────\n\n  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents`;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry: registry, ...(withBus ? { eventBus } : {}),
      agentActivityStore: activity, tmuxAdapter: tmux, sleep: async () => {} });
    return { name, state, tmux, transport, eventBus, activity };
  }

  it("delivers the intended choice instead of the focused choice, with no Enter into the next prompt", async () => {
    const f = fixture();
    const result = await f.transport.send(f.name, "3", { dangerouslyInteract: true, reason: "choose No in the harmless control" });
    expect(result.ok).toBe(true);
    expect(f.state.selected).toEqual([3]); // Base selects [1]; an extra Enter produces [3, 1].
    expect(f.state.commands.filter(a => a[1] === "send-keys")).toEqual([]);
    expect(result).toMatchObject({ verified: false, outcome: "rendered-unconfirmed" });
    expect(result.promptInteraction).toBe("unverified");
    expect(result.warning).toContain("submission unverified");
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type = 'transport.prompt_override'").get()).toEqual({ n: 1 });
  });

  it.each(["claude-code", "codex"] as const)("uses a pending permission to deliver an explicit still-staged text answer for %s", async runtime => {
    const f = fixture("text", runtime);
    if (runtime === "codex") {
      expect(f.activity.getLatestForNode({ sessionName: f.name })).toMatchObject({ state: "unknown", reason: "permission_request_pending" });
    }
    const result = await f.transport.send(f.name, "green please", { dangerouslyInteract: true, reason: "answer the text field" });
    expect(result.ok).toBe(true);
    expect(f.state.submitted).toEqual(["green please"]);
    expect(result.promptInteraction).toBe("enter-sent");
    expect(f.state.commands.find(a => a[1] === "paste-buffer")).not.toContain("-p");
    expect(f.state.commands.filter(a => a[1] === "send-keys")).toEqual([["tmux", "send-keys", "-t", f.name, "Enter"]]);
  });

  it("presses Enter for a Codex `»` prompt holding exactly the answer", async () => {
    const f = fixture("text", "codex");
    // Codex 0.153 draws `»`; the shared runtime-scoped set has to recognize it.
    f.state.capture = "» green please\n\n  test-model · ~/example";
    const result = await f.transport.send(f.name, "green please", { dangerouslyInteract: true, reason: "Codex 0.153 prompt glyph" });
    expect(result.ok).toBe(true);
    expect(result.promptInteraction).toBe("enter-sent");
    expect(f.state.submitted).toEqual(["green please"]);
    expect(f.state.commands.filter(a => a[1] === "send-keys")).toEqual([["tmux", "send-keys", "-t", f.name, "Enter"]]);
  });

  it.each([".", ")"]) ("withholds Enter for a Codex `»` numbered choice (%s)", async separator => {
    const f = fixture("choice", "codex");
    // The choice body equals the answer, so only the numbered-choice exclusion
    // stops the shared matcher from treating the menu selection as typed text.
    f.state.capture = `Choose a harmless colour\n» 1${separator} Blue\n  2${separator} Green\n  3${separator} No`;
    const result = await f.transport.send(f.name, "1. Blue", { dangerouslyInteract: true, reason: "Codex 0.153 numbered choice" });
    expect(result).toMatchObject({ ok: true, sent: true, verified: false, outcome: "rendered-unconfirmed" });
    expect(result.promptInteraction).toBe("unverified");
    expect(f.state.commands.some(a => a[1] === "send-keys")).toBe(false);
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

  it("keeps ordinary bracketed delivery and its Enter unchanged", async () => {
    const f = fixture("ordinary");
    const result = await f.transport.send(f.name, "ordinary message");
    expect(result.ok).toBe(true);
    expect(f.state.submitted).toEqual(["ordinary message"]);
    expect(result.promptInteraction).toBeUndefined();
    expect(f.state.commands.find(a => a[1] === "paste-buffer")).toContain("-p");
    expect(f.state.commands.filter(a => a[1] === "send-keys")).toEqual([["tmux", "send-keys", "-t", f.name, "Enter"]]);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type = 'transport.prompt_override'").get()).toEqual({ n: 0 });
  });

  // Actual Commander -> injected HTTP seam -> real transport/adapter/audit.
  // Next-menu and unknown-border controls exercise the real CLI dispatch path.
  async function viaCli(f: ReturnType<typeof fixture>, answer: string, fanout: boolean, options: { json?: boolean; omitDisposition?: boolean; override?: boolean } = {}) {
    const { json = true, omitDisposition = false, override = true } = options;
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const logs: string[] = [];
    const previousExit = process.exitCode;
    process.exitCode = undefined;
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
    vi.stubEnv("OPENRIG_SESSION_NAME", "operator@answer-test");
    const client = { baseUrl: "http://127.0.0.1:1", post: async (path: string, body: Record<string, unknown>) => {
      calls.push({ path, body });
      if (path.endsWith("/capture")) return { status: 200, data: { content: await f.tmux.capturePaneContent(f.name) } };
      if (path.endsWith("/broadcast")) {
        const data = await f.transport.broadcast({ sessions: [f.name] }, String(body.text), body as SendOpts);
        if (omitDisposition) for (const result of data.results) delete result.promptInteraction;
        return { status: 200, data };
      }
      if (path.endsWith("/send")) {
        const data = await f.transport.send(f.name, String(body.text ?? ""), body as SendOpts);
        if (omitDisposition) delete data.promptInteraction;
        return { status: data.ok ? 200 : 409, data };
      }
      throw new Error(`Unexpected request ${path}`);
    } };
    const deps = { clientFactory: () => client as unknown as DaemonClient, hostRegistryLoader: () => ({ hosts: {} }),
      lifecycleDeps: { fetch: async () => ({ ok: true, json: async () => ({ selfHostId: "test-host" }) }),
        readFile: () => null, exists: () => false, isProcessAlive: () => false,
        spawn: () => { throw new Error("No lifecycle allowed"); }, kill: () => { throw new Error("No lifecycle allowed"); } },
    } as unknown as SendDeps;
    const log = vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
    const error = vi.spyOn(console, "error").mockImplementation((...args) => { logs.push(args.join(" ")); });
    try {
      await new Command().addCommand(sendCommand(deps)).parseAsync(["node", "rig", "send",
        ...(fanout ? ["--to", f.name] : [f.name]), answer,
        ...(override ? ["--dangerously-interact", "--reason", "harmless answer control"] : ["--raw"]), "--verify", ...(json ? ["--json"] : [])]);
      return { calls, logs, exit: process.exitCode ?? 0 };
    } finally {
      log.mockRestore(); error.mockRestore(); vi.unstubAllEnvs(); process.exitCode = previousExit;
    }
  }

  describe.each([false, true])("CLI verify (fanout=%s)", fanout => {
    it.each([".", ")"])("round1: does not press Enter in the next %s menu or claim failure", async separator => {
      const f = fixture();
      f.state.capture = `Choose a harmless colour\n❯ 1${separator} Blue\n  2${separator} Green\n  3${separator} No`;
      const r = await viaCli(f, "3", fanout);
      expect(f.state.selected).toEqual([3]);
      expect(f.state.received).toEqual(["3"]);
      expect(r.calls.filter(c => c.body.submitOnly)).toHaveLength(0);
      expect(r.exit).toBe(0);
      const output = JSON.parse(r.logs[0]!);
      expect(fanout ? output.results[0] : output).toMatchObject({ ok: true,
        promptInteraction: "unverified", verified: false, outcome: "rendered-unconfirmed" });
      expect(r.logs.join("\n")).not.toContain("staged-not-consumed");
    });

    it.each([true, false])("round1: unknown input stays unsubmitted, including human output (json=%s)", async json => {
      const f = fixture("text"); f.state.capture = "❯ green please\n[unrecognized footer]";
      const r = await viaCli(f, "green please", fanout, { json });
      expect(f.state.received).toEqual(["green please"]);
      expect(f.state.submitted).toEqual([]);
      expect(r.calls.filter(c => c.body.submitOnly)).toHaveLength(0);
      expect(r.exit).toBe(0);
      expect(r.logs.join("\n")).toContain("consumption unverified");
      expect(r.logs.join("\n")).not.toContain("staged, not consumed");
    });

    it.each([".", ")", "unknown-border"])("round2: own intent prevents remediation without daemon metadata (%s)", async shape => {
      const f = fixture(shape === "unknown-border" ? "text" : "choice");
      const answer = shape === "unknown-border" ? "green please" : "3";
      f.state.capture = shape === "unknown-border" ? "❯ green please\n[unrecognized footer]"
        : `Choose a harmless colour\n❯ 1${shape} Blue\n  2${shape} Green\n  3${shape} No`;
      // The response seam models an older daemon's absent field. The remote
      // source-composition control also substitutes the actual older transport.
      const r = await viaCli(f, answer, fanout, { omitDisposition: true });
      expect(f.state.selected).toEqual(shape === "unknown-border" ? [] : [3]);
      expect(f.state.submitted).toEqual([]);
      expect(r.calls.filter(c => c.body.submitOnly)).toHaveLength(0);
      expect(r.exit).toBe(0);
      expect(r.logs.join("\n")).toContain("not reported by the daemon");
      expect(r.logs.join("\n")).not.toContain("staged-not-consumed");
    });

    it("round2: explicit intent uses the staged-answer path even without a detected prompt", async () => {
      const f = fixture("ordinary"); f.state.capture = "❯ green please\n────────────────────";
      const r = await viaCli(f, "green please", fanout);
      expect(f.state.submitted).toEqual(["green please"]);
      expect(r.calls.filter(c => c.body.submitOnly)).toHaveLength(0);
      expect(r.exit).toBe(0);
      expect(r.logs.join("\n")).toContain("enter-sent");
      expect(db.prepare("SELECT count(*) AS n FROM events WHERE type = 'transport.prompt_override'").get()).toEqual({ n: 1 });
    });

    it("round2: ordinary sends retain their one guarded repair", async () => {
      const f = fixture("ordinary"); f.state.capture = "❯ green please\n────────────────────";
      const r = await viaCli(f, "green please", fanout, { override: false });
      expect(r.calls.filter(c => c.body.submitOnly)).toHaveLength(1);
      expect(f.state.submitted).toEqual(["green please", ""]);
      // This fixture deliberately holds the staged render after both Enters.
      expect(r.exit).toBe(1);
      expect(r.logs.join("\n")).toContain("staged-not-consumed");
    });

    it.each(["claude-code", "codex"] as const)("round1: submits a complete %s answer once, with no verify remediation", async runtime => {
      const f = fixture("text", runtime);
      // Hold a last-render snapshot after Enter, like a redraw lag. Verification
      // must not treat this still-visible answer as permission to press again.
      f.state.capture = runtime === "codex" ? "› green please\n\n  test-model · ~/example"
        : "❯\u00a0green please\n────────────────────\n\n  ⏵⏵ accept edits on";
      const r = await viaCli(f, "green please", fanout);
      expect(f.state.submitted).toEqual(["green please"]);
      expect(r.calls.filter(c => c.body.submitOnly)).toHaveLength(0);
      expect(r.exit).toBe(0);
      const output = JSON.parse(r.logs[0]!);
      expect((fanout ? output.results[0] : output).promptInteraction).toBe("enter-sent");
    });
  });

  it.each(["codex", "claude-code"] as const)("round1: withholds Enter for partial, extended and numbered %s input", async runtime => {
    const f = fixture("text", runtime);
    const marker = runtime === "codex" ? "›" : "❯";
    const tail = runtime === "codex" ? "\n\n  test-model · ~/example" : "\n────────────────────";
    for (const input of ["green", "green please extra", "1. green please", "1) green please"]) {
      f.state.capture = marker + " " + input + tail;
      const result = await f.transport.send(f.name, "green please", { dangerouslyInteract: true, reason: "full-equality control" });
      expect(result.promptInteraction).toBe("unverified");
    }
    expect(f.state.submitted).toEqual([]);
  });


  describe.each([false, true])("explicit byte input through Commander (fanout=%s)", fanout => {
    it.each([["\r", "choose-focused"], ["\x1b", "close"], ["\t", "focus-next"], [" ", "toggle"]])(
      "delivers control payload %# exactly once with no extra Enter", async (answer, effect) => {
        const f = fixture("overview");
        const r = await viaCli(f, answer!, fanout);
        expect(r.exit).toBe(0);
        expect(f.state.received).toEqual([answer]);
        expect(f.state.effects).toEqual([effect]);
        expect(f.state.selected).toEqual(answer === "\r" ? [1] : []);
        expect(f.state.commands.find(a => a[1] === "paste-buffer")).toEqual([
          "tmux", "paste-buffer", "-t", f.name, "-b", "answer-fixture", "-d", "-r",
        ]);
        expect(f.state.commands.some(a => a[1] === "send-keys")).toBe(false);
        expect(r.calls.some(c => c.body.submitOnly)).toBe(false);
        const audits = db.prepare("SELECT payload FROM events WHERE type = 'transport.prompt_override'").all() as Array<{ payload: string }>;
        expect(audits).toHaveLength(1);
        expect(JSON.parse(audits[0]!.payload)).toMatchObject({ actorSession: "operator@answer-test",
          overrideReason: "harmless answer control", detectedState: "unknown" });
        expect(r.logs.join("\n")).toContain("activity could not be determined");
      });
    it("still refuses zero bytes before transport", async () => {
      const f = fixture("overview");
      const r = await viaCli(f, "", fanout);
      expect(r.exit).toBe(1);
      expect(r.calls).toEqual([]);
      expect(f.state.commands).toEqual([]);
    });
  });

  it.each(["unknown", "running", "idle"] as const)("uses key semantics on %s without changing readiness", async readiness => {
    const f = fixture("overview");
    if (readiness !== "unknown") f.activity.recordHookEvent({ runtime: "claude-code", sessionName: f.name,
      hookEvent: readiness === "running" ? "UserPromptSubmit" : "Stop" });
    const result = await f.transport.send(f.name, "t", { dangerouslyInteract: true,
      reason: "harmless overview shortcut", actorSession: "operator@answer-test", verify: true });
    expect(f.state.effects).toEqual(["shortcut:t"]);
    expect(f.state.selected).toEqual([]);
    expect(result).toMatchObject({ ok: true, sent: true, verified: false, promptInteraction: "unverified" });
    expect(f.state.commands.some(a => a[1] === "send-keys")).toBe(false);
    const audits = db.prepare("SELECT payload FROM events WHERE type = 'transport.prompt_override'").all() as Array<{ payload: string }>;
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.payload)).toMatchObject({ detectedState: readiness,
      actorSession: "operator@answer-test", overrideReason: "harmless overview shortcut" });
    if (readiness === "unknown") expect(result.warning).toContain("activity could not be determined");
    if (readiness === "running") expect(result.warning).toContain("busy is advisory");
  });

  it.each(["unknown", "running", "idle"] as const)("keeps an accepted %s interaction accepted when audit is unavailable", async readiness => {
    const f = fixture("overview", "claude-code", false);
    if (readiness !== "unknown") f.activity.recordHookEvent({ runtime: "claude-code", sessionName: f.name,
      hookEvent: readiness === "running" ? "UserPromptSubmit" : "Stop" });
    const result = await f.transport.send(f.name, "t", { dangerouslyInteract: true, reason: "harmless unaudited control" });
    expect(f.state.effects).toEqual(["shortcut:t"]);
    expect(result).toMatchObject({ ok: true, sent: true, promptInteraction: "unverified" });
    expect(result.warning).toContain("audit_unconfigured");
    expect(f.state.selected).toEqual([]);
  });

  it("keeps the positive-picker audit prerequisite and ordinary picker refusal", async () => {
    const f = fixture("choice", "claude-code", false);
    expect(await f.transport.send(f.name, "3")).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(await f.transport.send(f.name, "3", { dangerouslyInteract: true, reason: "harmless choice" }))
      .toMatchObject({ ok: false, reason: "prompt_override_audit_unavailable" });
    expect(f.state.commands.filter(a => a[1] === "paste-buffer" || a[1] === "send-keys")).toEqual([]);
  });

});
