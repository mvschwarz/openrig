// OPR.0.7.0.13 (B): the seat mode of `rig skill loadout`. It never changes folder mode, never guesses a seat, and
// describes delivery only by the transport's evidence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillCommand } from "../src/commands/skill.js";

function makeDeps(get: { status: number; data: unknown }, post: { status: number; data: unknown } = { status: 200, data: {} }) {
  const client = { get: vi.fn(async () => get), post: vi.fn(async () => post) };
  return {
    client,
    deps: {
      lifecycleDeps: {
        spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
        readFile: vi.fn(() => JSON.stringify({ pid: 1, port: 3000, db: "t.sqlite", startedAt: new Date().toISOString() })),
        writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => true), mkdirp: vi.fn(), openForAppend: vi.fn(() => 1), isProcessAlive: vi.fn(() => true),
      },
      clientFactory: () => client,
    },
  };
}

const inspection = {
  seat: { sessionName: "dev-impl@team", runtime: "codex" }, storage: "/home/x/.openrig/state/seats/r/dev.impl/codex",
  skills: [{ id: "queue-handoff", trigger: "Use when handing work to another seat.", path: "/home/x/.openrig/state/seats/r/dev.impl/codex/skills/queue-handoff/SKILL.md" }],
  catalogDigest: "abc", occupant: "gen-1", delivery: null,
};

describe("rig skill loadout --seat", () => {
  let logs: string[];
  let errors: string[];
  let session: string | undefined;
  beforeEach(() => {
    logs = []; errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); });
    process.exitCode = undefined;
    session = process.env["OPENRIG_SESSION_NAME"];
  });
  afterEach(() => {
    if (session === undefined) delete process.env["OPENRIG_SESSION_NAME"]; else process.env["OPENRIG_SESSION_NAME"] = session;
    vi.restoreAllMocks();
  });

  it("`self` is this shell's own seat, read-only by default, listing each skill's trigger and path", async () => {
    process.env["OPENRIG_SESSION_NAME"] = "dev-impl@team";
    const { deps, client } = makeDeps({ status: 200, data: inspection });
    await skillCommand(deps).parseAsync(["node", "rig", "loadout", "--seat", "self"]);
    expect(client.get).toHaveBeenCalledWith("/api/skills/seat?session=dev-impl%40team");
    expect(client.post).not.toHaveBeenCalled();
    expect(logs).toContain("skill       queue-handoff: Use when handing work to another seat.");
    expect(logs.some((l) => l.includes("read-only"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    [{ id: "openrig-seat-router", path: "/s/skills/openrig-seat-router/SKILL.md", written: true }, { state: "unasked" },
      "router      openrig-seat-router: /s/skills/openrig-seat-router/SKILL.md", "bootstrap   off: not asked yet (skills.router_line.enabled)"],
    [{ id: "openrig-seat-router", path: "/s/r/SKILL.md", written: false, kept: "edited" }, { state: "no", by: "saved" },
      "router      openrig-seat-router: /s/r/SKILL.md (kept as it is: it differs from what OpenRig wrote)", "bootstrap   off: the person's saved no (skills.router_line.enabled)"],
    [{ id: "openrig-seat-router", path: "/s/r/SKILL.md", written: false }, { state: "yes", by: "saved" },
      "router      openrig-seat-router: /s/r/SKILL.md (not written yet)", "bootstrap   on: the person's saved yes (skills.router_line.enabled)"],
    [null, { state: "yes", by: "environment" }, null, "bootstrap   on: set by the environment, not the person's saved answer (skills.router_line.enabled)"],
  ])("OPR.0.7.0.13 (router): reports the router and the bootstrap line's recorded choice apart (%#)", async (router, bootstrapLine, routerLine, lineLine) => {
    process.env["OPENRIG_SESSION_NAME"] = "dev-impl@team";
    const { deps } = makeDeps({ status: 200, data: { ...inspection, router, bootstrapLine } });
    await skillCommand(deps).parseAsync(["node", "rig", "loadout", "--seat", "self"]);
    if (routerLine) expect(logs).toContain(routerLine);
    expect(logs).toContain(lineLine);
  });

  it("OPR.0.7.0.9: prints what the seat's launch passes of its own additions, and any copy missing or refused", async () => {
    process.env["OPENRIG_SESSION_NAME"] = "dev-impl@team";
    const launchAdditions = { agent: "openrig:reviewer", agentPromptReplacesDefault: true, appendSystemPromptFile: "/s/additions/system-prompt.md", pluginDirs: ["/s/additions/plugins/review"],
      missing: ["/s/additions/plugins/gone"], refused: ["/s/additions/x can't be read back"] };
    const { deps } = makeDeps({ status: 200, data: { ...inspection, launchAdditions } });
    await skillCommand(deps).parseAsync(["node", "rig", "loadout", "--seat", "self"]);
    expect(logs).toContain("agent       openrig:reviewer (--agent; its prompt replaces Claude's default system prompt)");
    expect(logs).toContain("prompt      /s/additions/system-prompt.md (--append-system-prompt-file)");
    expect(logs).toContain("plugin dir  /s/additions/plugins/review (CLAUDE_CODE_PLUGIN_DIRS)");
    expect(logs).toContain("missing     /s/additions/plugins/gone: not passed to the launch");
    expect(logs).toContain("refused     /s/additions/x can't be read back: not passed to the launch");
  });

  it("an older daemon's report, without the router fields, prints as before", async () => {
    process.env["OPENRIG_SESSION_NAME"] = "dev-impl@team";
    const { deps } = makeDeps({ status: 200, data: inspection });
    await skillCommand(deps).parseAsync(["node", "rig", "loadout", "--seat", "self"]);
    expect(logs.some((l) => l.startsWith("router") || l.startsWith("bootstrap") || l.startsWith("agent") || l.startsWith("prompt"))).toBe(false);
  });

  it("says plainly that a shell without a seat identity is not an OpenRig seat, and shows no one else's skills", async () => {
    delete process.env["OPENRIG_SESSION_NAME"];
    const { deps, client } = makeDeps({ status: 200, data: inspection });
    await skillCommand(deps).parseAsync(["node", "rig", "loadout", "--seat", "self"]);
    expect(client.get).not.toHaveBeenCalled();
    expect(errors[0]).toMatch(/^not an OpenRig seat: OPENRIG_SESSION_NAME isn't set/);
    expect(process.exitCode).toBe(1);
  });

  it("won't mix seat mode with the folder options, and folder mode still requires --runtime", async () => {
    process.env["OPENRIG_SESSION_NAME"] = "dev-impl@team";
    const { deps, client } = makeDeps({ status: 200, data: inspection });
    await skillCommand(deps).parseAsync(["node", "rig", "loadout", "--seat", "self", "--cwd", "/somewhere"]);
    expect(errors[0]).toContain("--seat can't be combined with --cwd");
    expect(client.get).not.toHaveBeenCalled();
    errors.length = 0; process.exitCode = undefined;
    await skillCommand(deps).parseAsync(["node", "rig", "loadout", "--cwd", "/somewhere"]);
    expect(errors[0]).toContain("required option '--runtime <runtime>' not specified");
    expect(process.exitCode).toBe(1);
  });

  it("--apply reports the disk result and the transport's evidence separately, never as the agent having read it", async () => {
    process.env["OPENRIG_SESSION_NAME"] = "dev-impl@team";
    const cases: Array<[unknown, string, number | undefined]> = [
      [{ state: "sent", record: { outcome: "rendered-unconfirmed", deliveryId: "seat-skills:gen-1:abc" } }, "rendered-unconfirmed: the text and Enter landed, but the transport couldn't re-confirm it. This is what the transport saw, not the agent reading it.", undefined],
      [{ state: "earlier-attempt-unconfirmed", record: { outcome: "retained", deliveryId: "seat-skills:gen-1:abc" } }, "an earlier attempt for this same list came back retained (seat-skills:gen-1:abc); not resent. Check the seat with: rig capture dev-impl@team", undefined],
      [{ state: "sent", record: { outcome: "failed", deliveryId: "seat-skills:gen-1:abc" }, detail: "session_missing" }, "failed: session_missing", 1],
    ];
    for (const [delivery, expected, exit] of cases) {
      logs.length = 0; process.exitCode = undefined;
      const { deps, client } = makeDeps({ status: 200, data: inspection }, { status: 200, data: { inspection, disk: { ok: true, receipts: [], removed: [], errors: [] }, delivery } });
      await skillCommand(deps).parseAsync(["node", "rig", "loadout", "--seat", "self", "--apply", "--wait-for-idle", "5000"]);
      expect(client.post).toHaveBeenCalledWith("/api/skills/seat/apply", { session: "dev-impl@team", waitForIdleMs: 5000 });
      expect(logs).toContain("on disk     reconciled");
      expect(logs.some((l) => l.includes(expected)), expected).toBe(true);
      expect(process.exitCode).toBe(exit);
    }
  });

  it("--resend asks the daemon to send again, only with --apply, and an undelivered earlier attempt says how", async () => {
    process.env["OPENRIG_SESSION_NAME"] = "dev-impl@team";
    const failed = { state: "earlier-attempt-unconfirmed", record: { outcome: "failed", deliveryId: "seat-skill-list:n:gen-1:abc:1" } };
    const { deps, client } = makeDeps({ status: 200, data: inspection }, { status: 200, data: { inspection, disk: { ok: true, selection: "reconciled", receipts: [], removed: [], errors: [] }, delivery: failed } });
    await skillCommand(deps).parseAsync(["node", "rig", "loadout", "--seat", "self", "--apply"]);
    expect(logs.some((l) => l.includes("then add --resend to send it again"))).toBe(true);
    await skillCommand(deps).parseAsync(["node", "rig", "loadout", "--seat", "self", "--apply", "--resend"]);
    expect(client.post).toHaveBeenLastCalledWith("/api/skills/seat/apply", { session: "dev-impl@team", resend: true });
    client.post.mockClear();
    await skillCommand(deps).parseAsync(["node", "rig", "loadout", "--seat", "self", "--resend"]);
    expect(errors).toContain("--resend needs --apply");
    expect(client.post).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("names an unreadable stored selection and an attempt in flight", async () => {
    process.env["OPENRIG_SESSION_NAME"] = "dev-impl@team";
    const { deps } = makeDeps({ status: 200, data: inspection }, { status: 409, data: { inspection,
      disk: { ok: false, selection: "unreadable", receipts: [], removed: [], errors: ["skill-loadout.json: Unexpected end of JSON input"] },
      delivery: { state: "not-sent", reason: "the seat's stored selection couldn't be read, so nothing was reconciled or sent" } } });
    await skillCommand(deps).parseAsync(["node", "rig", "loadout", "--seat", "self", "--apply"]);
    expect(logs).toContain("on disk     not reconciled: the stored selection couldn't be read");
    expect(process.exitCode).toBe(1);
    logs.length = 0;
    const inFlight = makeDeps({ status: 200, data: inspection }, { status: 200, data: { inspection, disk: { ok: true, selection: "reconciled", receipts: [], removed: [], errors: [] },
      delivery: { state: "attempt-in-flight", record: { outcome: "in-flight", deliveryId: "seat-skill-list:n:gen-1:abc:1" } } } });
    await skillCommand(inFlight.deps).parseAsync(["node", "rig", "loadout", "--seat", "self", "--apply"]);
    expect(logs.some((l) => l.includes("an attempt for this same list is in flight"))).toBe(true);
  });
});
