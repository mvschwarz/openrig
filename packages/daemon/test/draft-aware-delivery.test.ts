import Database from "better-sqlite3";
import { Hono } from "hono";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import nativePaste from "./fixtures/claude-paste-footer.json";
import { wrapPaneEnvelope } from "../src/lib/pane-envelope.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { EventBus } from "../src/domain/event-bus.js";
import { COALESCED_INTO, DRAFT_HELD_PER_SENDER, OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigDeliveryDrainStore } from "../src/domain/rig-delivery-drain.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { DeliveryGuardError, SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, type SendOpts } from "../src/domain/session-transport.js";
import { seatRoutes } from "../src/routes/seat.js";
import { transportRoutes } from "../src/routes/transport.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function frame(body: string): ComposerSnapshot {
  const rows = body.split("\n");
  return { screen: ["Ready", "────────────────────", `❯ ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(rows.at(-1)!), y: 1 + rows.length, width: 240, height: 60 }, inMode: false };
}

function signal() {
  let release!: () => void;
  return { ready: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

function fixture(saved?: Buffer, opts: { runtime?: string; idleHook?: boolean; appendPaste?: boolean } = {}) {
  const db = new Database(saved ?? ":memory:");
  if (!saved) {
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','${opts.runtime ?? "terminal"}'),('b','rig','sibling','terminal');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1'),('bb','b','sibling@test','%2');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running'),('sb','b','sibling@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh'),('gb','b',1,'g2','fresh');`);
  }
  const hooks: { load?: () => void | Promise<void>; paste?: () => void | Promise<void>; sleep?: (ms: number) => void | Promise<void>;
    settle?: (ms: number) => void | Promise<void>; clients?: () => string } = {};
  // The guard's own waits (its re-reads) go to `settle`, kept apart from the transport's `sleep`; none is real time.
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name), async ms => { await hooks.settle?.(ms); });
  guard.recoverActivation();
  const bodies: Record<string, string | null> = { a: "", b: "" };
  const history: Record<string, string> = { a: "", b: "" };
  const writes: string[] = [], submissions: string[] = [];
  const observations: unknown[] = [];
  let staged = "";
  // A terminal pane shows a submitted line as typed; an agent pane echoes a sent message under its prompt, as Claude does.
  const echo = (node: string, body: string) => (db.prepare("SELECT runtime FROM nodes WHERE id=?").get(node) as { runtime: string }).runtime === "terminal"
    ? `${body}\n` : `${body.split("\n").map((row, i) => (i ? "  " : "❯ ") + row).join("\n")}\n`;
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("list-clients")) return hooks.clients?.() ?? "";
    if (command.includes("load-buffer")) await hooks.load?.();
    const node = command.includes("%2") ? "b" : "a";
    if (command.includes("paste-buffer")) {
      await hooks.paste?.();
      // appendPaste: a paste lands after whatever the input already holds, as in a real composer (#3076 tests).
      writes.push(`paste:${node}:${staged}`); bodies[node] = opts.appendPaste ? (bodies[node] ?? "") + staged : staged;
    }
    if (command.includes("send-keys")) {
      writes.push(`keys:${node}:${command}`);
      if (command.includes("Enter")) {
        submissions.push(bodies[node] ?? ""); history[node] += echo(node, bodies[node] ?? ""); bodies[node] = "";
      }
    }
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/draft-input", bufferName: () => "draft-input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => [{ id: guard.target(name).pane! } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async name => {
    const body = bodies[guard.target(name).nodeId]; return body == null ? null : frame(body);
  });
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async name => {
    const node = guard.target(name).nodeId; return bodies[node] == null ? null : history[node] + frame(bodies[node]!).screen;
  });
  let at = Date.now();
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), outbox = new OutboxHandler(db);
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo, sessionRegistry, now: () => new Date(at), sleep: async ms => { await hooks.sleep?.(ms); },
    eventBus: new EventBus(db), captureObserver: { record: input => { observations.push(input); } },
    agentActivityStore: { resolveSession: () => ({ rigId: "rig", nodeId: "a", sessionName: "worker@test" }), getLatestForNode: () => opts.idleHook === false ? null
      : ({ state: "idle", reason: "fixture idle hook", evidenceSource: "runtime_hook", sampledAt: new Date(at).toISOString(), evidence: null }) } as never });
  const guarded = transport.guardedDelivery!;
  const repo = new QueueRepository(db, new EventBus(db), { transport, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(outbox);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tmuxAdapter" as never, tmux); c.set("rigRepo" as never, rigRepo);
    c.set("sessionTransport" as never, transport); c.set("outboxHandler" as never, outbox); await next();
  });
  app.route("/api/seat", seatRoutes); app.route("/api/transport", transportRoutes());
  cleanup.push(async () => { await guarded.stop(); db.close(); });
  return { db, guard, tmux, transport, observations, guarded, outbox, repo, app, bodies, history, writes, submissions, hooks,
    advance: (ms = 4000) => { at += ms; },
    enable: (settings = {}) => guard.set("a", { mode: "draft-aware", ...settings }, "human@test", "keep draft"),
    send: (id: string, text = "incoming message", opts: SendOpts = {}) => transport.send("worker@test", text, { deliveryId: id, actorSession: "human@test", verify: true, ...opts }),
    post: (path: string, body: unknown, actor = "human@test") => app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": actor }, body: JSON.stringify(body) }),
  };
}


it.each([false, true])("keeps reserved Pi compaction on its guarded typed path with native preference (held=%s)", async held => {
  const f = fixture(undefined, { runtime: "pi" });
  f.db.prepare("UPDATE nodes SET input_route='native' WHERE id='a'").run();
  if (held) await f.guard.set("a", { mode: "hold" }, "human@test", "quiet");
  const { PiCompactionService } = await import("../src/domain/pi-compaction-service.js");
  const service = new PiCompactionService({ readSidecar: () => ({ launchId: "launch" }) as never,
    newAttemptId: () => "native-preference-compact", send: (session, text, opts) => f.transport.send(session, text, opts) });
  const result = await service.trigger({ nodeId: "a", sessionName: "worker@test", runtime: "pi" });
  if (held) {
    expect(result).toMatchObject({ triggered: false, reason: "held" });
    const item = f.outbox.heldForNode("a").items[0]!;
    expect(item.body).toBe("/openrig-compact native-preference-compact");
    expect(f.outbox.inputRoute(item.outboxId)).toBe("typed");
    expect(f.submissions).toEqual([]);
  } else {
    expect(result).toMatchObject({ triggered: true, stage: "submitted_unconfirmed" });
    expect(f.submissions).toEqual(["/openrig-compact native-preference-compact"]);
  }
});

it("submit-only with native preference presses Enter only onto the existing staged text", async () => {
  const f = fixture();
  f.db.prepare("UPDATE nodes SET input_route='native' WHERE id='a'").run();
  f.bodies.a = "staged command";
  expect(await f.send("submit-native", "", { submitOnly: true, expectedStagedText: "staged command", verify: false }))
    .toMatchObject({ ok: true, submitOnly: true });
  expect(f.writes.some(write => write.startsWith("paste:"))).toBe(false);
  expect(f.submissions).toEqual(["staged command"]);
});

it("a terminal seat's exact text stays terminal input with native preference", async () => {
  const f = fixture();
  f.db.prepare("UPDATE nodes SET input_route='native' WHERE id='a'").run();
  expect(await f.send("exact-native", "enveloped input", { exactText: "printf exact", verify: false }))
    .toMatchObject({ ok: true, envelopeOmitted: true });
  expect(f.submissions).toEqual(["printf exact"]);
});

// Retained D1 geometry: empty Codex 0.164 at 65x9; after paste the editor
// shows only the envelope's reply footer and an upward scroll indicator.
function codexViewport(body: string, width: number, height: number, renderedRows?: string[]): ComposerSnapshot {
  // rust-v0.164.0 uses this character-count label, not Claude's line-count label.
  if ([...body].length > 1000) return codexViewport(`[Pasted Content ${[...body].length} chars]`, width, height);
  if (!body) return { screen: ["• DONE", "", "  Worked for 4s • 20:24", "", "",
    "› \x1b[2mAsk Codex to do anything\x1b[0m", "", "  GPT-6.1-Sol low · ~/project · Recover OpenRig identity context", "  ? for shortcuts", ""].join("\n"),
    cursor: { x: 2, y: 5, width, height }, inMode: false };
  if (height === 9 && body.includes("From:")) return {
    screen: ["", "", "› ---                                                           ↑",
      "  ↩ Reply if needed: rig queue create --destination host-",
      '  fixture-driver@external --summary "<one line>" --body "..."',
      "  --verify", "", "  GPT-6.1-Sol low · ~/project · Recover OpenRig identity context", ""].join("\n"),
    cursor: { x: 10, y: 5, width, height }, inMode: false };
  // The fullscreen composer scrolls input once padding/status/hint consume its cap.
  const capacity = Math.min(height, Math.max(8, Math.floor(height * 2 / 3))) - 4;
  const rows = (renderedRows ?? body.split("\n")).slice(-capacity);
  return { screen: ["Ready", "", `› ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "",
    "  GPT-6.1-Sol low · ~/project", "  ? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(rows.at(-1)!), y: 1 + rows.length, width, height }, inMode: false };
}

const d1Envelope = wrapPaneEnvelope("host-fixture-driver@external", "worker@test",
  "Write exactly draft-aware to /home/t1s075/project/delivery-draft-aware.txt with one shell tool; reply DONE briefly and wait.");

async function codexDelivery(mode = "draft-aware", size = { width: 65, height: 9 }) {
  const f = fixture(undefined, { runtime: "codex" });
  await f.guard.set("a", { mode }, "human@test", "D1 protected delivery");
  vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => codexViewport(f.bodies.a ?? "", size.width, size.height));
  return { ...f, size, options: { verify: false, ...(mode === "openrig-urgent" ? { urgent: { by: "human@test" } } : {}) } };
}

describe("Codex pre-paste observability through the real delivery path", () => {
  it.each(["draft-aware", "openrig-urgent"])("retains the full envelope before writing into the native 65x9 frame (%s)", async mode => {
    const f = await codexDelivery(mode);
    expect(await f.send("D1", d1Envelope, f.options)).toMatchObject({ ok: true, outcome: "retained", sent: false,
      inputPhase: "not_reached", reason: "draft_input_unknown" });
    expect(f.writes).toEqual([]);
    expect(f.submissions).toEqual([]);
    expect(f.bodies.a).toBe("");
  });

  it.each(["draft-aware", "openrig-urgent"])("submits a fitting full envelope once (%s)", async mode => {
    const f = await codexDelivery(mode, { width: 160, height: 45 });
    expect(await f.send("fits", d1Envelope, f.options)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([mode === "openrig-urgent" ? `Urgent (marked by human@test):\n${d1Envelope}` : d1Envelope]);
    expect(f.writes).toHaveLength(2);
    expect(f.bodies.a).toBe("");
  });

  it("delivers nine native-fitting 61-column lines plus their envelope at 65x45", async () => {
    const f = await codexDelivery("draft-aware", { width: 65, height: 45 });
    const text = wrapPaneEnvelope("sender@test", "worker@test", Array(9).fill("x".repeat(61)).join("\n"));
    expect(await f.send("native-fit", text, f.options)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([text]);
  });

  it("owns the complete envelope after a native 62-column hard wrap at 65x45", async () => {
    const f = await codexDelivery("draft-aware", { width: 65, height: 45 });
    const body = "x".repeat(64);
    const text = wrapPaneEnvelope("sender@test", "worker@test", body);
    expect(text.split("\n").filter(row => row.length > 62)).toEqual([body]);
    // Codex's two-column prompt and one-column right inset leave 62 cells.
    // This ASCII word wraps without dropping or replacing any authored byte.
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () =>
      codexViewport((f.bodies.a ?? "").replace(body, `${body.slice(0, 62)}\n${body.slice(62)}`), 65, 45));
    expect(await f.send("native-wrap", text, f.options)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([text]);
    expect(f.bodies.a).toBe("");
  });

  it("retains fourteen exact-width body lines before their insertion rows scroll the full envelope", async () => {
    const f = await codexDelivery("draft-aware", { width: 65, height: 45 });
    const body = "x".repeat(62);
    const text = wrapPaneEnvelope("sender@test", "worker@test", Array(14).fill(body).join("\n"));
    expect([...text].length).toBeLessThan(1000);
    const rows = text.split("\n").flatMap(row => row === body ? [row, ""] : [row]);
    expect(rows).toHaveLength(33); // Native fullscreen cap is 30 rows, including chrome.
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () =>
      codexViewport(f.bodies.a ?? "", 65, 45, f.bodies.a ? rows : undefined));
    expect(await f.send("full-width", text, f.options)).toMatchObject({ outcome: "retained", sent: false, inputPhase: "not_reached" });
    expect(f.writes).toEqual([]);
    expect(f.bodies.a).toBe("");
  });

  it("counts the insertion row of an exact-width line at the input viewport limit", async () => {
    const f = await codexDelivery("draft-aware", { width: 160, height: 45 });
    const full = "x".repeat(157);
    const text = [full, ...Array(25).fill("x")].join("\n"); // 26 logical rows, 27 visual rows.
    const rows = [full, "", ...Array(25).fill("x")];
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () =>
      codexViewport(f.bodies.a ?? "", 160, 45, f.bodies.a ? rows : undefined));
    expect(await f.send("insertion-row", text, f.options)).toMatchObject({ outcome: "retained", sent: false, inputPhase: "not_reached" });
    expect(f.writes).toEqual([]);
  });

  it("delivers a full envelope whose logical lines fit one native row at 80x22", async () => {
    const f = await codexDelivery("draft-aware", { width: 80, height: 22 });
    const text = wrapPaneEnvelope("sender@test", "worker@test", "Please review this task.", { stampISO: "2026-10-28T22:06:00Z" });
    expect(text.split("\n").every(row => stringWidth(row) < 77)).toBe(true);
    expect(await f.send("one-row-fit", text, f.options)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([text]);
  });

  it("conservatively retains a natively fitting wrapped wake when its full-line bound exceeds 80x22", async () => {
    const f = await codexDelivery("draft-aware", { width: 80, height: 22 });
    const line = "Please review the current task and reply with the smallest useful change.";
    expect(stringWidth(line)).toBe(73);
    const body = Array(3).fill(line).join(" ");
    const text = wrapPaneEnvelope("sender@test", "worker@test", body, { stampISO: "2026-10-28T21:49:00Z" });
    // Native FirstFit keeps each phrase together; the next word cannot fit on the previous row.
    const rows = text.replace(body, Array(3).fill(line).join("\n")).split("\n");
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () =>
      codexViewport(f.bodies.a ?? "", 80, 22, f.bodies.a ? rows : undefined));
    expect(rows).toHaveLength(9); // Fits natively, but the conservative bound is larger.
    expect(await f.send("ordinary-wake", text, f.options)).toMatchObject({ outcome: "retained", sent: false, inputPhase: "not_reached" });
    expect(f.writes).toEqual([]);
    expect(f.submissions).toEqual([]);
  });

  it("retains a hyphen-separated envelope before native semantic breaks scroll it at 80x24", async () => {
    const f = await codexDelivery("draft-aware", { width: 80, height: 24 });
    const body = Array(9).fill("x".repeat(40)).join("-");
    const text = wrapPaneEnvelope("sender@test", "worker@test", body, { stampISO: "2026-10-28T22:03:00Z" });
    expect(body).toHaveLength(368);
    // Native HyphenSplitter moves each 41-cell piece whole; two cannot fit in 77.
    const rows = text.replace(body, body.match(/x{40}-?/g)!.join("\n")).split("\n");
    expect(rows).toHaveLength(15);
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () =>
      codexViewport(f.bodies.a ?? "", 80, 24, f.bodies.a ? rows : undefined));
    expect(await f.send("semantic-hyphens", text, f.options)).toMatchObject({ outcome: "retained", sent: false, inputPhase: "not_reached" });
    expect(f.writes).toEqual([]);
  });

  it("retains a three-segment path envelope at the native viewport limit", async () => {
    const f = await codexDelivery("draft-aware", { width: 80, height: 22 });
    const segment = "x".repeat(38) + "/";
    const path = segment.repeat(3);
    const text = wrapPaneEnvelope("sender@test", "worker@test", path + "\n\n", { stampISO: "2026-10-28T22:03:00Z" });
    expect(path).toHaveLength(117);
    // Native UAX#14 path pieces are 39 cells; two need 78, exceeding 77.
    const rows = text.replace(path, Array(3).fill(segment).join("\n")).split("\n");
    expect(rows).toHaveLength(11);
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () =>
      codexViewport(f.bodies.a ?? "", 80, 22, f.bodies.a ? rows : undefined));
    expect(await f.send("semantic-path", text, f.options)).toMatchObject({ outcome: "retained", sent: false, inputPhase: "not_reached" });
    expect(f.writes).toEqual([]);
  });

  it("retains an envelope whose space before /path cannot be a native break", async () => {
    const f = await codexDelivery("draft-aware", { width: 80, height: 22 });
    const first = "a".repeat(30), glued = "b".repeat(46) + " /cc", last = "d".repeat(30);
    const body = `${first} ${glued} ${last}`;
    const text = wrapPaneEnvelope("sender@test", "worker@test", body + "\n\n", { stampISO: "2026-10-28T22:03:00Z" });
    // UAX#14 LB13 glues the slash to the preceding word across the space.
    const rows = text.replace(body, [first, glued, last].join("\n")).split("\n");
    expect(rows).toHaveLength(11);
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () =>
      codexViewport(f.bodies.a ?? "", 80, 22, f.bodies.a ? rows : undefined));
    expect(await f.send("semantic-glue", text, f.options)).toMatchObject({ outcome: "retained", sent: false, inputPhase: "not_reached" });
    expect(f.writes).toEqual([]);
  });

  it("retains a raw-fitting 1200-code-point envelope before Codex collapses it into an unowned label", async () => {
    const f = await codexDelivery("draft-aware", { width: 160, height: 45 });
    const empty = wrapPaneEnvelope("sender@test", "worker@test", "");
    const text = wrapPaneEnvelope("sender@test", "worker@test", "x".repeat(1200 - [...empty].length));
    expect([...text]).toHaveLength(1200);
    const result = await f.send("native-long", text, f.options);
    expect(result).toMatchObject({ outcome: "retained", sent: false, inputPhase: "not_reached" });
    expect(result.error).toContain("Send a shorter message; nothing was pasted.");
    expect(result.error).toContain("Turning this seat's typing guard off explicitly disables draft protection.");
    expect(f.writes).toEqual([]);
    expect(f.bodies.a).toBe("");
  });

  it.each(["\t", "\x1b"])("gives control-specific recovery at every size (%j)", async control => {
    const f = await codexDelivery("draft-aware", { width: 160, height: 45 });
    for (const text of [`a${control}b`, `${"x".repeat(1200)}${control}`]) {
      const result = await f.send("control", text, f.options);
      expect(result).toMatchObject({ outcome: "retained", sent: false, inputPhase: "not_reached" });
      expect(result.error).toMatch(/without them/);
      expect(result.error).not.toMatch(/larger terminal/);
    }
    expect(f.writes).toEqual([]);
  });

  it("leaves default-off delivery unchanged in the small viewport", async () => {
    const f = await codexDelivery("off");
    expect(await f.send("off", d1Envelope, f.options)).toMatchObject({ ok: true });
    expect(f.submissions).toEqual([d1Envelope]);
  });

  it("rechecks the actual viewport after buffer preparation, before any paste", async () => {
    const f = await codexDelivery("draft-aware", { width: 160, height: 45 });
    f.hooks.load = () => { f.size.width = 65; f.size.height = 9; };
    expect(await f.send("resized", d1Envelope, f.options)).toMatchObject({ outcome: "retained", sent: false, inputPhase: "not_reached" });
    expect(f.writes).toEqual([]);
  });

  it("retains a wrapped line which cannot stay visible without writing it", async () => {
    const f = await codexDelivery();
    expect(await f.send("wraps", "one-long-word-".repeat(40), f.options)).toMatchObject({ outcome: "retained", sent: false, inputPhase: "not_reached" });
    expect(f.writes).toEqual([]);
  });

  it("keeps a concurrent real draft and the human-input epoch check", async () => {
    const f = await codexDelivery("draft-aware", { width: 160, height: 45 });
    f.hooks.load = () => f.guard.humanInput("a", async () => { f.bodies.a = "my real draft"; });
    expect(await f.send("human", d1Envelope, f.options)).toMatchObject({ outcome: "retained", sent: false,
      inputPhase: "not_reached", reason: "draft_input_changed" });
    expect(f.writes).toEqual([]);
    expect(f.bodies.a).toBe("my real draft");
  });

  // D18 (Codex 0.167.1 and 0.167.2, as banked): while a turn runs, an empty box keeps the shortcuts hint, and once the
  // box holds text (our paste, or a person's draft) Codex draws its queue hint on that row instead.
  const codexBusyViewport = (body: string): ComposerSnapshot => {
    const rows = body.split("\n");
    return { screen: ["› Busy turn", "", "• Working (0s • esc to interrupt)", "",
      body ? `› ${rows[0]}` : "› \x1b[2mAsk Codex to do anything\x1b[0m", ...rows.slice(1).map(row => `  ${row}`), "",
      "  GPT-6.1-Sol low · ~/project", body ? "  tab to queue message" : "  ← for agents · ? for shortcuts", ""].join("\n"),
      cursor: { x: body ? 2 + stringWidth(rows.at(-1)!) : 2, y: 3 + rows.length, width: 80, height: 24 }, inMode: false };
  };

  it("delivers once to an empty input box of a busy Codex seat, under the queue hint its paste brings (D18)", async () => {
    const f = await codexDelivery("draft-aware", { width: 80, height: 24 });
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => codexBusyViewport(f.bodies.a ?? ""));
    expect(await f.send("busy", "next work", f.options)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual(["next work"]);
    expect(f.writes).toHaveLength(2);
    expect(f.bodies.a).toBe("");
  });

  it("holds a person's draft under the busy queue hint before any write (D18)", async () => {
    const f = await codexDelivery("draft-aware", { width: 80, height: 24 });
    f.bodies.a = "a person's draft";
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => codexBusyViewport(f.bodies.a ?? ""));
    expect(await f.send("busy-draft", "next work", f.options)).toMatchObject({ outcome: "retained", sent: false,
      inputPhase: "not_reached", reason: "draft_input_busy" });
    expect(f.writes).toEqual([]);
    expect(f.bodies.a).toBe("a person's draft");
  });
});

describe("current draft-aware delivery through the real transport", () => {
  it.each(["ordinary request ", "1. Review the change"])("attempts each ordinary authored request, even with a reused caller ID: %j", async text => {
    const f = fixture(); await f.enable();
    expect(await f.send("ordinary", text)).toMatchObject({ ok: true, sent: true });
    expect(await f.send("ordinary", text)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([text, text]);
  });

  it("submits its delayed collapsed paste once, leaving the next queue wake deliverable", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const text = "first line\nsecond line\nlast line";
    let readsAfterPaste = 0;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async name => {
      const body = f.bodies[f.guard.target(name).nodeId];
      if (body === text) return frame(readsAfterPaste++ === 0 ? "" : "[Pasted text #1 +2 lines]");
      return body == null ? null : frame(body);
    });
    expect(await f.send("delayed-label", text, { verify: false })).toMatchObject({ ok: true, sent: true });
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "next work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    await f.repo.drainPendingWakeIntents();
    expect(f.submissions).toEqual([text, expect.stringContaining(item.qitemId)]);
    expect(f.writes.filter(write => write.startsWith("paste:"))).toHaveLength(2);
    expect(f.writes.filter(write => write.startsWith("keys:"))).toHaveLength(2);
    expect(f.bodies.a).toBe("");
    expect(f.outbox.getById("wake-intent-" + item.qitemId)!.deliveryState).toBe("delivered");
  });

  // Constructed footer transition: U3 retained no immediate pre-Enter snapshot.
  // Exercise the real transport/guard path, not just the empty-composer parser.
  it.each(["✔ Update installed · Restart to update", "✔ Update installed · Restart to apply", "✔ Update installed · /restart to apply"])(
    "submits one owned paste when its hint shares the footer with %s", async banner => {
      const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
      const text = "first line\nsecond line\nlast line";
      vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => {
        const staged = f.bodies.a === text;
        const snapshot = frame(staged ? "[Pasted text #1 +2 lines]" : f.bodies.a ?? "");
        snapshot.screen = snapshot.screen.replace("? for shortcuts\n",
          staged ? `paste again to expand  ${banner}\n`
            : `⏵⏵ accept edits on (shift+tab to cycle)\n${banner}\n`);
        return snapshot;
      });
      const result = await f.send("update-banner-paste", text, { verify: false });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sent: true });
      expect(f.submissions).toEqual([text]);
      expect(f.bodies.a).toBe("");
      expect(f.writes.filter(write => write.startsWith("paste:"))).toHaveLength(1);
      expect(f.writes.filter(write => write.startsWith("keys:"))).toHaveLength(1);
    });

  it.each(["✔ Update installed · Restart to update now", "Update installed · Restart to update", "✔ Update downloaded · Restart to update"])(
    "does not submit an owned paste under an unrecognized footer suffix %s", async suffix => {
      const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
      const text = "first line\nsecond line\nlast line";
      vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => {
        const snapshot = frame(f.bodies.a ?? "");
        snapshot.screen = snapshot.screen.replace("? for shortcuts\n", f.bodies.a === text
          ? `paste again to expand  ${suffix}\n`
          : "⏵⏵ accept edits on (shift+tab to cycle)\n");
        return snapshot;
      });
      expect(await f.send("unknown-paste-footer", text, { verify: false })).toMatchObject({ ok: false, sent: true, reason: "draft_input_unknown" });
      expect(f.submissions).toEqual([]);
      expect(f.bodies.a).toBe(text);
    });

  // A Claude seat whose Remote Control connection failed keeps its "/rc failed" row under the footer, below the update
  // banner, before and after our paste. Through the real transport and guard, one owned paste is submitted; a near miss
  // or the selected indicator gets no paste and no Enter.
  const underRemoteControl = (f: ReturnType<typeof fixture>, text: string, indicator: string) => vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => {
    const staged = f.bodies.a === text;
    const snapshot = frame(staged ? "[Pasted text #1 +2 lines]" : f.bodies.a ?? "");
    snapshot.screen = snapshot.screen.replace("? for shortcuts\n",
      `${staged ? "paste again to expand" : "⏵⏵ bypass permissions on · 1 shell · ↓ to manage"}\n✔ Update installed · /restart to apply\n${indicator}\n`);
    return snapshot;
  });

  it.each(["/rc failed", "/rc reconnecting", "/rc connecting…", "/rc active"])("submits one owned paste above Claude's %j indicator", async indicator => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const text = "first line\nsecond line\nlast line";
    underRemoteControl(f, text, indicator);
    const result = await f.send("remote-control-row", text, { verify: false });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([text]);
    expect(f.writes.filter(write => write.startsWith("paste:"))).toHaveLength(1);
    expect(f.writes.filter(write => write.startsWith("keys:"))).toHaveLength(1);
  });

  it.each(["/rc failed · Enter to view", "/rc disconnected", "\x1b[7m/rc failed\x1b[27m"])("holds a send under %j with no paste and no Enter", async indicator => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const text = "first line\nsecond line\nlast line";
    underRemoteControl(f, text, indicator);
    const result = await f.send("remote-control-near-miss", text, { verify: false });
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_unknown" });
    expect(f.submissions).toEqual([]);
    expect(f.writes.filter(write => write.startsWith("paste:") || write.startsWith("keys:"))).toEqual([]);
  });

  // D04 at full width (Claude 2.1.322 and 2.1.323, 200x50, as banked): the paste hint and the auto-update failure share
  // the footer row under an empty input box, before any paste of ours.
  const wideFooter = `  paste again to expand${" ".repeat(97)}✘ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-code`;
  const underWideFooter = (f: ReturnType<typeof fixture>) => vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => {
    const snapshot = frame(f.bodies.a ?? "");
    snapshot.screen = snapshot.screen.replace("? for shortcuts\n", `${wideFooter}\n`);
    return snapshot;
  });

  it("delivers once to an empty input box under the full-width paste hint and auto-update failure row", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    underWideFooter(f);
    const result = await f.send("wide-footer", "next work", { verify: false });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual(["next work"]);
  });

  it("still holds a person's draft under the same full-width footer row", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "a person's draft";
    underWideFooter(f);
    expect(await f.send("wide-footer-draft", "next work")).toMatchObject({ outcome: "retained", sent: false, inputPhase: "not_reached" });
    expect(f.submissions).toEqual([]);
    expect(f.bodies.a).toBe("a person's draft");
  });

  it.each(Array.from({ length: nativePaste.afterSamples }, (_, i) => i + 1))("submits its retained native paste across the footer change (sample %i)", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const text = Array.from({ length: 71 }, (_, i) => `delivery line ${i}`).join("\n");
    let readsAfterPaste = 0;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () =>
      f.bodies.a === text && readsAfterPaste++ > 0 ? nativePaste.after : nativePaste.before);
    expect(await f.send("native-footer", text, { verify: false })).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([text]);
    expect(f.writes).toHaveLength(2); // One paste, one Enter; no retry.
  });

  it.each(["person's draft", "menu", "changed occupant", "changed target"])("keeps %s protected during a paste-hint transition", async condition => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const text = Array(71).fill("delivery").join("\n");
    let readsAfterPaste = 0;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => {
      if (condition === "person's draft") return frame("unfinished note");
      if (f.bodies.a !== text || readsAfterPaste++ === 0) return nativePaste.before;
      return condition === "menu" ? frame("1. Yes") : nativePaste.after;
    });
    f.hooks.sleep = ms => {
      if (ms !== 200) return;
      if (condition === "changed occupant") f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('next','a',2,'replacement','fresh')");
      if (condition === "changed target") f.db.exec("UPDATE bindings SET tmux_pane='%3' WHERE node_id='a'");
    };
    const result = await f.send("native-footer-control", text, { verify: false });
    expect(result).toMatchObject(condition === "person's draft" ? { outcome: "retained", sent: false } : { ok: false });
    expect(f.submissions).toEqual([]);
    expect(f.writes.filter(write => write.startsWith("keys:"))).toEqual([]);
    if (condition === "person's draft") expect(f.writes).toEqual([]);
  });

  it("does not submit a person's replacement paste after recording its own label", async () => {
    const f = fixture(); await f.enable();
    const text = "first line\nsecond line\nlast line", draft = "different first\ndifferent second\ndifferent last";
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async name => {
      const body = f.bodies[f.guard.target(name).nodeId];
      return body == null ? null : frame(body === text ? "[Pasted text #1 +2 lines]" : body === draft ? "[Pasted text #2 +2 lines]" : body);
    });
    // A person attached directly replaces the draft; no broker humanInput call updates the epoch.
    f.hooks.sleep = ms => { if (ms === 200) f.bodies.a = draft; };
    expect(await f.send("replacement-label", text, { verify: false })).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed" });
    expect(f.submissions).toEqual([]);
    expect(f.writes).toHaveLength(1);
    expect(f.bodies.a).toBe(draft);
  });

  it.each(["wrong count", "moved cursor", "changed composer", "human input"])("does not submit a delayed label after %s", async condition => {
    const f = fixture(); await f.enable();
    const text = "first line\nsecond line\nlast line";
    let readsAfterPaste = 0;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async name => {
      const body = f.bodies[f.guard.target(name).nodeId];
      if (body !== text) return body == null ? null : frame(body);
      if (readsAfterPaste++ === 0) return frame("");
      const snapshot = frame(condition === "wrong count" ? "[Pasted text #1 +9 lines]" : "[Pasted text #1 +2 lines]");
      if (condition === "moved cursor") snapshot.cursor.x--;
      if (condition === "changed composer") snapshot.cursor.width--;
      return snapshot;
    });
    if (condition === "human input") f.hooks.sleep = async ms => {
      if (ms === 200) await f.guard.humanInput("worker@test", async () => {});
    };
    const result = await f.send("unowned-label", text, { verify: false });
    expect(result).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed" });
    expect(result.error).toContain("Enter was not sent");
    expect(f.submissions).toEqual([]);
    expect(f.bodies.a).toBe(text);
    expect(f.writes).toHaveLength(1);
  });

  it("retains the next wake behind an uncertain native Enter without submitting or replaying the leftover", async () => {
    const f = fixture(); await f.enable();
    const enter = vi.spyOn(f.tmux, "sendKeys").mockResolvedValueOnce({ ok: false, code: "tmux_error", message: "lost Enter result" });
    const first = await f.send("uncertain-enter");
    expect(first).toMatchObject({ ok: false, reason: "submit_failed" });
    expect(first.error).toContain("submission outcome is unconfirmed");
    expect(f.outbox.getById(first.outboxIds![0]!)!.deliveryState).toBe("indeterminate");
    expect(await f.send("next-wake")).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    expect(enter).toHaveBeenCalledTimes(1);
    expect(f.writes).toHaveLength(1);
    expect(f.submissions).toEqual([]);
    expect(f.bodies.a).toBe("incoming message");
  });

  // #2429: Claude may still be redrawing a fresh paste when the guard reads before Enter; this frame has no composer yet.
  const redrawing = (): ComposerSnapshot => ({ screen: "Ready\n❯ [Pasted text #1 +2 lines]\n", cursor: { x: 27, y: 1, width: 240, height: 60 }, inMode: false });

  it("re-reads its own paste once when it can't read the input before Enter, then submits it (#2429)", async () => {
    const f = fixture(); await f.enable();
    const text = "first line\nsecond line\nlast line";
    let entering = false, readsBeforeEnter = 0;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async name => {
      const body = f.bodies[f.guard.target(name).nodeId];
      if (body === text && entering && readsBeforeEnter++ === 0) return redrawing();
      return body == null ? null : frame(body === text ? "[Pasted text #1 +2 lines]" : body);
    });
    f.hooks.sleep = ms => { if (ms === 200) entering = true; };
    expect(await f.send("redrawn-paste", text, { verify: false })).toMatchObject({ ok: true, sent: true });
    expect(readsBeforeEnter).toBe(2);
    expect(f.submissions).toEqual([text]);
  });

  it.each([["its recorded collapsed label", "first line\nsecond line\nlast line"], ["its visible text", "one line"]])(
    "submits its own unreadable leftover, shown as %s, before the next wake (#2429)", async (_shown, text) => {
    const f = fixture(); await f.enable();
    let unreadable = false;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async name => {
      const body = f.bodies[f.guard.target(name).nodeId];
      if (body === text) return unreadable ? redrawing() : frame(text.includes("\n") ? "[Pasted text #1 +2 lines]" : text);
      return body == null ? null : frame(body);
    });
    f.hooks.sleep = ms => { if (ms === 200 && f.bodies.a === text) unreadable = true; };
    const first = await f.send("unreadable-paste", text, { verify: false });
    expect(first).toMatchObject({ ok: false, sent: true, reason: "draft_input_unknown" });
    expect(first.error).toContain("Enter was not sent");
    unreadable = false;
    expect(await f.send("next-wake", "next work", { verify: false })).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([text, "next work"]);
    expect(f.writes.filter(write => write.startsWith("keys:"))).toHaveLength(2);
    expect(f.bodies.a).toBe("");
  });

  // A wake whose Enter was refused on an unreadable input, leaving its paste behind.
  async function leaveOwnPaste(f: ReturnType<typeof fixture>, text: string) {
    let unreadable = false;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async name => {
      const body = f.bodies[f.guard.target(name).nodeId];
      if (body === text) return unreadable ? redrawing() : frame(text);
      return body == null ? null : frame(body);
    });
    f.hooks.sleep = ms => { if (ms === 200 && f.bodies.a === text) unreadable = true; };
    expect(await f.send("unreadable-paste", text, { verify: false })).toMatchObject({ ok: false, sent: true, reason: "draft_input_unknown" });
    unreadable = false;
  }

  it("submits the leftover only after this send's own checks pass: a check that refuses after buffer preparation sends no key (#2429)", async () => {
    const f = fixture(); await f.enable();
    await leaveOwnPaste(f, "one line");
    let prepared = false;
    f.hooks.load = () => { prepared = true; };
    // The caller's own check passes until the send's buffer is prepared, then refuses (as a cancellation would).
    const next = await f.send("next-wake", "next work", { verify: false, beforeWrite: () => { if (prepared) throw new Error("fixture: the caller went away"); } });
    expect(next.sent).not.toBe(true);
    expect(f.writes.filter(write => write.startsWith("keys:"))).toEqual([]);
    expect(f.bodies.a).toBe("one line");
  });

  it("submits nothing when this send's own check goes invalid during the re-read before the leftover's Enter, and keeps the record (#2429)", async () => {
    const f = fixture(); await f.enable();
    await leaveOwnPaste(f, "one line");
    let prepared = false, readsAfterPrepare = 0, valid = true;
    f.hooks.load = () => { prepared = true; };
    const capture = vi.mocked(f.tmux.captureComposerSnapshot).getMockImplementation()!;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async name => {
      // The second read after the buffer is prepared is the re-read after this send's checks passed: the caller goes away then.
      if (prepared && ++readsAfterPrepare === 2) valid = false;
      return capture(name);
    });
    const next = await f.send("next-wake", "next work", { verify: false, beforeWrite: () => { if (!valid) throw new Error("fixture: the caller went away"); } });
    expect(next.sent).not.toBe(true);
    expect(f.writes.filter(write => write.startsWith("keys:"))).toEqual([]);
    expect(f.bodies.a).toBe("one line");
    // The record is kept, so a later ordinary wake still submits the leftover first.
    expect(await f.send("later-wake", "later work", { verify: false })).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual(["one line", "later work"]);
  });

  it("a send that needs an idle seat leaves the leftover and is held, so it never types into the turn the leftover would start (#2429)", async () => {
    const f = fixture(); await f.enable();
    await leaveOwnPaste(f, "one line");
    expect(await f.send("idle-wake", "next work", { verify: false, waitForIdleMs: 60000 })).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    expect(f.writes.filter(write => write.startsWith("keys:"))).toEqual([]);
    expect(f.bodies.a).toBe("one line");
  });

  it("says it submitted the leftover even when its own text then isn't sent (#2429)", async () => {
    const f = fixture(); await f.enable();
    await leaveOwnPaste(f, "one line");
    // The caller goes away after the leftover's Enter, before this send's own paste.
    const next = await f.send("next-wake", "next work", { verify: false, beforeWrite: () => { if (f.submissions.length) throw new Error("fixture: the caller went away"); } });
    expect(next).toMatchObject({ ownPasteSubmitted: true, warning: expect.stringContaining("earlier paste") });
    expect(next.sent).not.toBe(true);
    expect(f.submissions).toEqual(["one line"]);
    expect(f.bodies.a).toBe("");
  });

  it.each(["a different label", "human input", "an unrecorded label"])("keeps the next wake held when its unreadable leftover isn't provably its own: %s (#2429)", async condition => {
    const f = fixture(); await f.enable();
    const text = "first line\nsecond line\nlast line", other = "other first\nother second\nother last";
    let unreadable = condition === "an unrecorded label";
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async name => {
      const body = f.bodies[f.guard.target(name).nodeId];
      if (body === text) return unreadable ? redrawing() : frame("[Pasted text #1 +2 lines]");
      return body == null ? null : frame(body === other ? "[Pasted text #2 +2 lines]" : body);
    });
    f.hooks.sleep = ms => { if (ms === 200 && f.bodies.a === text) unreadable = true; };
    expect(await f.send("unreadable-paste", text, { verify: false })).toMatchObject({ ok: false, sent: true, reason: "draft_input_unknown" });
    unreadable = false;
    // A person attached directly replaces the paste, or types through OpenRig.
    if (condition === "a different label") f.bodies.a = other;
    if (condition === "human input") await f.guard.humanInput("worker@test", async () => {});
    expect(await f.send("next-wake", "next work", { verify: false })).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    expect(f.submissions).toEqual([]);
    expect(f.writes.filter(write => write.startsWith("keys:"))).toEqual([]);
    expect(f.bodies.a).toBe(condition === "a different label" ? other : text);
  });

  it("tries a current request after the person's draft clears, without replaying a saved prerequisite", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "a person's draft";
    const oldPrerequisite = vi.fn();
    expect(await f.send("draft-cleared", "current request", { beforeWrite: oldPrerequisite })).toMatchObject({ outcome: "retained", sent: false });
    expect(f.submissions).toEqual([]);
    f.bodies.a = "";
    expect(await f.send("draft-cleared", "current request")).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual(["current request"]);
    expect(oldPrerequisite).not.toHaveBeenCalled();
  });

  it("at queue-only, a deliberate send never types over a person's draft and is delivered once the input is empty; OpenRig's own notice is held (#3076)", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "queue-only" }, "human@test", "a person types here");
    f.bodies.a = "a person's draft";
    for (const urgent of [undefined, { by: "lead@test" }]) {
      expect(await f.send(`qo-draft-${urgent ? "urgent" : "plain"}`, "deliberate send", { verify: false, ...(urgent ? { urgent } : {}) }))
        .toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    }
    expect(f.writes).toEqual([]);
    expect(f.bodies.a).toBe("a person's draft");
    f.bodies.a = "";
    expect(await f.send("qo-empty", "deliberate send", { verify: false })).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual(["deliberate send"]);
    const notice = await f.send("qo-notice", "OpenRig notice", { verify: false, openrigNotice: true, urgent: { by: "OpenRig" } });
    // Held for the seat, not refused nor failed: retained in its outbox, nothing written.
    expect(notice).toMatchObject({ ok: true, outcome: "retained", sent: false, reason: "typing_guard_enabled", outboxIds: ["qo-notice"] });
    expect(f.submissions).toEqual(["deliberate send"]);
  });

  it("delivers at an ordinary empty prompt when receipt bookkeeping is unavailable", async () => {
    const f = fixture(); await f.enable();
    f.db.exec("CREATE TRIGGER fail_delivery_receipt BEFORE UPDATE OF guard_delivery ON outbox_entries BEGIN SELECT RAISE(ABORT, 'fixture receipt unavailable'); END;");
    const result = await f.send("no-receipt", "arrives despite bookkeeping");
    expect(f.submissions).toEqual(["arrives despite bookkeeping"]);
    expect(result).toMatchObject({ ok: true, sent: true });
    expect(result.warning).toMatch(/bookkeeping|receipt/i);
  });

  it("keeps the MCP adapter's principal on the outbox row a draft-aware send writes", async () => {
    const f = fixture(); await f.enable();
    const principal = JSON.stringify({ source: "file", id: "alice" });
    expect(await f.send("with-principal", "for alice", { identityProvenance: "principal:v1", identityPrincipal: principal })).toMatchObject({ ok: true, sent: true });
    expect(f.db.prepare("SELECT identity_provenance AS p, identity_principal AS who FROM outbox_entries WHERE body = 'for alice'").all())
      .toEqual([{ p: "principal:v1", who: principal }]);
  });

  it("protects a human draft without claiming custody when its record cannot be saved", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "unfinished human input";
    f.db.exec("CREATE TRIGGER fail_held_receipt BEFORE UPDATE OF guard_delivery ON outbox_entries BEGIN SELECT RAISE(ABORT, 'fixture receipt unavailable'); END;");
    const result = await f.send("unsaved-held", "incoming message");
    expect(result).toMatchObject({ ok: false, sent: false, outcome: "failed", reason: "draft_input_busy" });
    expect(result.warning).toMatch(/bookkeeping/);
    expect(result.outboxIds).toBeUndefined();
    expect(f.bodies.a).toBe("unfinished human input"); expect(f.writes).toEqual([]);
  });

  it("a callback throwing null stays an uncertain delivery result", async () => {
    const f = fixture(); await f.enable();
    expect(await f.send("null-callback", "current request", { beforeWrite: () => { throw null; } }))
      .toMatchObject({ ok: false, outcome: "failed", reason: "delivery_indeterminate" });
    expect(f.submissions).toEqual([]);
  });

  it("completes a successful send without requested verification without claiming render proof", async () => {
    const f = fixture(); await f.enable();
    const result = await f.send("no-verify", "message", { verify: false });
    expect(result).toMatchObject({ ok: true, sent: true });
    expect(result.verified).toBeUndefined();
    expect(f.outbox.getById(result.outboxIds![0]!)!.deliveryState).toBe("delivered");
    await f.send("no-verify", "message", { verify: false });
    expect(f.submissions).toEqual(["message", "message"]);
  });

  it("keeps unconfirmed verification honest while allowing a current request", async () => {
    const f = fixture(); await f.enable();
    vi.mocked(f.tmux.capturePaneContent).mockResolvedValue("no render evidence");
    expect(await f.send("not-confirmed")).toMatchObject({ ok: true, sent: true, verified: false });
    await f.send("not-confirmed");
    expect(f.db.prepare("SELECT delivery_state FROM outbox_entries").all()).toEqual([{ delivery_state: "indeterminate" }, { delivery_state: "indeterminate" }]);
    expect(f.submissions).toHaveLength(2);
  });

  // With no authoritative idle hook, a Claude seat's readiness comes from its screen, so the lease-free idle wait would read a draft as
  // needs-input, or an unreadable screen as unknown until the deadline, before the draft-aware check ran. A draft-aware seat keeps the
  // check's immediate result instead.
  it.each(["draft", "unknown"])("a Claude seat with no idle hook returns the exact %s refusal and original ID immediately with wait-for-idle", async condition => {
    const f = fixture(undefined, { runtime: "claude-code", idleHook: false }); await f.enable();
    f.bodies.a = condition === "unknown" ? null : "unfinished human request";
    const reason = condition === "unknown" ? "draft_input_unknown" : "draft_input_busy";
    const sleep = vi.fn((ms: number) => f.advance(ms)); f.hooks.sleep = sleep; // a wait, if any, reaches its deadline
    expect(await f.send("held-claude", "incoming message", { waitForIdleMs: 60000, verify: false })).toMatchObject({
      outcome: "retained", sent: false, reason, outboxIds: [expect.any(String)],
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
    expect(f.outbox.heldForNode("a").items[0]).toMatchObject({ body: "incoming message", deliveryState: "retained" });
  });

  it("a Claude seat with no idle hook and an empty input box takes a wait-for-idle send once", async () => {
    const f = fixture(undefined, { runtime: "claude-code", idleHook: false }); await f.enable();
    expect(await f.send("empty-claude", "incoming message", { waitForIdleMs: 60000, verify: false })).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual(["incoming message"]);
  });

  it.each([false, true])("preserves old uncertainty but allows a current request (generic recovery first: %s)", async genericFirst => {
    const first = fixture(); await first.enable(); first.bodies.a = "draft"; await first.send("crash");
    first.db.exec("UPDATE outbox_entries SET delivery_state='sending',guard_delivery=json_remove(guard_delivery,'$.result');");
    const resumed = fixture(first.db.serialize());
    const interrupted = resumed.outbox.listForSender("human@test")[0]!.outboxId;
    expect(resumed.guarded.lookup(interrupted)).toMatchObject({ state: "sending", reason: "delivery_in_progress" });
    if (genericFirst) resumed.outbox.reconcileAbandonedSending("crash");
    resumed.guarded.recover();
    expect(resumed.guarded.lookup(interrupted)).toMatchObject({ state: "indeterminate", reason: "interrupted_write" });
    expect(await resumed.send("crash")).toMatchObject({ ok: true, sent: true });
    expect(resumed.submissions).toEqual(["incoming message"]);
    expect(resumed.db.prepare("SELECT count(*) AS n FROM outbox_entries WHERE delivery_state='indeterminate'").get()).toEqual({ n: 1 });
  });

  it("serializes current requests and waits for active input on shutdown", async () => {
    const f = fixture(); await f.enable(); const entered = signal(), release = signal();
    f.hooks.paste = async () => { entered.release(); await release.ready; };
    const sending = f.send("concurrent"); await entered.ready;
    const second = f.send("concurrent");
    let stopped = false; const stopping = f.guarded.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release.release(); await Promise.all([sending, second, stopping]);
    expect(f.submissions).toEqual(["incoming message", "incoming message"]);
  });

  it("leaves human edits visible and never replays an already-pasted message", async () => {
    const f = fixture(); await f.enable();
    f.hooks.sleep = ms => { if (ms === 200) f.bodies.a += " plus a human draft"; };
    expect(await f.send("late")).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed" });
    expect(f.bodies.a).toBe("incoming message plus a human draft");
    await f.send("late"); expect(f.writes).toHaveLength(1); expect(f.submissions).toEqual([]);
  });

  it.each([false, true])("does not claim no write for an unknown native result (wait mode: %s)", async wait => {
    const f = fixture(); await f.enable();
    f.hooks.paste = () => { f.bodies.a = "incoming message"; throw new Error("lost native result after dispatch"); };
    const opts = wait ? { waitForIdleMs: 1000 } : {};
    const result = await f.send("unknown-write", "incoming message", opts);
    expect(result).toMatchObject({ ok: false });
    expect(result.sent).toBeUndefined();
    await f.send("unknown-write", "incoming message", opts);
    expect(f.submissions).toEqual([]);
  });

  it("reports actual delivered input when a final ledger update fails", async () => {
    const f = fixture(); await f.enable();
    const finalize = vi.spyOn(OutboxHandler.prototype, "finalizeDelivery").mockImplementationOnce(() => { throw new Error("ledger failure"); });
    try {
      const result = await f.send("ledger-failure");
      expect(result).toMatchObject({ ok: true, sent: true, verified: true });
      expect(result.warning).toMatch(/bookkeeping/);
      await f.send("ledger-failure");
      expect(f.submissions).toEqual(["incoming message", "incoming message"]);
    } finally { finalize.mockRestore(); }
  });


  it("reports current input without requiring a historical receipt read", async () => {
    const f = fixture(); await f.enable();
    const prepare = f.db.prepare.bind(f.db);
    let finalized = false;
    const finalize = OutboxHandler.prototype.finalizeDelivery;
    const finalizer = vi.spyOn(OutboxHandler.prototype, "finalizeDelivery").mockImplementation(function (this: OutboxHandler, id, state) {
      const result = finalize.call(this, id, state); finalized = true; return result;
    });
    const reader = vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => {
      if (finalized && sql === "SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?") throw new Error("receipt unavailable");
      return prepare(sql);
    });
    try {
      const result = await f.send("lost-receipt");
      expect(result).toMatchObject({ ok: true, sent: true });
      expect(f.submissions).toHaveLength(1);
    } finally { reader.mockRestore(); finalizer.mockRestore(); }
    expect(await f.send("lost-receipt")).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toHaveLength(2);
  });

  it("does not serialize or replay a live prerequisite", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "draft"; const beforeWrite = vi.fn();
    expect(await f.send("live", "message", { beforeWrite })).toMatchObject({ outcome: "retained", reason: "draft_input_busy" });
    f.bodies.a = ""; await f.send("live", "message");
    expect(beforeWrite).not.toHaveBeenCalled(); expect(f.submissions).toEqual(["message"]);
  });
});

describe("supported seat and queue integration", () => {
  it.each(["failed", "indeterminate", "sending"])("startup recovery attempts a still-current %s queue wake", async state => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    const id = "wake-intent-" + item.qitemId;
    const original = f.outbox.getById(id)!;
    f.db.prepare("UPDATE outbox_entries SET delivery_state=? WHERE outbox_id=?").run(state, id);
    const reopened = fixture(f.db.serialize());
    reopened.repo.reconcileAbandonedWakeIntents();
    await reopened.repo.drainPendingWakeIntents();
    expect(reopened.submissions).toHaveLength(1);
    expect(reopened.submissions[0]).toContain(original.body);
    expect(reopened.submissions[0]).toMatch(/may (?:repeat|be repeated)/i);
    expect(reopened.outbox.getById(id)!.body).toBe(original.body);
    expect(reopened.outbox.getById(id)!.deliveryState).toBe("delivered");
    expect(reopened.repo.getById(item.qitemId)!.state).toBe("pending");
    expect(reopened.db.prepare("SELECT count(*) AS n FROM queue_items").get()).toEqual({ n: 1 });
    expect(reopened.bodies.b).toBe("");
    await reopened.repo.drainPendingWakeIntents();
    expect(reopened.submissions).toHaveLength(1);
  });

  it.each(["delivered", "retained", "retired"])("startup recovery leaves a %s queue wake alone", async state => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    const id = "wake-intent-" + item.qitemId;
    f.db.prepare("UPDATE outbox_entries SET delivery_state=? WHERE outbox_id=?").run(state, id);
    const reopened = fixture(f.db.serialize());
    reopened.repo.reconcileAbandonedWakeIntents();
    await reopened.repo.drainPendingWakeIntents();
    expect(reopened.writes).toEqual([]);
    expect(reopened.outbox.getById(id)!.deliveryState).toBe(state);
  });

  it.each(["closed", "claimed", "reassigned", "absent-pane", "replacement"].flatMap(state =>
    [false, true].map(draftAware => ({ state, draftAware }))))("recovery does not paste for $state work (draft-aware: $draftAware)", async ({ state, draftAware }) => {
    const f = fixture(undefined, { runtime: "claude-code" }); if (draftAware) await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    const id = "wake-intent-" + item.qitemId;
    f.db.prepare("UPDATE outbox_entries SET delivery_state='indeterminate' WHERE outbox_id=?").run(id);
    if (state === "closed") f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(item.qitemId);
    if (state === "claimed") f.repo.claim({ qitemId: item.qitemId, destinationSession: "worker@test" });
    if (state === "reassigned") f.db.prepare("UPDATE queue_items SET destination_session='sibling@test' WHERE qitem_id=?").run(item.qitemId);
    if (state === "absent-pane") f.db.prepare("UPDATE sessions SET status='exited' WHERE node_id='a'").run();
    if (state === "replacement") f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('next-a','a',2,'replacement-a','fresh')");
    const reopened = fixture(f.db.serialize());
    if (state === "absent-pane") vi.mocked(reopened.tmux.probeSession).mockResolvedValue({ state: "absent" });
    reopened.repo.reconcileAbandonedWakeIntents();
    await reopened.repo.drainPendingWakeIntents();
    expect(reopened.writes).toEqual([]);
  });

  it("tries a failed recovery once per pass even when the native result stays unknown", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    const id = "wake-intent-" + item.qitemId;
    f.db.prepare("UPDATE outbox_entries SET delivery_state='indeterminate' WHERE outbox_id=?").run(id);
    let attempts = 0;
    f.hooks.paste = () => { attempts++; throw new Error("native result unavailable"); };
    await f.repo.drainPendingWakeIntents();
    expect(attempts).toBe(1);
    expect(f.outbox.getById(id)!.deliveryState).toBe("indeterminate");
    expect(f.repo.getById(item.qitemId)!.lastNudgeWireResult).toMatch(/^indeterminate:/);
  });

  it("keeps earlier uncertainty when a recovery fails before input", async () => {
    const f = fixture(undefined, { runtime: "claude-code" });
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "work", nudge: false });
    const id = "wake-intent-" + item.qitemId;
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    f.db.prepare("UPDATE outbox_entries SET delivery_state='indeterminate' WHERE outbox_id=?").run(id);
    vi.spyOn(f.tmux, "probeSession").mockResolvedValue({ state: "absent" });
    expect(await f.repo.drainPendingWakeIntents()).toMatchObject({ indeterminate: 1, failed: 0 });
    expect(f.writes).toEqual([]);
    expect(f.outbox.getById(id)!.deliveryState).toBe("indeterminate");
    expect(f.repo.getById(item.qitemId)!.lastNudgeWireResult).toMatch(/^indeterminate:/);
  });

  it("does not describe an earlier attempt for a never-attempted pending wake", async () => {
    const f = fixture(undefined, { runtime: "claude-code" });
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    await f.repo.drainPendingWakeIntents();
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).not.toContain("earlier unconfirmed attempt");
  });

  it("reads current recovery candidates without visiting historical uncertain notifications", async () => {
    const f = fixture(undefined, { runtime: "claude-code" });
    const old = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "old work", nudge: false });
    f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(old.qitemId);
    f.db.transaction(() => { for (let i = 0; i < 600; i++) f.outbox.record({ outboxId: `wake-intent-history-${i}`, senderSession: "sender@test", destinationSession: "worker@test", body: "historical", auditPointer: old.qitemId }); })();
    f.db.exec("UPDATE outbox_entries SET delivery_state='indeterminate' WHERE outbox_id LIKE 'wake-intent-history-%'");
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "current work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    const reads = vi.spyOn(f.outbox, "getById");
    await f.repo.drainPendingWakeIntents();
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).toContain(item.qitemId);
    expect(reads.mock.calls.length).toBeLessThan(10);
  });

  it.each(["draft_input_changed", "delivery_indeterminate", "submit_failed", "send_failed"])(
    "keeps a committed wake's %s outcome indeterminate in the queue", async reason => {
      const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
      const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
      const id = "wake-intent-" + item.qitemId;
      f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
      if (reason === "draft_input_changed") f.hooks.sleep = ms => { if (ms === 200) f.bodies.a += " plus a human draft"; };
      if (reason === "delivery_indeterminate") f.hooks.sleep = () => { throw new Error("interrupted after the paste"); };
      if (reason === "submit_failed") vi.spyOn(f.tmux, "sendKeys").mockResolvedValue({ ok: false, code: "tmux_error", message: "lost Enter result" });
      if (reason === "send_failed") f.hooks.paste = () => { f.bodies.a = "possibly pasted"; throw new Error("lost native paste result"); };

      await f.repo.drainPendingWakeIntents();
      const receipt = JSON.parse((f.db.prepare("SELECT guard_delivery AS value FROM outbox_entries WHERE outbox_id=?").get(id) as { value: string }).value);
      expect(receipt.result).toMatchObject({ ok: false, reason });
      expect(receipt.result.delivery).toBeUndefined();
      expect(f.repo.getById(item.qitemId)!.lastNudgeWireResult).toMatch(/^indeterminate:/);
      expect(f.outbox.getById(id)!.deliveryState).toBe("indeterminate");
      expect(f.submissions).toEqual([]);
    },
  );

  it.each(["ladder", "legacy-boot"])("delivers a %s nudge without a precommitted outbox entry", async path => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    if (path === "ladder") await f.repo.maybeNudge(item.qitemId, "worker@test", true, "sender@test");
    else await f.repo.recoverLostNudge(item.qitemId, "worker@test", "sender@test");
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).toContain(item.qitemId);
    expect(f.bodies.b).toBe("");
    expect(f.repo.getById(item.qitemId)!.lastNudgeWireResult).toBe("verified");
  });

  it.each(["current", "closed", "reassigned"])("checks the %s queue facts without saved delivery bookkeeping", async state => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    f.db.exec("CREATE TRIGGER unavailable_nudge_receipt BEFORE UPDATE OF guard_delivery ON outbox_entries BEGIN SELECT RAISE(ABORT, 'fixture receipt unavailable'); END;");
    f.hooks.load = () => {
      if (state === "closed") f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(item.qitemId);
      if (state === "reassigned") f.db.prepare("UPDATE queue_items SET destination_session='sibling@test' WHERE qitem_id=?").run(item.qitemId);
    };
    await f.repo.maybeNudge(item.qitemId, "worker@test", true, "sender@test");
    expect(f.db.prepare("SELECT count(*) AS n FROM outbox_entries").get()).toEqual({ n: 0 });
    if (state === "current") {
      expect(f.submissions).toHaveLength(1);
      expect(f.submissions[0]).toContain(item.qitemId);
      expect(f.repo.getById(item.qitemId)!.lastNudgeWireResult).toBe("verified");
    } else expect(f.writes).toEqual([]);
    expect(f.bodies.b).toBe("");
  });

  it("exposes exact held reasons, audit identity and retirement through HTTP", async () => {
    const f = fixture(); f.bodies.a = "draft";
    expect((await f.post("/api/seat/set-typing-guard/worker@test", { mode: "draft-aware", actor: "spoof", reason: "draft" })).status).toBe(200);
    expect(f.db.prepare("SELECT actor FROM seat_delivery_guards").get()).toEqual({ actor: "human@test" });
    const response = await f.post("/api/transport/send", { session: "worker@test", text: "http message", deliveryId: "http", actorSession: "spoof", verify: true });
    const held = await response.json();
    expect(held).toMatchObject({ outcome: "retained", reason: "draft_input_busy", outboxIds: [expect.any(String)] });
    const id = held.outboxIds[0];
    const page = await (await f.app.request("/api/seat/held-messages/worker@test")).json();
    expect(page.items[0]).toMatchObject({ senderSession: "human@test", body: "http message", delivery: { state: "held", reason: "draft_input_busy" } });
    expect(f.db.prepare("SELECT identity_provenance FROM outbox_entries").get()).toEqual({ identity_provenance: "transport:v1" });
    expect(await (await f.app.request("/api/seat/status/worker@test")).json()).toMatchObject({ typingGuard: { effectiveMode: "draft-aware", heldCount: 1 } });
    expect((await f.post(`/api/seat/retire-held-message/sibling@test/${id}`, { reason: "read" })).status).toBe(404);
    expect((await f.post(`/api/seat/retire-held-message/worker@test/${id}`, { reason: "read" })).status).toBe(200);
    expect(await (await f.app.request(`/api/seat/held-messages/worker@test?id=${id}`)).json()).toMatchObject({ entry: { deliveryState: "retired" }, delivery: { state: "held", reason: "message_retired" } });
    expect(f.writes).toEqual([]); // Retirement itself did not type anything.
    f.bodies.a = ""; expect(await f.send("http", "http message")).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual(["http message"]);
  });

  it.each(["typed", "native"])("%s route retention alone does not project a delivery attempt through HTTP", async route => {
    const f = fixture();
    await f.guard.set("a", { mode: "hold" }, "human@test", "quiet seat");
    f.db.prepare("UPDATE nodes SET input_route=? WHERE id='a'").run(route);
    const result = await f.send("route-only", "held by level");
    expect(result).toMatchObject({ outcome: "retained", sent: false, reason: "typing_guard_enabled" });
    const id = result.outboxIds![0]!;
    expect(f.outbox.getById(id)).toMatchObject({ deliveryState: "retained", body: "held by level" });
    expect(f.outbox.inputRoute(id)).toBe(route);
    expect(f.guarded.lookup(id)).toBeNull();
    const page = await (await f.app.request("/api/seat/held-messages/worker@test")).json();
    expect(page.items[0].delivery).toBeUndefined();
    const detail = await (await f.app.request(`/api/seat/held-messages/worker@test?id=${id}`)).json();
    expect(detail.delivery).toBeUndefined();
    expect(f.writes).toEqual([]);
  });

  it("native admission and lost receiver ownership remain visible in delivery history", () => {
    const f = fixture();
    const input = { outboxId: "native-attempt", senderSession: "human@test", destinationSession: "worker@test", body: "native input" };
    f.outbox.retain(input, f.guard.target("worker@test"));
    f.outbox.admitRunner({ ...input, nodeId: "a", runId: "projection-run", kind: "input", inputRoute: "native", payload: { text: input.body } });
    expect(f.guarded.lookup(input.outboxId)).toMatchObject({ state: "sending", reason: "delivery_in_progress" });
    f.outbox.updateRunner("a", "projection-run", input.outboxId, 1, "offered");
    f.outbox.forgetRunnerMap("a", "projection-run");
    expect(f.guarded.lookup(input.outboxId)).toMatchObject({ state: "indeterminate", reason: "interrupted_write" });
    expect(f.outbox.runnerReceipt(input.outboxId)).toMatchObject({ reconciliation: "receiver_state_lost" });
    expect(f.writes).toEqual([]);
  });

  it("attempts each explicit HTTP request despite a reused caller ID", async () => {
    const f = fixture(); await f.enable();
    const send = () => f.post("/api/transport/send", { session: "worker@test", text: "http success", deliveryId: "http-success", verify: true });
    expect(await (await send()).json()).toMatchObject({ ok: true, verified: true });
    expect(await (await send()).json()).toMatchObject({ ok: true, verified: true });
    expect(f.submissions).toEqual(["http success", "http success"]);
  });

  it("broadcast preserves one original record per recipient", async () => {
    const f = fixture(); await f.enable();
    expect(await (await f.post("/api/transport/broadcast", { sessions: ["worker@test", "sibling@test"], text: "broadcast message", verify: true })).json()).toMatchObject({ sent: 2, failed: 0 });
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({ n: 2 });
    expect(f.submissions).toEqual(["broadcast message", "broadcast message"]);
  });

  it("rejects invalid modes, ambiguous controls and obsolete retry settings", async () => {
    const f = fixture();
    for (const body of [{ enabled: true, mode: "draft-aware", reason: "ambiguous" }, { reason: "missing" }, { enabled: "true", reason: "type" },
      { mode: "automatic", reason: "old mode" }, { mode: "draft-aware", maxAttempts: 3, reason: "obsolete" },
      { mode: "draft-aware", holdSeconds: 60, reason: "obsolete" }, { mode: "hold" }]) {
      expect((await f.post("/api/seat/set-typing-guard/worker@test", body)).status).toBe(400);
    }
  });

  it("hold keeps messages indefinitely while a sibling still receives sends", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "hold" }, "human@test", "manual terminal");
    expect(await f.send("inbox")).toMatchObject({ outcome: "retained", reason: "typing_guard_enabled" });
    expect(await f.transport.send("sibling@test", "sibling message", { verify: true })).toMatchObject({ ok: true });
    await f.enable(); expect(await f.send("inbox")).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual(["sibling message", "incoming message"]);
  });

  // Queue wakes go to an agent seat: a wake to a terminal seat types nothing before any draft check (gateway-destination-routing covers it).
  it("a held queue wake remains on the existing queue recovery path without a second scheduler", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("retained:draft_aware"));
    const id = "wake-intent-" + item.qitemId;
    expect(f.guarded.lookup(id)).toMatchObject({ state: "held", reason: "draft_input_busy" });
    f.bodies.a = ""; await f.repo.drainPendingWakeIntents();
    expect(f.outbox.getById(id)!.deliveryState).toBe("retained");
    expect(f.repo.getById(item.qitemId)!.state).toBe("pending"); expect(f.writes).toEqual([]);
  });

  // #48: the seat's idle report retries a draft-held wake through the same guarded delivery, within the wake retry cap.
  it("delivers a draft-held queue wake on the seat's next idle report once the draft has cleared", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("retained:draft_aware"));
    f.bodies.a = "";
    await f.repo.retryDraftHeldWakesOnIdle("worker@test", "idle");
    expect(f.outbox.getById("wake-intent-" + item.qitemId)!.deliveryState).toBe("delivered");
    expect(f.submissions.some(s => s.includes(item.qitemId))).toBe(true);
    expect(f.repo.getById(item.qitemId)!.lastNudgeResult).not.toMatch(/^retained:/);
  });

  it("keeps a draft-held wake held while the draft stays, one bounded attempt per idle report, never typing over it", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("retained:draft_aware"));
    for (let i = 0; i < 5; i++) await f.repo.retryDraftHeldWakesOnIdle("worker@test", "idle");
    expect(f.outbox.getById("wake-intent-" + item.qitemId)!.deliveryState).toBe("retained");
    expect(f.writes).toEqual([]);
    const attempts = f.repo.listTransitions(item.qitemId).filter(t => t.transitionNote?.startsWith("wake-attempt:"));
    expect(attempts.map(t => t.transitionNote)).toEqual([1, 2, 3].map(n => `wake-attempt: ${n}/3 outcome=retained:draft_aware trigger=seat-idle`));
  });

  it("never retries a hold-mode wake, and a running report retries nothing", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.guard.set("a", { mode: "hold" }, "human@test", "manual terminal");
    const held = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(held.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
    await f.repo.retryDraftHeldWakesOnIdle("worker@test", "idle");
    expect(f.outbox.getById("wake-intent-" + held.qitemId)!.deliveryState).toBe("retained");

    const g = fixture(undefined, { runtime: "claude-code" }); await g.enable(); g.bodies.a = "draft";
    const drafted = await g.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(g.repo.getById(drafted.qitemId)!.lastNudgeResult).toBe("retained:draft_aware"));
    g.bodies.a = "";
    await g.repo.retryDraftHeldWakesOnIdle("worker@test", "running");
    expect(g.outbox.getById("wake-intent-" + drafted.qitemId)!.deliveryState).toBe("retained");
    expect([...f.writes, ...g.writes]).toEqual([]);
  });

  // #48: past the bound (draft-aware) or the window (hold), the owner's escalation and the sender's notice go out once
  // per held episode, and nothing is typed into the held seat.
  const heldLadder = async (f: ReturnType<typeof fixture>, window: number) => {
    const { runWakeLadderTick } = await import("../src/domain/queue-wake-ladder.js");
    return async () => {
      // A zero retry interval: the ladder acts on these rows without waiting out the interval after their last attempt.
      const result = await runWakeLadderTick({ db: f.db, queueRepo: f.repo, retryCap: 3, retryIntervalSeconds: 0, unconfirmedWindowMinutes: window,
        resolveOrchestrator: () => "orch@test", attemptWake: async () => "verified" });
      expect(result).not.toMatchObject({ outcome: "failed" });
      return result;
    };
  };
  const notes = (f: ReturnType<typeof fixture>, qitemId: string, prefix: string) =>
    f.repo.listTransitions(qitemId).map(t => t.transitionNote ?? "").filter(n => n.startsWith(prefix));
  const typedInto = (f: ReturnType<typeof fixture>, node: string) => f.writes.filter(w => w.startsWith(`paste:${node}:`) || w.startsWith(`keys:${node}:`));

  it("tells the owner and the sender once when a draft-held wake is still held at the retry cap, typing nothing into the held seat", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    f.db.prepare("UPDATE nodes SET runtime='claude-code' WHERE id='b'").run();
    const item = await f.repo.create({ sourceSession: "sibling@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("retained:draft_aware"));
    const tick = await heldLadder(f, 30);
    await tick();
    expect(notes(f, item.qitemId, "escalation-rung:")).toEqual([]);
    for (let i = 0; i < 3; i++) await f.repo.retryDraftHeldWakesOnIdle("worker@test", "idle");
    await tick(); await tick();
    expect(notes(f, item.qitemId, "escalation-rung: orchestrator -> orch@test")).toHaveLength(1);
    expect(notes(f, item.qitemId, "escalation-rung:")[0]).toMatch(/held by worker@test's draft-aware guard for \d+ min \(3 retries\): each try stopped before typing anything/);
    expect(notes(f, item.qitemId, "held-sender-notice: sibling@test outcome=")).toHaveLength(1);
    expect(f.submissions.filter(s => s.includes(`Your queue row ${item.qitemId} to worker@test is still held after`) && s.includes("(3 retries)"))).toHaveLength(1);
    expect(typedInto(f, "a")).toEqual([]);
    expect(f.repo.getById(item.qitemId)).toMatchObject({ state: "pending", lastNudgeResult: "retained:draft_aware" });
  });

  it("tells the owner and the sender once about a hold-mode wake past the window, typing nothing into the held seat", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.guard.set("a", { mode: "hold" }, "human@test", "manual terminal");
    f.db.prepare("UPDATE nodes SET runtime='claude-code' WHERE id='b'").run();
    const item = await f.repo.create({ sourceSession: "sibling@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
    const tick = await heldLadder(f, 30);
    await tick();
    expect(notes(f, item.qitemId, "escalation-rung:")).toEqual([]);
    f.db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(new Date(Date.now() - 45 * 60_000).toISOString(), item.qitemId);
    await tick(); await tick();
    expect(notes(f, item.qitemId, "escalation-rung: orchestrator -> orch@test")).toHaveLength(1);
    expect(notes(f, item.qitemId, "escalation-rung:")[0]).toContain("read it with rig seat held-messages worker@test");
    expect(notes(f, item.qitemId, "held-sender-notice: sibling@test outcome=")).toHaveLength(1);
    const told = f.submissions.filter(s => s.includes(`Your queue row ${item.qitemId} to worker@test is held, not lost`));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("rig seat held-messages worker@test");
    expect(typedInto(f, "a")).toEqual([]);
    expect(f.outbox.getById("wake-intent-" + item.qitemId)!.deliveryState).toBe("retained");
  });

  it("tells the owner and the sender once when a draft left in the box gives no idle report, once the window passes", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    f.db.prepare("UPDATE nodes SET runtime='claude-code' WHERE id='b'").run();
    const item = await f.repo.create({ sourceSession: "sibling@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("retained:draft_aware"));
    const tick = await heldLadder(f, 30);
    await tick();
    expect(notes(f, item.qitemId, "escalation-rung:")).toEqual([]);
    f.db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(new Date(Date.now() - 45 * 60_000).toISOString(), item.qitemId);
    await tick(); await tick();
    expect(notes(f, item.qitemId, "escalation-rung: orchestrator -> orch@test")).toHaveLength(1);
    expect(notes(f, item.qitemId, "escalation-rung:")[0]).toContain("held by worker@test's draft-aware guard for 45 min (0 retries)");
    expect(notes(f, item.qitemId, "held-sender-notice: sibling@test outcome=")).toHaveLength(1);
    expect(f.submissions.filter(s => s.includes(`Your queue row ${item.qitemId} to worker@test is still held after 45 min (0 retries)`))).toHaveLength(1);
    expect(notes(f, item.qitemId, "wake-attempt:")).toEqual([]);
    expect(typedInto(f, "a")).toEqual([]);
  });

  it("never retries a draft-held wake once the seat has left draft-aware mode: switching modes replays nothing", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("retained:draft_aware"));
    await f.guard.set("a", { mode: "off" }, "human@test", "guard off");
    f.bodies.a = "";
    await f.repo.retryDraftHeldWakesOnIdle("worker@test", "idle");
    expect(f.outbox.getById("wake-intent-" + item.qitemId)!.deliveryState).toBe("retained");
    expect(notes(f, item.qitemId, "wake-attempt:")).toEqual([]);
    expect(typedInto(f, "a")).toEqual([]);
  });

  it("leaves a handed-off row's draft-held wake to the wake ladder's own retries", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const src = await f.repo.create({ sourceSession: "sender@test", destinationSession: "sibling@test", body: "queued work", nudge: false });
    const { created } = await f.repo.handoff({ qitemId: src.qitemId, fromSession: "sibling@test", toSession: "worker@test" });
    await vi.waitFor(() => expect(f.repo.getById(created.qitemId)!.lastNudgeResult).toBe("retained:draft_aware"));
    f.bodies.a = "";
    await f.repo.retryDraftHeldWakesOnIdle("worker@test", "idle");
    expect(notes(f, created.qitemId, "wake-attempt:")).toEqual([]);
    expect(typedInto(f, "a")).toEqual([]);
  });

  it("sends no typed notice to a sender who is a person; the owner's escalation still goes out", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.guard.set("a", { mode: "hold" }, "human@test", "manual terminal");
    const item = await f.repo.create({ sourceSession: "human@kernel", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
    f.db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(new Date(Date.now() - 45 * 60_000).toISOString(), item.qitemId);
    const tick = await heldLadder(f, 30);
    await tick(); await tick();
    expect(notes(f, item.qitemId, "escalation-rung: orchestrator -> orch@test")).toHaveLength(1);
    expect(notes(f, item.qitemId, "held-sender-notice:")).toEqual([]);
    expect(f.submissions.filter(s => s.includes(`Your queue row ${item.qitemId}`))).toEqual([]);
  });

  // #48: the sender's notice is in the outbox before the owner's rung is marked, so neither a restart between the two nor a
  // send that definitely wrote nothing loses it or marks it told; a send that may have landed is never repeated.
  const heldPastWindow = async (f: ReturnType<typeof fixture>) => {
    await f.guard.set("a", { mode: "hold" }, "human@test", "manual terminal");
    f.db.prepare("UPDATE nodes SET runtime='claude-code' WHERE id='b'").run();
    const item = await f.repo.create({ sourceSession: "sibling@test", destinationSession: "worker@test", body: "queued work" });
    await vi.waitFor(() => expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
    return item;
  };
  const toRung = async (f: ReturnType<typeof fixture>, qitemId: string, tick: () => Promise<unknown>) => {
    await tick();
    f.db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(new Date(Date.now() - 45 * 60_000).toISOString(), qitemId);
    for (let i = 0; i < 3 && notes(f, qitemId, "escalation-rung: orchestrator").length === 0; i++) await tick();
    expect(notes(f, qitemId, "escalation-rung: orchestrator -> orch@test")).toHaveLength(1);
  };
  const toldOf = (f: ReturnType<typeof fixture>, qitemId: string) =>
    f.submissions.filter(s => s.includes(`Your queue row ${qitemId} to worker@test is held, not lost`));

  it("a restart between the owner's rung and the sender's notice leaves the notice owed, and the next daemon sends it once", async () => {
    const f = fixture(undefined, { runtime: "claude-code" });
    const item = await heldPastWindow(f);
    const { runWakeLadderTick } = await import("../src/domain/queue-wake-ladder.js");
    const tickWith = (repo: QueueRepository) => runWakeLadderTick({ db: f.db, queueRepo: repo, retryCap: 3, retryIntervalSeconds: 0,
      unconfirmedWindowMinutes: 30, resolveOrchestrator: () => "orch@test", attemptWake: async () => "verified" });
    // The daemon that stops: the same database and outbox, and it never gets to send (no transport).
    const stopped = new QueueRepository(f.db, new EventBus(f.db), { loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
    stopped.attachOutbox(f.outbox);
    await toRung(f, item.qitemId, () => tickWith(stopped));
    expect(notes(f, item.qitemId, "held-sender-notice:")).toEqual([]);
    expect(toldOf(f, item.qitemId)).toEqual([]);
    expect(f.repo.listOwedHeldSenderNotices()).toEqual([expect.objectContaining({ sender: "sibling@test", qitemId: item.qitemId, state: "pending" })]);
    // The daemon after the restart.
    await tickWith(f.repo); await tickWith(f.repo);
    expect(toldOf(f, item.qitemId)).toHaveLength(1);
    expect(notes(f, item.qitemId, "held-sender-notice: sibling@test outcome=")).toHaveLength(1);
    expect(f.repo.listOwedHeldSenderNotices()).toEqual([]);
    expect(typedInto(f, "a")).toEqual([]);
  });

  it("a sender notice that definitely wrote nothing is recorded as failed, stays owed and goes again; the owner's escalation stands", async () => {
    const f = fixture(undefined, { runtime: "claude-code" });
    const item = await heldPastWindow(f);
    // The sender's seat can't be reached on the first try, before anything is typed (the transport's own no-write shape).
    vi.spyOn(f.transport, "send").mockImplementationOnce(async (session: string) =>
      ({ ok: false, sessionName: session, sent: false, inputPhase: "not_reached", reason: "session_missing", error: "No text was sent." }) as never);
    const tick = await heldLadder(f, 30);
    await toRung(f, item.qitemId, tick);
    expect(notes(f, item.qitemId, "held-sender-notice: sibling@test outcome=")).toEqual([expect.stringContaining("outcome=failed:")]);
    const [owed] = f.repo.listOwedHeldSenderNotices();
    expect(owed).toMatchObject({ sender: "sibling@test", qitemId: item.qitemId, state: "failed" });
    expect(toldOf(f, item.qitemId)).toEqual([]);
    await tick();
    expect(toldOf(f, item.qitemId)).toHaveLength(1);
    expect(notes(f, item.qitemId, "held-sender-notice: sibling@test outcome=")).toHaveLength(2);
    expect(f.outbox.getById(owed!.outboxId)!.deliveryState).not.toMatch(/^(pending|failed|sending)$/);
    await tick();
    expect(toldOf(f, item.qitemId)).toHaveLength(1);
    expect(notes(f, item.qitemId, "escalation-rung: orchestrator -> orch@test")).toHaveLength(1);
    expect(typedInto(f, "a")).toEqual([]);
  });

  it("an owed notice behind more than a page of capped ones is still reached and sent once; the capped ones keep their evidence", async () => {
    const f = fixture(undefined, { runtime: "claude-code" });
    const item = await heldPastWindow(f);
    const { runWakeLadderTick } = await import("../src/domain/queue-wake-ladder.js");
    const { lastMeaningfulTransition } = await import("../src/domain/queue-waiting.js");
    const tickWith = (repo: QueueRepository) => runWakeLadderTick({ db: f.db, queueRepo: repo, retryCap: 3, retryIntervalSeconds: 0,
      unconfirmedWindowMinutes: 30, resolveOrchestrator: () => "orch@test", attemptWake: async () => "verified" });
    // The owed notice: staged at the owner's rung by a daemon that stopped before it could send.
    const stopped = new QueueRepository(f.db, new EventBus(f.db), { loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
    stopped.attachOutbox(f.outbox);
    await toRung(f, item.qitemId, () => tickWith(stopped));
    const [owed] = f.repo.listOwedHeldSenderNotices();
    expect(owed).toMatchObject({ qitemId: item.qitemId, state: "pending" });
    // Ahead of it, 51 older notices whose rows are still held in their episode and whose tries reached the cap (3).
    const ladder = f.repo.listTransitions(item.qitemId).find(t => t.transitionNote?.startsWith("escalation-rung:"))!.actorSession;
    const { ts_dispatched } = f.db.prepare("SELECT ts_dispatched FROM outbox_entries WHERE outbox_id = ?").get(owed!.outboxId) as { ts_dispatched: string };
    const older = new Date(Date.parse(ts_dispatched) - 60_000).toISOString();
    const capped: string[] = [];
    for (let i = 0; i < 51; i++) {
      const row = await f.repo.create({ sourceSession: item.sourceSession, destinationSession: item.destinationSession, body: `older work ${i}`, nudge: false });
      f.db.prepare("UPDATE queue_items SET last_nudge_result = 'retained:typing_guard' WHERE qitem_id = ?").run(row.qitemId);
      const id = f.repo.stageHeldSenderNotice(row.qitemId, lastMeaningfulTransition(f.db, row.qitemId)!.id, item.sourceSession, "older notice")!;
      f.db.prepare("UPDATE outbox_entries SET delivery_state = 'failed', ts_dispatched = ? WHERE outbox_id = ?").run(older, id);
      for (let n = 0; n < 3; n++) f.repo.transitionLog.append({ qitemId: row.qitemId, state: "pending", actorSession: ladder,
        transitionNote: `held-sender-notice: ${item.sourceSession} outcome=failed:session_missing` });
      capped.push(id);
    }
    expect(f.repo.listOwedHeldSenderNotices().map(o => o.outboxId)).not.toContain(owed!.outboxId);
    await tickWith(f.repo); await tickWith(f.repo); await tickWith(f.repo);
    expect(toldOf(f, item.qitemId)).toHaveLength(1);
    expect(notes(f, item.qitemId, `held-sender-notice: ${item.sourceSession} outcome=`)).toHaveLength(1);
    expect(capped.map(id => f.outbox.getById(id)!.deliveryState)).toEqual(capped.map(() => "failed"));
    expect(f.submissions.filter(s => s.includes("older notice"))).toEqual([]);
  });

  it("rechecks queue applicability before paste", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "queued work", nudge: false });
    const id = "wake-intent-" + item.qitemId; f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    f.hooks.load = () => { f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(item.qitemId); };
    await f.repo.drainPendingWakeIntents();
    expect(f.guarded.lookup(id)).toMatchObject({ state: "held", reason: "draft_wake_superseded" });
    expect(f.writes).toEqual([]);
  });

  it.each([false, true])("coalesced wakes preserve every original ID and body (held: %s)", async held => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); if (held) f.bodies.a = "draft"; const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "work " + i, nudge: false });
      f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
      const id = "wake-intent-" + item.qitemId; ids.push(id);
      f.db.prepare("UPDATE outbox_entries SET tags=? WHERE outbox_id=?").run(JSON.stringify(["queue:return:common"]), id);
    }
    const original = ids.map(id => f.outbox.getById(id)!.body);
    await f.repo.drainPendingWakeIntents();
    expect(f.guarded.lookup(ids[1]!)).toEqual(f.guarded.lookup(ids[0]!));
    f.bodies.a = ""; await f.repo.drainPendingWakeIntents();
    expect(f.submissions).toHaveLength(held ? 0 : 1);
    ids.forEach((id, i) => expect(f.outbox.getById(id)).toMatchObject({ body: original[i], deliveryState: held ? "retained" : "delivered" }));
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({ n: 2 });
  });
});


describe("deliberate override preserves existing input", () => {
  const override = { dangerouslyInteract: true, reason: "fixture interaction", verify: false };
  it("keeps explicit terminal interaction draft protection with a native input preference", async () => {
    const f = fixture();
    f.db.prepare("UPDATE nodes SET input_route='native' WHERE id='a'").run();
    f.bodies.a = "person draft";
    expect(await f.send("override-native", "incoming", override)).toMatchObject({ ok: false, sent: false,
      reason: "override_input_present", existingInput: { classification: "typed_or_pasted" } });
    expect(f.writes).toEqual([]);
  });

  it.each(["off", "draft-aware", "hold", "openrig-urgent", "urgent-only", "sends-only", "queue-only"])("stops and shows typed input under %s without retaining it", async mode => {
    const f = fixture();
    await f.guard.set("a", { mode }, "human@test", "fixture policy");
    const draft = "私の下書き😀\n  second line U3-private";
    // Arrives during buffer preparation, so a check before calling the adapter would be too early.
    f.hooks.load = () => { f.bodies.a = draft; };
    const res = await f.post("/api/transport/send", { session: "worker@test", text: "incoming override", ...override });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, sent: false, reason: "override_input_present", existingInput: {
      classification: "typed_or_pasted", rows: draft.split("\n"), suggestionRows: [], fullContentsVisible: true,
      target: { nodeId: "a", occupant: "g1", pane: "%1" }, cursor: expect.objectContaining({ y: 3 }),
    } });
    expect(f.writes).toEqual([]);
    expect(f.bodies.a).toBe(draft);
    expect(f.db.prepare("SELECT count(*) n FROM outbox_entries").get()).toEqual({ n: 0 });
    expect(f.db.serialize().includes(Buffer.from("U3-private"))).toBe(false);
    expect(f.observations).toEqual([]);
  });

  it("stops on a collapsed paste and shows only its label", async () => {
    const f = fixture(); f.bodies.a = "[Pasted text #4 +18 lines]";
    const result = await f.send("override", "incoming", override);
    expect(result).toMatchObject({ ok: false, sent: false, existingInput: { classification: "typed_or_pasted", fullContentsVisible: false } });
    expect(f.writes).toEqual([]);
  });

  it("delivers on unreadable input and reports it as unreadable, never empty", async () => {
    const f = fixture(); f.bodies.a = null;
    const result = await f.send("override", "incoming", override);
    expect(result).toMatchObject({ ok: true, sent: true, existingInput: { classification: "unreadable", fullContentsVisible: false, cleared: false } });
    expect(result.warning).toContain("Input could not be read and was not cleared; this send may join or submit existing text.");
    expect(f.writes).toEqual(["paste:a:incoming"]);
    expect(f.submissions).toEqual([]); // Unreadable input cannot prove the answer staged for Enter.
  });

  it.each(["", "typed"])("separates the suggestion from %j and never stores either", async typed => {
    const f = fixture(); const suggestion = " U3 suggestion private";
    vi.mocked(f.tmux.captureComposerSnapshot).mockResolvedValue({ ...frame(`${typed}\x1b[2m${suggestion}\x1b[22m`),
      cursor: { x: 2 + typed.length, y: 2, width: 240, height: 60 } });
    const result = await f.send("override", "incoming", override);
    expect(result).toMatchObject({ sent: typed === "" ? true : false, existingInput: {
      classification: typed ? "typed_or_pasted" : "suggestion_only", rows: [typed], suggestionRows: [suggestion],
    } });
    expect(f.writes).toEqual(typed ? [] : ["paste:a:incoming"]); // Static suggestion frame never proves this answer staged for Enter.
    expect(f.db.serialize().includes(Buffer.from(suggestion))).toBe(false);
  });

  it("the explicit unchecked option can drive unreadable input without clearing or retaining", async () => {
    const f = fixture(); await f.guard.set("a", { mode: "hold" }, "human@test", "fixture quiet");
    vi.mocked(f.tmux.captureComposerSnapshot).mockResolvedValue(null);
    const result = await f.send("unchecked", "incoming", { ...override, typeWithoutChecking: true } as SendOpts);
    expect(result).toMatchObject({ ok: true, sent: true, existingInput: { classification: "not_checked", cleared: false } });
    expect(f.tmux.captureComposerSnapshot).not.toHaveBeenCalled();
    expect(f.writes).toEqual(["paste:a:incoming"]);
    expect(f.submissions).toEqual([]); // Unreadable input cannot prove the answer staged for Enter.
  });

  it.each(["R1-existing-draft", ""])("broadcast wait plus override checks current input before typing: %j", async draft => {
    const f = fixture(); await f.guard.set("a", { mode: "hold" }, "human@test", "fixture quiet");
    f.bodies.a = draft;
    const response = await f.post("/api/transport/broadcast", { sessions: ["worker@test"], text: "outgoing", ...override, verify: true, waitForIdleMs: 100 });
    expect(response.status).toBe(200);
    const { results } = await response.json();
    expect(results[0]).toMatchObject(draft
      ? { ok: false, sent: false, reason: "override_input_present", existingInput: { rows: [draft], classification: "typed_or_pasted" } }
      : { ok: true, sent: true, existingInput: { classification: "empty" } });
    expect(f.writes).toEqual(draft ? [] : ["paste:a:outgoing"]);
    expect(f.submissions).toEqual([]); // Terminal fixture cannot prove a native answer staged for Enter.
    expect(f.observations).toEqual([]);
    expect(f.db.serialize().includes(Buffer.from("R1-existing-draft"))).toBe(false);
  });

  it("unchecked API requests require explicit interaction and a reason", async () => {
    const f = fixture();
    for (const [route, dangerouslyInteract] of [["send", false], ["broadcast", true]] as const) {
      const response = await f.post(`/api/transport/${route}`, { dangerouslyInteract, session: "worker@test", sessions: ["worker@test"], text: "ordinary", typeWithoutChecking: true });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ reason: "invalid_dangerously_interact" });
    }
    expect(f.writes).toEqual([]);
  });

  it("a recognised native prompt keeps its existing audited interaction", async () => {
    const f = fixture(undefined, { idleHook: false, runtime: "codex" });
    await f.guard.set("a", { mode: "hold" }, "human@test", "fixture quiet");
    vi.mocked(f.tmux.capturePaneContent).mockResolvedValue("Codex update available.\n\n› 1. Update now\n  2. Skip this version\n  3. Remind me later\n\n  gpt-5.5 high · Context [████ ] · ~/example");
    expect(await f.send("native-prompt", "y", override)).toMatchObject({ ok: true, sent: true });
    expect(f.writes).toEqual(["paste:a:y"]);
    const audit = f.db.prepare("SELECT payload FROM events WHERE type='transport.prompt_override'").get() as { payload: string };
    expect(JSON.parse(audit.payload)).not.toHaveProperty("input");
    expect(f.observations).toEqual([]);
  });
});

// #2430 in draft-aware, the mode the issue describes: a seat holds one message per sender, and a draft-aware attempt
// takes its sender's place only once it settles as held.
describe("draft-aware at a full held quota (#2430)", () => {
  const fill = (f: ReturnType<typeof fixture>, sender: string) => {
    const target = f.guard.target("worker@test");
    f.outbox.retain({ outboxId: "older", senderSession: sender, destinationSession: "worker@test", body: "older message" }, target);
    for (let i = 1; i < 100; i++) f.outbox.retain({ outboxId: `filler-${i}`, senderSession: `filler-${i}@test`, destinationSession: "worker@test", body: "held" }, target);
    expect(f.outbox.retentionUsage("a").count).toBe(100);
  };

  it("a queue notification is staged when its sender holds a message there, and takes its place when it's held", async () => {
    // An agent seat: a queue wake is never typed into a terminal seat.
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "unfinished note";
    fill(f, "sender@test");
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "next work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    await f.repo.drainPendingWakeIntents();

    const id = `wake-intent-${item.qitemId}`;
    expect(f.outbox.getById(id)!.deliveryState).toBe("retained");
    expect(f.outbox.coalescedInto(id)).toEqual(["older"]);
    expect(f.outbox.getById("older")).toMatchObject({ deliveryState: "retired", body: "older message" });
    expect(f.outbox.retentionUsage("a").count).toBe(100);
    expect(f.submissions).toEqual([]);
  });

  it("a queue notification from a sender that holds nothing there is still refused at a full quota", async () => {
    const f = fixture(); await f.enable(); f.bodies.a = "unfinished note";
    fill(f, "sender@test");
    const item = await f.repo.create({ sourceSession: "newcomer@test", destinationSession: "worker@test", body: "other work", nudge: false });
    expect(() => f.repo.stageWakeIntent(item.qitemId, "newcomer@test", "worker@test", null, true)).toThrow(/quota/i);
    expect(f.outbox.getById("older")!.deliveryState).toBe("retained");
  });

  it("a send that's held takes its sender's place; one that's delivered never absorbs held messages", async () => {
    const f = fixture(); await f.enable();
    fill(f, "human@test");

    expect(await f.send("delivered")).toMatchObject({ ok: true, sent: true });
    expect(f.outbox.getById("older")!.deliveryState).toBe("retained");
    expect(f.outbox.coalescedInto("delivered")).toEqual([]);

    f.bodies.a = "unfinished note";
    const held = await f.send("held");
    expect(held).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    expect(f.outbox.coalescedInto(held.outboxIds![0]!)).toEqual(["older"]);
    expect(f.outbox.retentionUsage("a").count).toBe(100);
  });
});


describe("#3076: a draft typed between the guard's read and the paste", () => {
  const draft = "Please send it to the team. Also";
  const notice = "[OpenRig watchdog scheduler · policy: periodic-reminder · job: j]\nWake timer fired.";
  const pasted = (f: ReturnType<typeof fixture>) => f.writes.filter(w => w.startsWith("paste:"));
  const setActivity = (f: ReturnType<typeof fixture>, at: () => number | null) => {
    vi.spyOn(f.tmux, "lastClientActivity").mockImplementation(async () => at());
  };

  it("is seen by the re-read after the settle wait: the notice is held and nothing is pasted into the person's input", async () => {
    const f = fixture(undefined, { runtime: "claude-code", appendPaste: true });
    await f.enable();
    const waits: number[] = [];
    // The person starts typing during the guard's wait right before the paste (the first read saw an empty input).
    f.hooks.settle = ms => { waits.push(ms); if (!pasted(f).length) f.bodies.a = draft; };
    const result = await f.send("watchdog-wake", notice, { openrigNotice: true, verify: false });
    expect(result).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    expect(waits[0]).toBe(300);
    expect(pasted(f)).toEqual([]);
    expect(f.submissions).toEqual([]);
    expect(f.bodies.a).toBe(draft);
  });

  it("holds on recent writable-client activity, also activity during the wait, and a later attempt delivers once quiet", async () => {
    const f = fixture(undefined, { runtime: "claude-code", appendPaste: true });
    await f.enable();
    let last: number | null = Date.now() - 1000;
    setActivity(f, () => last);
    const busy = await f.send("wake-1", "Wake timer fired.", { openrigNotice: true, verify: false });
    expect(busy).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });

    last = Date.now() - 60_000;
    f.hooks.settle = () => { last = Date.now(); };   // activity during the settle wait, nothing drawn yet
    f.advance();
    const during = await f.send("wake-2", "Wake timer fired again.", { openrigNotice: true, verify: false });
    expect(during).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    expect(pasted(f)).toEqual([]);

    last = Date.now() - 60_000;
    f.hooks.settle = undefined;
    f.advance();
    const sent = await f.send("wake-3", "Wake timer fired a third time.", { openrigNotice: true, verify: false });
    expect(sent).toMatchObject({ ok: true });
    expect(f.submissions).toHaveLength(1);
  });

  it("counts the quiet window from the end of the whole second tmux reports: 3.5 s ago still holds, 4.5 s ago delivers", async () => {
    const f = fixture(undefined, { runtime: "claude-code", appendPaste: true });
    await f.enable();
    let last = Date.now() - 3500;   // activity at N.999 s reads as N: it may have been 2.5 s ago
    setActivity(f, () => last);
    const held = await f.send("whole-second", "Wake timer fired.", { openrigNotice: true, verify: false });
    expect(held).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    last = Date.now() - 4500;
    f.advance();
    const sent = await f.send("whole-second-later", "Wake timer fired again.", { openrigNotice: true, verify: false });
    expect(sent).toMatchObject({ ok: true });
  });

  it("holds as unreadable when tmux can't report recent writable-client activity; with no writable client it delivers", async () => {
    const f = fixture(undefined, { runtime: "claude-code", appendPaste: true });
    await f.enable();
    vi.spyOn(f.tmux, "lastClientActivity").mockRejectedValue(new Error("PRIVATE_DETAIL command timed out"));
    const held = await f.send("activity-unreadable", notice, { openrigNotice: true, verify: false });
    // The hold carries its own reason, so a caller that keeps the last diagnostic it was given never keeps an older one.
    expect(held).toMatchObject({ sent: false, reason: "draft_input_unknown", inputReadFailure: {
      check: "draft-aware", status: "unknown", confidence: null, reason: "client_activity_unavailable", timedOut: null,
      cursor: { present: false, valid: null, atEnd: null } } });
    expect(JSON.stringify(held.inputReadFailure)).not.toContain("PRIVATE_DETAIL");
    expect(pasted(f)).toEqual([]);
    setActivity(f, () => null);
    f.advance();
    const sent = await f.send("no-client", "Wake timer fired again.", { openrigNotice: true, verify: false });
    expect(sent).toMatchObject({ ok: true });
  });

  it("holds as unreadable when the input can't be read after the wait", async () => {
    const f = fixture(undefined, { runtime: "claude-code", appendPaste: true });
    await f.enable();
    f.hooks.settle = () => { if (!pasted(f).length) f.bodies.a = null; };
    const result = await f.send("unreadable", notice, { openrigNotice: true, verify: false });
    expect(result).toMatchObject({ sent: false, reason: "draft_input_unknown" });
    expect(pasted(f)).toEqual([]);
  });

  it("runs the send's own waiting checks before the guard's last read, so a draft typed while they wait is seen", async () => {
    const f = fixture(undefined, { runtime: "claude-code", appendPaste: true });
    await f.enable();
    // A conditional send's checks await (a conversation lookup); the person types meanwhile. The adapter returns the
    // guard's refusal as its result.
    const result = await f.guard.operation("worker@test", () =>
      f.tmux.sendText("worker@test", notice, undefined, { beforePaste: async () => { f.bodies.a = draft; } }));
    expect(result).toMatchObject({ ok: false, code: "draft_input_busy" });
    expect(pasted(f)).toEqual([]);
    expect(f.bodies.a).toBe(draft);
  });

  it("applies to every automatic input under draft-aware, a deliberate send included, as the empty check already did", async () => {
    const f = fixture(undefined, { runtime: "claude-code", appendPaste: true });
    await f.enable();
    f.hooks.settle = () => { if (!pasted(f).length) f.bodies.a = draft; };
    const result = await f.send("deliberate", "a message from another seat", { verify: false });
    expect(result).toMatchObject({ sent: false, reason: "draft_input_busy" });
    expect(pasted(f)).toEqual([]);
    expect(f.bodies.a).toBe(draft);
  });

  it("the remaining gap: typing after the final check and before the paste leaves the notice beside the draft, never submitted or deleted", async () => {
    const f = fixture(undefined, { runtime: "claude-code", appendPaste: true });
    await f.enable();
    let typed = false;
    // The person types between the guard's last check and tmux's paste: the paste lands after their text.
    f.hooks.paste = () => { if (!typed) { typed = true; f.bodies.a = draft; } };
    const result = await f.send("final-boundary", notice, { openrigNotice: true, verify: false });
    // Contamination: exactly one paste, and the input is the person's text followed by it, nothing removed.
    expect(pasted(f)).toHaveLength(1);
    const staged = pasted(f)[0]!.slice("paste:a:".length);
    expect(f.bodies.a).toBe(draft + staged);
    // Submission: none. No key at all reached the pane (no Enter, C-m or C-u), and the guard says why.
    expect(f.writes.filter(w => w.startsWith("keys:a"))).toEqual([]);
    expect(f.submissions).toEqual([]);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain("draft_input_changed");
  });

  it("checks the activity again after the final read: activity that appears at that read holds the paste", async () => {
    const f = fixture(undefined, { runtime: "claude-code", appendPaste: true });
    await f.enable();
    let last: number | null = Date.now() - 60_000;
    setActivity(f, () => last);
    const real = f.tmux.captureComposerSnapshot.getMockImplementation()!;
    let armed = false;
    f.hooks.settle = () => { armed = true; };
    // The composer still reads empty at the final read, but a writable client has activity right then.
    vi.spyOn(f.tmux, "captureComposerSnapshot").mockImplementation(async (name: string) => {
      const shot = await real(name);
      if (armed) { armed = false; last = Date.now(); }
      return shot;
    });
    const result = await f.send("activity-at-final-read", notice, { openrigNotice: true, verify: false });
    expect(result).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    expect(pasted(f)).toEqual([]);
  });

  it("reads tmux's real list-clients output end to end: an attach in this second holds, a quiet client delivers", async () => {
    const f = fixture(undefined, { runtime: "claude-code", appendPaste: true });
    await f.enable();
    const now = () => Math.floor(Date.now() / 1000);
    f.hooks.clients = () => `1|${now()}\n0|${now()}\n`;   // a viewer tile and a writable client attached this second
    const held = await f.send("attach-now", notice, { openrigNotice: true, verify: false });
    expect(held).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    expect(pasted(f)).toEqual([]);
    f.hooks.clients = () => `1|${now()}\n0|${now() - 10}\n`;   // only the read-only tile is active
    f.advance();
    const sent = await f.send("attach-quiet", "Wake timer fired again.", { openrigNotice: true, verify: false });
    expect(sent).toMatchObject({ ok: true });
  });

  it("re-reads the input after the Enter's own waiting checks, so a draft typed while they wait is not submitted with the notice", async () => {
    const f = fixture(undefined, { runtime: "claude-code", appendPaste: true });
    await f.enable();
    const typed = " PERSONDRAFT-k7";
    const result = await f.guard.operation("worker@test", async () => {
      expect(await f.tmux.sendText("worker@test", notice)).toMatchObject({ ok: true });
      // A conditional Enter awaits its own checks (a conversation lookup); the person types after the pasted notice.
      return f.tmux.sendKeys("worker@test", ["Enter"], undefined, { beforeKeys: async () => { f.bodies.a += typed; } });
    });
    expect(result).toMatchObject({ ok: false, code: "draft_input_changed" });
    expect(f.submissions).toEqual([]);
    expect(f.writes.filter(w => w.startsWith("keys:"))).toEqual([]);
    expect(f.bodies.a).toBe(notice + typed);
  });

  it("still presses the Enter when the input stays as pasted while the Enter's checks wait", async () => {
    const f = fixture(undefined, { runtime: "claude-code", appendPaste: true });
    await f.enable();
    const result = await f.guard.operation("worker@test", async () => {
      expect(await f.tmux.sendText("worker@test", notice)).toMatchObject({ ok: true });
      return f.tmux.sendKeys("worker@test", ["Enter"], undefined, { beforeKeys: async () => {} });
    });
    expect(result).toEqual({ ok: true });
    expect(f.submissions).toEqual([notice]);
    expect(f.bodies.a).toBe("");
  });
});

// #2429: does the guard recognize its own paste once Claude Code has collapsed it? The labels and footer notices below
// are the strings Claude Code 2.1.326 builds (read from its bundle, not from a pane capture): a paste with N line breaks
// shows `[Pasted text #K +N lines]`, and one with none (a single line over 800 characters) shows `[Pasted text #K]`;
// the paste hint takes the mode bar's place for 8 s while the footer's right side keeps its notices, such as the context
// warning (`N% until auto-compact`, `auto-compact is next`, `N% context used`, `Context low (N% remaining)`).
describe("#2429: the guard's own paste after Claude Code collapses it", () => {
  const collapsedUnder = (f: ReturnType<typeof fixture>, text: string, label: string, hint = "paste again to expand", modeBar = "⏵⏵ bypass permissions on (shift+tab to cycle)") =>
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => {
      const staged = f.bodies.a === text;
      const snapshot = frame(staged ? label : f.bodies.a ?? "");
      snapshot.screen = snapshot.screen.replace("? for shortcuts\n", `${staged ? hint : modeBar}\n`);
      return snapshot;
    });

  it("submits its own multi-line envelope collapsed to [Pasted text #1 +N lines]", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const text = wrapPaneEnvelope("sender@test", "worker@test", "Body line one.\nBody line two.");
    collapsedUnder(f, text, `[Pasted text #1 +${text.split("\n").length - 1} lines]`);
    const result = await f.send("collapsed-envelope", text, { verify: false });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([text]);
  });

  it("submits its own single-line paste collapsed to [Pasted text #1], with no line count", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const text = `reminder: ${"x".repeat(1190)}`;
    collapsedUnder(f, text, "[Pasted text #1]");
    const result = await f.send("collapsed-one-line", text, { verify: false });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([text]);
    expect(f.bodies.a).toBe("");
  });

  // The label carries only its paste ID, so one drawn after notePasted's read could be a person's replacement single
  // line: it is held, as on main, while a counted label drawn late is still recognized (the delayed-label test above).
  it("holds a count-less label first drawn after notePasted's read, with no Enter", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const text = `reminder: ${"x".repeat(1190)}`;
    let readsAfterPaste = 0;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () =>
      frame(f.bodies.a === text ? (readsAfterPaste++ === 0 ? "" : "[Pasted text #1]") : f.bodies.a ?? ""));
    const result = await f.send("late-count-less", text, { verify: false });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed" });
    expect(f.writes.filter(write => write.startsWith("keys:"))).toEqual([]);
    expect(f.submissions).toEqual([]);
    expect(f.bodies.a).toBe(text);
  });

  // A count-less label beside literal text is a person's single-line paste, not ours: our own single line collapses to the
  // bare label, and an inline paste draws no label. The text after it matching our head proves nothing, whether the
  // composite is first drawn after notePasted's read or already at it.
  it.each([["after notePasted's read", true], ["at notePasted's read", false]])(
    "holds an unrecorded count-less label followed by our own text, drawn %s, with no Enter", async (_case, late) => {
      const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
      const text = `reminder: ${"x".repeat(24)}`;
      let readsAfterPaste = 0;
      vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () =>
        frame(f.bodies.a === text ? (late && readsAfterPaste++ === 0 ? text : `[Pasted text #2] ${text}`) : f.bodies.a ?? ""));
      const result = await f.send("count-less-composite", text, { verify: false });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed" });
      expect(f.writes.filter(write => write.startsWith("keys:"))).toEqual([]);
      expect(f.submissions).toEqual([]);
    });

  it("submits its own inline text that spells out a count-less label", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const text = `see [Pasted text #2] in the reminder ${"x".repeat(24)}`;
    const result = await f.send("quotes-a-label", text, { verify: false });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([text]);
  });

  it.each([["a single-line label for a multi-line paste", "one\ntwo\nthree", "[Pasted text #1]"],
    ["a counted label for a single-line paste", `reminder: ${"x".repeat(1190)}`, "[Pasted text #1 +2 lines]"]])(
    "does not submit %s", async (_case, text, label) => {
      const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
      collapsedUnder(f, text, label);
      expect(await f.send("collapsed-mismatch", text, { verify: false })).toMatchObject({ ok: false, sent: true });
      expect(f.submissions).toEqual([]);
    });

  it.each(["12% until auto-compact", "auto-compact is next", "40% context used", "Context low (8% remaining)",
    "Context low (8% remaining) · /compact to free up space"])(
    "submits its own collapsed paste when the hint shares the footer with the context notice %s", async notice => {
      const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
      const text = "first line\nsecond line\nlast line";
      collapsedUnder(f, text, "[Pasted text #1 +2 lines]", `paste again to expand${" ".repeat(60)}${notice}`,
        `⏵⏵ bypass permissions on (shift+tab to cycle)${" ".repeat(40)}${notice}`);
      const result = await f.send("context-notice", text, { verify: false });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sent: true });
      expect(f.submissions).toEqual([text]);
    });

  it.each(["12% until auto-compact soon", "Context low (8% remaining) · run /compact", "12 % until auto-compact"])(
    "still holds its paste under an unknown notice beside the hint: %s", async notice => {
      const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
      const text = "first line\nsecond line\nlast line";
      collapsedUnder(f, text, "[Pasted text #1 +2 lines]", `paste again to expand  ${notice}`);
      expect(await f.send("unknown-notice", text, { verify: false })).toMatchObject({ ok: false, sent: true, reason: "draft_input_unknown" });
      expect(f.submissions).toEqual([]);
    });

  // The issue's shape: a periodic reminder longer than the input, collapsed with its line count, while a notice the
  // reader knows on its own row sits at the footer's right.
  const reminder = Array.from({ length: 7 }, (_, i) => `reminder line ${i + 1}: ${"x".repeat(60)}`).join("\n");
  const knownNotices = ["Update available! Run: brew upgrade claude-code", "current: 2.1.326 · latest: 2.1.330 ✔ Update installed · Restart to update",
    "You've used 80% of your weekly limit · resets 4pm (UTC)", "new task? /clear to save 12.3k tokens"];

  it.each(knownNotices)("submits its own pasted reminder when the hint shares the footer with the status notice %s", async notice => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    collapsedUnder(f, reminder, "[Pasted text #1 +6 lines]", `paste again to expand${" ".repeat(40)}${notice}`,
      `⏵⏵ bypass permissions on (shift+tab to cycle)${" ".repeat(40)}${notice}`);
    const result = await f.send("status-notice", reminder, { verify: false });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([reminder]);
  });

  // A count-less label is ours only when notePasted recorded it, so this one needs the hint's frame readable at once.
  it("submits its own single-line reminder collapsed to [Pasted text #1] beside the update banner", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    const text = `reminder: ${"x".repeat(1190)}`;
    collapsedUnder(f, text, "[Pasted text #1]", "paste again to expand  Update available! Run: npm i -g @anthropic-ai/claude-code");
    const result = await f.send("status-notice-one-line", text, { verify: false });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([text]);
  });

  // A notice the reader doesn't know keeps the hint's frame unreadable until the hint goes back to the mode bar. Reads
  // while staged: notePasted's, the Enter's first, then one per re-read; re-read 27 is the last (27 waits of 300 ms, about
  // 8.1 s with the reads).
  it.each([1, 7, 27])("submits its own paste when an unknown notice's hint gives way to the mode bar on re-read %i", async clearsOn => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    let stagedReads = 0;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => {
      const staged = f.bodies.a === reminder;
      const snapshot = frame(staged ? "[Pasted text #1 +6 lines]" : f.bodies.a ?? "");
      const hint = staged && stagedReads++ < clearsOn + 1;
      snapshot.screen = snapshot.screen.replace("? for shortcuts\n", `${hint ? "paste again to expand  ✦ a notice no list has" : "⏵⏵ bypass permissions on (shift+tab to cycle)"}\n`);
      return snapshot;
    });
    const result = await f.send("hint-clears", reminder, { verify: false });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, sent: true });
    expect(f.submissions).toEqual([reminder]);
    expect(stagedReads).toBe(clearsOn + 2);
  });

  // Past the first re-read, a late counted label could be a person's own paste of the same line count at the terminal,
  // which no OpenRig input shows. The same cell with no client activity is re-read 7 above.
  it("holds a same-count label the hint gives way to on re-read 7 when a terminal client was active since the paste", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    let stagedReads = 0;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => {
      const staged = f.bodies.a === reminder;
      // Someone at the terminal is active once our paste is in.
      if (staged) f.hooks.clients = () => `0|${Math.floor(Date.now() / 1000)}\n`;
      const snapshot = frame(staged ? "[Pasted text #1 +6 lines]" : f.bodies.a ?? "");
      const hint = staged && stagedReads++ < 7 + 1;
      snapshot.screen = snapshot.screen.replace("? for shortcuts\n", `${hint ? "paste again to expand  ✦ a notice no list has" : "⏵⏵ bypass permissions on (shift+tab to cycle)"}\n`);
      return snapshot;
    });
    const result = await f.send("active-client", reminder, { verify: false });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, sent: true, reason: "draft_input_unknown" });
    expect(result.error).toContain("a terminal client was active since it was pasted");
    // The hold says its own reason: the input was read, and the client activity is why it isn't taken as ours.
    expect(result).toMatchObject({ inputReadFailure: { check: "draft-aware", status: "text", confidence: null, reason: "client_activity_since_paste",
      timedOut: null, cursor: { present: true, valid: true, atEnd: true } } });
    expect(stagedReads).toBe(7 + 2);
    expect(f.writes.filter(write => write.startsWith("keys:"))).toEqual([]);
    expect(f.bodies.a).toBe(reminder);
    // As when the input can't be read: the paste stays, and with no label recorded for it, the next wake holds it as a draft.
    f.advance();
    expect(await f.send("next-wake", "next work", { verify: false })).toMatchObject({ sent: false, reason: "draft_input_busy" });
    expect(f.writes.filter(write => write.startsWith("keys:"))).toEqual([]);
    expect(f.bodies.a).toBe(reminder);
  });

  it("stops re-reading after about 8 s and leaves its paste unsubmitted when the hint stays", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    let stagedReads = 0;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => {
      const staged = f.bodies.a === reminder;
      if (staged) stagedReads++;
      const snapshot = frame(staged ? "[Pasted text #1 +6 lines]" : f.bodies.a ?? "");
      snapshot.screen = snapshot.screen.replace("? for shortcuts\n", `${staged ? "paste again to expand  ✦ a notice no list has" : "⏵⏵ bypass permissions on (shift+tab to cycle)"}\n`);
      return snapshot;
    });
    expect(await f.send("hint-stays", reminder, { verify: false })).toMatchObject({ ok: false, sent: true, reason: "draft_input_unknown" });
    expect(stagedReads).toBe(2 + 27);
    expect(f.writes.filter(write => write.startsWith("keys:"))).toEqual([]);
    expect(f.bodies.a).toBe(reminder);
  });

  it("does not paste into a person's draft shown above the hint and a known notice", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    f.bodies.a = "a person's unfinished draft";
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => {
      const snapshot = frame(f.bodies.a ?? "");
      snapshot.screen = snapshot.screen.replace("? for shortcuts\n", "paste again to expand  Update available! Run: brew upgrade claude-code\n");
      return snapshot;
    });
    expect(await f.send("draft-under-hint", reminder, { verify: false })).toMatchObject({ outcome: "retained", sent: false, reason: "draft_input_busy" });
    expect(f.writes).toEqual([]);
    expect(f.bodies.a).toBe("a person's unfinished draft");
  });

  it("sends no Enter when the hint gives way to someone else's text during the re-reads", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable();
    let stagedReads = 0;
    vi.mocked(f.tmux.captureComposerSnapshot).mockImplementation(async () => {
      const staged = f.bodies.a === reminder;
      const hint = staged && stagedReads++ < 3;
      const snapshot = frame(staged ? (hint ? "[Pasted text #1 +6 lines]" : "someone else's words") : f.bodies.a ?? "");
      snapshot.screen = snapshot.screen.replace("? for shortcuts\n", `${hint ? "paste again to expand  ✦ a notice no list has" : "⏵⏵ bypass permissions on (shift+tab to cycle)"}\n`);
      return snapshot;
    });
    expect(await f.send("hint-gives-way", reminder, { verify: false })).toMatchObject({ ok: false, sent: true, reason: "draft_input_changed" });
    expect(f.writes.filter(write => write.startsWith("keys:"))).toEqual([]);
    expect(f.submissions).toEqual([]);
  });
});

// Root's selection 1 (standby, 0.7.25): a plain message held only for a draft in the input goes once the input is clear,
// through the same guarded delivery, each message with its own outcome and in order. Only messages first held under this
// behaviour qualify: older held messages, hold-mode messages and system senders' messages stay as they were.
describe("plain messages held for a draft", () => {
  const held = (f: ReturnType<typeof fixture>, sender = "pm@test") => f.db.prepare(
    "SELECT outbox_id, delivery_state, tags FROM outbox_entries WHERE sender_session = ? ORDER BY ts_dispatched, rowid",
  ).all(sender) as Array<{ outbox_id: string; delivery_state: string; tags: string | null }>;
  const tagged = (row: { tags: string | null }) => (JSON.parse(row.tags ?? "[]") as string[]).includes("delivery:draft-eligible");

  it("delivers two different held messages from one sender, each once and in order, when the draft clears", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const first = await f.transport.send("worker@test", "first request", { actorSession: "pm@test" });
    const second = await f.transport.send("worker@test", "second request", { actorSession: "pm@test" });
    expect(first.outcome).toBe("retained"); expect(second.outcome).toBe("retained");
    expect(first.warning).toContain("typed once the input is clear");
    expect(held(f).map(r => [r.delivery_state, tagged(r)])).toEqual([["retained", true], ["retained", true]]);
    f.bodies.a = "";
    await f.repo.deliverDraftHeldMessagesOnIdle("worker@test", "idle");
    expect(held(f).map(r => r.delivery_state)).toEqual(["delivered", "delivered"]);
    const order = f.submissions.map(s => s.includes("first request") ? 1 : s.includes("second request") ? 2 : 0).filter(Boolean);
    expect(order).toEqual([1, 2]);
    await f.repo.deliverDraftHeldMessagesOnIdle("worker@test", "idle");
    expect(f.submissions.filter(s => s.includes("first request") || s.includes("second request"))).toHaveLength(2);
  });

  it("keeps them held while the draft stays, typing nothing over it", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    await f.transport.send("worker@test", "first request", { actorSession: "pm@test" });
    for (let i = 0; i < 3; i++) await f.repo.deliverDraftHeldMessagesOnIdle("worker@test", "idle");
    expect(held(f).map(r => [r.delivery_state, tagged(r)])).toEqual([["retained", true]]);
    expect(f.writes).toEqual([]);
  });

  it("leaves a message held before this behaviour alone (no tag), even with the input clear", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    await f.transport.send("worker@test", "older request", { actorSession: "pm@test" });
    f.db.prepare("UPDATE outbox_entries SET tags = NULL WHERE sender_session = 'pm@test'").run();
    f.bodies.a = "";
    await f.repo.deliverDraftHeldMessagesOnIdle("worker@test", "idle");
    expect(held(f).map(r => r.delivery_state)).toEqual(["retained"]);
    expect(f.writes).toEqual([]);
  });

  it("never delivers a hold-mode message, and doesn't tag it", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.guard.set("a", { mode: "hold" }, "human@test", "manual terminal");
    await f.transport.send("worker@test", "a request", { actorSession: "pm@test" });
    await f.repo.deliverDraftHeldMessagesOnIdle("worker@test", "idle");
    expect(held(f).map(r => [r.delivery_state, tagged(r)])).toEqual([["retained", false]]);
    expect(f.writes).toEqual([]);
  });

  it("tells the seat once when hold mode is released, and types none of the held messages", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.guard.set("a", { mode: "hold" }, "human@test", "manual terminal");
    await f.transport.send("worker@test", "a request", { actorSession: "pm@test" });
    const send = vi.spyOn(f.transport, "send");
    expect((await f.post("/api/seat/set-typing-guard/worker@test", { mode: "off", reason: "back at the keyboard" })).status).toBe(200);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(String(send.mock.calls[0]![1])).toMatch(/^Automatic input is no longer held\. 1 held message was kept for this seat and not delivered: read it with rig seat held-messages /);
    expect(held(f).map(r => r.delivery_state)).toEqual(["retained"]);
    expect((await f.post("/api/seat/set-typing-guard/worker@test", { mode: "draft-aware", reason: "draft mode" })).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("doesn't tag a system sender's held message, which keeps its own schedule", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    await f.transport.send("worker@test", "reminder", { actorSession: "watchdog@system" });
    expect(held(f, "watchdog@system").map(r => [r.delivery_state, tagged(r)])).toEqual([["retained", false]]);
  });
});


describe("standby retained-message accounting under changed conditions", () => {
  it("records legacy full-quota supersession per message instead of claiming the earlier one delivered", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const target = f.guard.target("worker@test");
    f.outbox.retain({ outboxId: "quota-earlier", senderSession: "pm@test", destinationSession: "worker@test", body: "earlier distinct request" }, target);
    for (let i = 1; i < 100; i++) f.outbox.retain({ outboxId: `quota-other-${i}`, senderSession: `other-${i}@test`, destinationSession: "worker@test", body: "held" }, target);
    const result = await f.transport.send("worker@test", "later distinct request", { actorSession: "pm@test" });
    const id = result.outboxIds![0]!;
    expect(result.outcome).toBe("retained");
    expect(f.outbox.getById("quota-earlier")).toMatchObject({ deliveryState: "retired", body: "earlier distinct request", retirementReason: `coalesced into ${id}` });
    expect(f.outbox.coalescedInto(id)).toEqual(["quota-earlier"]);
    expect(f.outbox.getById(id)).toMatchObject({ deliveryState: "retained", body: "later distinct request" });
    expect(f.outbox.retentionUsage("a").count).toBe(100);
    expect(f.submissions).toEqual([]);
  });

  it("does not report custody for the next distinct request when all quota entries are individually eligible", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const target = f.guard.target("worker@test");
    for (let i=0; i<100; i++) f.outbox.retain({ outboxId: `eligible-${i}`, senderSession: "pm@test", destinationSession: "worker@test", body: `distinct request ${i}`, tags: ["delivery:draft-eligible"] }, target, false, { coalesce: false });
    const result=await f.transport.send("worker@test", "one request too many", {actorSession: "pm@test"});
    expect(result).toMatchObject({ok:false,sent:false,outcome:"failed"});
    expect(result.outboxIds).toBeUndefined();
    expect(f.db.prepare("SELECT count(*) AS n FROM outbox_entries WHERE delivery_state='retained'").get()).toMatchObject({n:100});
    expect(f.db.prepare("SELECT count(*) AS n FROM outbox_entries WHERE delivery_state='retired'").get()).toMatchObject({n:0});
    expect(f.submissions).toEqual([]);
  });

  it("keeps earlier-occupant custody listed without blocking a later message for the current occupant", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const old = await f.transport.send("worker@test", "request for original occupant", { actorSession: "pm@test" });
    const oldId = old.outboxIds![0]!;
    f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('new-occupant','a',2,'new-generation','fresh')");
    const current = await f.transport.send("worker@test", "request for current occupant", { actorSession: "pm@test" });
    const currentId = current.outboxIds![0]!; f.bodies.a = "";
    const send = vi.spyOn(f.transport, "send");
    await f.repo.deliverDraftHeldMessagesOnIdle("worker@test", "idle");
    expect([f.outbox.getById(oldId)!.deliveryState, f.outbox.getById(currentId)!.deliveryState]).toEqual(["retained", "delivered"]);
    expect(f.outbox.heldForNode("a").items.map(entry => entry.outboxId)).toContain(oldId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.submissions.filter(text => text.includes("request for original occupant"))).toEqual([]);
    expect(f.submissions.filter(text => text.includes("request for current occupant"))).toHaveLength(1);
  });
});


describe("standby hold-release notice accounting", () => {
  it("emits one notice when two callers concurrently request the same release", async () => {
    const f=fixture(undefined,{runtime:"claude-code"});
    await f.guard.set("a",{mode:"hold"},"human@test","manual input");
    await f.transport.send("worker@test","held request",{actorSession:"pm@test"});
    const send=vi.spyOn(f.transport,"send");
    const responses=await Promise.all([
      f.post("/api/seat/set-typing-guard/worker@test",{mode:"off",reason:"release one"}),
      f.post("/api/seat/set-typing-guard/worker@test",{mode:"off",reason:"release retry"}),
    ]);
    expect(responses.map(r=>r.status)).toEqual([200,200]);
    expect(send.mock.calls.filter(call=>String(call[1]).startsWith("Automatic input is no longer held."))).toHaveLength(1);
    expect(f.db.prepare("SELECT delivery_state FROM outbox_entries WHERE sender_session='pm@test'").get()).toMatchObject({delivery_state:"retained"});
  });
});


describe("standby pending hold-release notice", () => {
  it("notifies after the effective release even when the API initially returns pending", async () => {
    const f=fixture(undefined,{runtime:"claude-code"});
    await f.guard.set("a",{mode:"hold"},"human@test","manual input");
    await f.transport.send("worker@test","held request",{actorSession:"pm@test"});
    let enter!:()=>void, release!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const running=f.guard.operation("worker@test",async()=>{},async()=>{enter();await gate;});
    await entered;
    const send=vi.spyOn(f.transport,"send");
    try {
      const response=await f.post("/api/seat/set-typing-guard/worker@test",{mode:"off",reason:"release while leased"});
      expect(response.status).toBe(202);
      expect(send).not.toHaveBeenCalled();
      release();await running;
      await vi.waitFor(()=>expect(send.mock.calls.filter(call=>String(call[1]).startsWith("Automatic input is no longer held."))).toHaveLength(1));
      expect(f.guard.preference("a")).toMatchObject({effectiveMode:"off",pending:false});
      expect(f.db.prepare("SELECT delivery_state FROM outbox_entries WHERE sender_session='pm@test'").get()).toMatchObject({delivery_state:"retained"});
    } finally {release();await running;}
  });
});


describe("standby retry guard and uncertainty controls", () => {
  it("honours a renewed native-input refusal before retrying a held message", async () => {
    const f=fixture(undefined,{runtime:"claude-code"});await f.enable();f.bodies.a="draft";
    const held=await f.transport.send("worker@test","retained request",{actorSession:"pm@test"});
    const id=held.outboxIds![0]!;f.bodies.a="";
    const before=vi.spyOn(f.guard,"beforeInput").mockRejectedValueOnce(new DeliveryGuardError("target_needs_input","fixture native input needs an answer"));
    await f.repo.deliverDraftHeldMessagesOnIdle("worker@test","idle");
    expect(before).toHaveBeenCalled();expect(f.submissions).toEqual([]);expect(f.writes).toEqual([]);
    expect(f.outbox.getById(id)!.deliveryState).toBe("retained");before.mockRestore();
    await f.repo.deliverDraftHeldMessagesOnIdle("worker@test","idle");
    expect(f.outbox.getById(id)!.deliveryState).toBe("delivered");
    expect(f.submissions.filter(s=>s.includes("retained request"))).toHaveLength(1);
  });

  it("does not request cold start when a plain message retry finds no receiver", async () => {
    const f=fixture(undefined,{runtime:"claude-code"});await f.enable();f.bodies.a="draft";
    const held=await f.transport.send("worker@test","retained request",{actorSession:"pm@test"});
    f.db.exec("UPDATE sessions SET status='exited' WHERE node_id='a'");f.bodies.a="";
    const notify=vi.fn();f.repo.attachWakeWithoutReceiverNotifier(notify);
    vi.spyOn(f.transport,"send").mockResolvedValueOnce({ok:false,sessionName:"worker@test",sent:false,inputPhase:"not_reached",reason:"session_missing"});
    await f.repo.deliverDraftHeldMessagesOnIdle("worker@test","idle");
    expect(f.outbox.getById(held.outboxIds![0]!)!.deliveryState).toBe("failed");
    expect(notify).not.toHaveBeenCalled();expect(f.submissions).toEqual([]);
  });

  it.each([false,true])("keeps an uncertain retry out of replay (thrown=%s)",async throws=>{
    const f=fixture(undefined,{runtime:"claude-code"});await f.enable();f.bodies.a="draft";
    const held=await f.transport.send("worker@test","retained request",{actorSession:"pm@test"});f.bodies.a="";
    const send=vi.spyOn(f.transport,"send");
    if(throws)send.mockRejectedValueOnce(new Error("fixture send ended without a receipt"));
    else send.mockResolvedValueOnce({ok:false,sessionName:"worker@test",sent:true,inputPhase:"written",reason:"delivery_indeterminate"});
    const retry=f.repo.deliverDraftHeldMessagesOnIdle("worker@test","idle");
    if(throws)await expect(retry).rejects.toThrow("fixture send ended without a receipt");else await retry;
    expect(f.outbox.getById(held.outboxIds![0]!)!.deliveryState).toBe("indeterminate");
    await f.repo.deliverDraftHeldMessagesOnIdle("worker@test","idle");expect(send).toHaveBeenCalledTimes(1);
  });
});


describe("standby recipient changes during a retry", () => {
  it.each([false, true])("restores unwritten custody if the recipient changes after selection (already failed=%s)", async alreadyFailed => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const held = await f.transport.send("worker@test", "request for original occupant", { actorSession: "pm@test" });
    const id = held.outboxIds![0]!; f.bodies.a = "";
    const original = f.transport.send.bind(f.transport);
    const send = vi.spyOn(f.transport, "send").mockImplementationOnce(async (session, text, opts) => {
      f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('race-occupant','a',2,'race-generation','fresh')");
      // Conditional transports can finalize a positive pre-input refusal themselves before returning it.
      if (alreadyFailed) f.outbox.finalizeDelivery(id, "failed");
      return original(session, text, opts);
    });
    await f.repo.deliverDraftHeldMessagesOnIdle("worker@test", "idle");
    expect(f.outbox.getById(id)!.deliveryState).toBe("retained");
    expect(f.outbox.heldForNode("a").items.map(entry => entry.outboxId)).toContain(id);
    await f.repo.deliverDraftHeldMessagesOnIdle("worker@test", "idle");
    expect(send).toHaveBeenCalledTimes(1); expect(f.writes).toEqual([]); expect(f.submissions).toEqual([]);
  });
});


describe("standby delivery controls becoming active between messages", () => {
  it.each(["restore", "drain"])("stops before the next message when %s becomes pending during a send", async control => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const first = await f.transport.send("worker@test", "first retained request", { actorSession: "pm@test" });
    const second = await f.transport.send("worker@test", "second retained request", { actorSession: "pm@test" });
    let restorePending = false;
    const repo = new QueueRepository(f.db, new EventBus(f.db), { transport: f.transport,
      hasPendingPostCompactStage: () => restorePending, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
    repo.attachOutbox(f.outbox);
    const drain = new RigDeliveryDrainStore(f.db), jobs = new WatchdogJobsRepository(f.db);
    const rigId = (f.db.prepare("SELECT rig_id FROM nodes WHERE id='a'").get() as { rig_id: string }).rig_id;
    f.bodies.a = "";
    const original = f.transport.send.bind(f.transport);
    vi.spyOn(f.transport, "send").mockImplementationOnce(async (session, text, opts) => {
      const result = await original(session, text, opts);
      if (control === "restore") restorePending = true;
      else drain.begin(rigId, { drainId: "fixture-mid-pass", owner: "human@test", reviewAt: new Date(Date.now() + 60_000).toISOString() }, jobs);
      return result;
    });
    await repo.deliverDraftHeldMessagesOnIdle("worker@test", "idle");
    expect([first, second].map(result => f.outbox.getById(result.outboxIds![0]!)!.deliveryState)).toEqual(["delivered", "retained"]);
    expect(f.submissions.filter(text => text.includes("second retained request"))).toEqual([]);
    restorePending = false;
    if (control === "drain") drain.end(rigId, "fixture-mid-pass", jobs);
    await repo.deliverDraftHeldMessagesOnIdle("worker@test", "idle");
    expect(f.outbox.getById(second.outboxIds![0]!)!.deliveryState).toBe("delivered");
    expect(f.submissions.filter(text => text.includes("second retained request"))).toHaveLength(1);
  });
});


// The architecture round on #3991: one sender keeps at most DRAFT_HELD_PER_SENDER draft-held messages at a seat, past
// which its oldest is coalesced into its newest (#2430's recorded supersession); a full quota says so; OpenRig's own
// senders, the daemon included, are never draft-held.
describe("draft-held messages bounded per sender", () => {
  const rows = (f: ReturnType<typeof fixture>, sender: string) => f.db.prepare(
    "SELECT outbox_id, body, delivery_state, retirement_reason, tags FROM outbox_entries WHERE sender_session = ? ORDER BY ts_dispatched, rowid",
  ).all(sender) as Array<{ outbox_id: string; body: string; delivery_state: string; retirement_reason: string | null; tags: string | null }>;
  const tagged = (row: { tags: string | null }) => (JSON.parse(row.tags ?? "[]") as string[]).includes("delivery:draft-eligible");

  it("keeps one sender's newest messages, coalesces its older ones into the newest, and types only those once the draft clears", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const total = DRAFT_HELD_PER_SENDER + 2;
    const results = [];
    for (let i = 1; i <= total; i++) results.push(await f.transport.send("worker@test", `request ${i}`, { actorSession: "pm@test" }));
    await f.transport.send("worker@test", "another sender's request", { actorSession: "qa@test" });
    const pm = rows(f, "pm@test");
    // The send that took each older one past the bound names it to its sender; the earlier sends supersede nothing.
    expect(results.slice(0, DRAFT_HELD_PER_SENDER).every(r => !r.warning?.includes("supersedes"))).toBe(true);
    expect(results[DRAFT_HELD_PER_SENDER]!.warning).toContain(`This supersedes your earlier held message ${pm[0]!.outbox_id} here (past ${DRAFT_HELD_PER_SENDER} from one sender); it stays readable by ID and won't be typed.`);
    expect(results[DRAFT_HELD_PER_SENDER + 1]!.warning).toContain(`your earlier held message ${pm[1]!.outbox_id} here`);
    // Each older one is coalesced into the message whose arrival took it past the bound, and that message names it.
    expect(pm.slice(0, 2).map(r => [r.delivery_state, r.retirement_reason]))
      .toEqual([["retired", `${COALESCED_INTO}${pm[DRAFT_HELD_PER_SENDER]!.outbox_id}`], ["retired", `${COALESCED_INTO}${pm[DRAFT_HELD_PER_SENDER + 1]!.outbox_id}`]]);
    expect(f.outbox.coalescedInto(pm[DRAFT_HELD_PER_SENDER + 1]!.outbox_id)).toEqual([pm[1]!.outbox_id]);
    expect(pm.slice(2).every(r => r.delivery_state === "retained" && tagged(r))).toBe(true);
    expect(rows(f, "qa@test").map(r => [r.delivery_state, tagged(r)])).toEqual([["retained", true]]);
    f.bodies.a = "";
    await f.repo.deliverDraftHeldMessagesOnIdle("worker@test", "idle");
    const typed = f.submissions.flatMap(text => [...text.matchAll(/request (\d+)/g)].map(m => Number(m[1])));
    expect(typed).toEqual(Array.from({ length: DRAFT_HELD_PER_SENDER }, (_, i) => i + 3));
    expect(f.submissions.filter(text => text.includes("another sender's request"))).toHaveLength(1);
  });

  it("names the quota when a new message can't be held because the seat's held quota is full", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const target = f.guard.target("worker@test");
    for (let i = 0; i < 100; i++) f.outbox.retain({ outboxId: `full-${i}`, senderSession: `other-${i}@test`, destinationSession: "worker@test", body: "held" }, target);
    const result = await f.transport.send("worker@test", "one more request", { actorSession: "pm@test" });
    expect(result).toMatchObject({ ok: false, sent: false, outcome: "failed" });
    expect(result.warning).toContain("held-message quota is full (100 messages or 8 MB)");
    expect(result.warning).toContain("rig seat held-messages worker@test");
    expect(result.warning).not.toContain("bookkeeping is unavailable");
    expect(f.submissions).toEqual([]);
  });

  it("at a full quota with a clear input, says the message was typed and doesn't ask for a retry", async () => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "";
    const target = f.guard.target("worker@test");
    for (let i = 0; i < 100; i++) f.outbox.retain({ outboxId: `full-${i}`, senderSession: `other-${i}@test`, destinationSession: "worker@test", body: "held" }, target);
    const result = await f.transport.send("worker@test", "a request typed anyway", { actorSession: "pm@test" });
    expect(result).toMatchObject({ sent: true });
    expect(f.submissions.filter(text => text.includes("a request typed anyway"))).toHaveLength(1);
    expect(result.warning).toContain("held-message quota is full (100 messages or 8 MB), so no receipt was saved for this message, which was typed. Repeating it may duplicate input.");
    expect(result.warning).not.toContain("then retry");
  });

  it.each(["daemon@kernel", "system:health", "watchdog@system"])("never draft-holds a message from OpenRig's own sender %s", async (sender) => {
    const f = fixture(undefined, { runtime: "claude-code" }); await f.enable(); f.bodies.a = "draft";
    const result = await f.transport.send("worker@test", "a notice", { actorSession: sender });
    expect(result.outcome).toBe("retained");
    expect(result.warning).not.toContain("typed once the input is clear");
    expect(rows(f, sender).map(r => tagged(r))).toEqual([false]);
  });
});
