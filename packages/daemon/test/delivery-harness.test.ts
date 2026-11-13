// The delivery suite's harness pieces that need no real program: the receiver-side oracle, the containment command,
// the input-box reader, the /proc reader, the bank's export and credential scan, and the logging tmux. The real-program
// cells run from packages/test-system/delivery/run.mjs; these tests keep the parts they rely on honest.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// packages/daemon/test -> packages/test-system/delivery/harness
import { arrivedAs, conversation, deliveriesOf, markersIn, orderAndMerge, partWith, seatThread, sha256, Verdict } from "../../test-system/delivery/harness/oracle.mjs";
import { containedArgv } from "../../test-system/delivery/harness/contain.mjs";
import { composerText } from "../../test-system/delivery/harness/screen.mjs";
import { ownsEnviron, parseStat, reapByIdentity } from "../../test-system/delivery/harness/world.mjs";
import { caseContext } from "../../test-system/delivery/harness/case-context.mjs";
import { isRefusal } from "../../test-system/delivery/cases/s3.mjs";
import { recordScreen } from "../../test-system/delivery/harness/screen.mjs";
import { bankCell } from "../../test-system/delivery/harness/evidence.mjs";

const HARNESS = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test-system", "delivery", "harness");
const MARK = "DLV-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*";

// Request-log entries shaped as the stand-ins log them, with bodies shaped as the real programs sent them.
const codexMsg = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
// OpenRig's identity prompt, the first turn every seat gets: it anchors the seat's thread.
const IDENTITY_TEXT = "OpenRig-generated identity context (not a project task):\np-seat@dlv\nOpenRig session identity:\n- rig: dlv\n- pod: p";
const identity = () => codexMsg(IDENTITY_TEXT);
const codexAnswer = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
let seq = 0;
const codexReq = (input: unknown[], thread: string | null = "t1", tools = 13) =>
  ({ seq: ++seq, at: new Date(1_800_000_000_000 + seq * 1000).toISOString(), body: { input, tools: Array(tools).fill({}) }, request: { thread, tools, structuredOutput: tools === 0 } });
const claudeReq = (messages: unknown[], thread = "s1") =>
  ({ seq: ++seq, at: new Date(1_800_000_000_000 + seq * 1000).toISOString(), body: { messages }, request: { thread, tools: 13, structuredOutput: false } });

describe("delivery harness: the receiver-side oracle", () => {
  it("counts each message once when Codex re-requests a running turn with the next message added (recorded D09 shape)", () => {
    const start = [codexMsg("<environment_context/>"), identity(), codexAnswer("ok")];
    const [one, two, three] = ["DLV-D09-one-1", "DLV-D09-two-2", "DLV-D09-three-3"].map((m) => codexMsg(`Delivery check ${m}`));
    const requests = [
      codexReq([...start]),
      codexReq([...start, one]),
      codexReq([...start, one, two]),        // no answer to `one` in between: the running turn, re-requested
      codexReq([...start, one, two, three]),
    ];
    const seen = ["DLV-D09-one-1", "DLV-D09-two-2", "DLV-D09-three-3"].map((m) => deliveriesOf(requests, m).turns);
    expect(seen.map((turns) => turns.length)).toEqual([1, 1, 1]);
    expect(seen.map((turns) => turns[0]!.seq)).toEqual([requests[1]!.seq, requests[2]!.seq, requests[3]!.seq]);
    expect(seen.map((turns) => markersIn(turns[0]!, MARK))).toEqual([["DLV-D09-one-1"], ["DLV-D09-two-2"], ["DLV-D09-three-3"]]);
    expect(seen[0]![0]!.carriedBy).toBe(3);
  });

  it("doesn't count a side request in another thread that quotes the message (Codex's task title)", () => {
    const msg = codexMsg("Delivery check DLV-D01-x-1");
    const requests = [codexReq([identity(), msg]), codexReq([codexMsg("Generate a title for: Delivery check DLV-D01-x-1")], null, 0)];
    expect(seatThread(requests)).toBe("t1");
    expect(deliveriesOf(requests, "DLV-D01-x-1").turns).toHaveLength(1);
  });

  it("counts a message twice when the program really submitted it twice", () => {
    const msg = codexMsg("Delivery check DLV-D01-dup-1");
    const requests = [codexReq([identity(), msg]), codexReq([identity(), msg, codexAnswer("ack"), msg])];
    expect(deliveriesOf(requests, "DLV-D01-dup-1").turns).toHaveLength(2);
  });

  it("counts a retried request once", () => {
    const body = [identity(), codexMsg("Delivery check DLV-D01-retry-1")];
    const requests = [codexReq(body), codexReq(body)];
    expect(deliveriesOf(requests, "DLV-D01-retry-1").turns).toHaveLength(1);
  });

  it("finds a message typed during a tool run beside the tool's result (Claude), and never counts a tool's output", () => {
    const first = { role: "user", content: [{ type: "text", text: IDENTITY_TEXT }, { type: "text", text: "start DLV-D02-first-1" }] };
    const tool = { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] };
    const result = { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "echo DLV-D02-quoted-1" }, { type: "text", text: "now DLV-D02-second-1" }] };
    const requests = [claudeReq([first]), claudeReq([first, tool, result])];
    const second = deliveriesOf(requests, "DLV-D02-second-1").turns;
    expect(second).toHaveLength(1);
    expect(second[0]!.kind).toBe("tool_result");
    expect(deliveriesOf(requests, "DLV-D02-quoted-1").turns).toHaveLength(0);
  });

  it("reads two sends in one item as a merge, and checks the bytes of the part that holds the marker", () => {
    const merged = { role: "user", content: [{ type: "text", text: "a DLV-D09-a-1" }, { type: "text", text: "b DLV-D09-b-2" }] };
    const start = { role: "user", content: [{ type: "text", text: IDENTITY_TEXT }] };
    const [item] = deliveriesOf([claudeReq([start, merged])], "DLV-D09-a-1").turns;
    expect(markersIn(item!, MARK)).toEqual(["DLV-D09-a-1", "DLV-D09-b-2"]);
    expect(partWith(item!, "DLV-D09-b-2", "b DLV-D09-b-2").intact).toBe(true);
    expect(partWith(item!, "DLV-D09-b-2", "b\tDLV-D09-b-2").intact).toBe(false);
    expect(conversation([claudeReq([start, merged])]).items).toHaveLength(2);
  });

  it("finds no conversation, rather than an empty one, when no request carries OpenRig's identity prompt", () => {
    const requests = [codexReq([codexMsg("Delivery check DLV-D01-q-1")])];
    expect(seatThread(requests)).toBeNull();
    expect(conversation(requests)).toMatchObject({ identified: false, items: [] });
    expect(deliveriesOf(requests, "DLV-D01-q-1")).toMatchObject({ identified: false, turns: [] });
  });

  it("leaves the conversation unidentified when two threads carry OpenRig's identity prompt, rather than taking the first", () => {
    const requests = [codexReq([identity(), codexMsg("Delivery check DLV-D01-a-1")], "t1"), codexReq([identity(), codexMsg("Delivery check DLV-D01-a-1")], "t2")];
    expect(seatThread(requests)).toBeNull();
    expect(conversation(requests)).toMatchObject({ identified: false, anchored: ["t1", "t2"] });
  });

  it("never reads a same-thread request without tools, or one asking for a JSON-schema answer, as the conversation", () => {
    // A Claude Code side request can carry the seat's session id with no tools; its history isn't the seat's.
    const start = { role: "user", content: [{ type: "text", text: IDENTITY_TEXT }] };
    const msg = { role: "user", content: [{ type: "text", text: "Delivery check DLV-D01-side-1" }] };
    const side = { ...claudeReq([{ role: "user", content: [{ type: "text", text: "Summarize: Delivery check DLV-D01-side-1 DLV-D01-side-1" }] }]),
      request: { thread: "s1", tools: 0, structuredOutput: false } };
    const schema = { ...claudeReq([start, msg, msg]), request: { thread: "s1", tools: 13, structuredOutput: true } };
    const requests = [claudeReq([start]), claudeReq([start, msg]), side, schema];
    const { turns } = deliveriesOf(requests, "DLV-D01-side-1");
    expect(turns).toHaveLength(1);
    expect(conversation(requests).lastSeq).toBe(requests[1]!.seq);
  });

  it("judges order and merge by the items' positions, so two messages first seen in one request are neither merged nor out of order", () => {
    const start = [identity(), codexAnswer("ok")];
    const [one, two, three] = ["DLV-D09-one-1", "DLV-D09-two-2", "DLV-D09-three-3"].map((m) => codexMsg(`Delivery check ${m}`));
    const requests = [codexReq([...start]), codexReq([...start, one]), codexReq([...start, one, two, three])]; // two and three arrive together
    const judged = orderAndMerge(requests, ["DLV-D09-one-1", "DLV-D09-two-2", "DLV-D09-three-3"], MARK);
    expect(judged.merged).toEqual([]);
    expect(judged.inOrder).toBe(true);
    expect(judged.first.map((t) => t!.seq)).toEqual([requests[1]!.seq, requests[2]!.seq, requests[2]!.seq]);
    // A real merge is two markers inside one item.
    const both = codexMsg("Delivery check DLV-D09-one-1 and DLV-D09-two-2");
    const mergedRun = orderAndMerge([codexReq([...start, both])], ["DLV-D09-one-1", "DLV-D09-two-2"], MARK);
    expect(mergedRun.merged).toHaveLength(1);
    expect(mergedRun.inOrder).toBe(false);
  });

  it("credits a listed program transform only when its exact inverse restores OpenRig's written bytes, on a listed version", () => {
    const body = "line one\n\tindented with a tab DLV-D15-t-1";
    const wire = `From: x\n---\n${body}\n---`;
    const part = { text: wire.replace("\t", "    ") };
    const known = { kind: "claude", version: "2.1.322", wireSha256s: [sha256(wire)] };
    expect(arrivedAs(part, body, known)).toMatchObject({ intact: true, transform: "claude-code-tab-expansion", restoredSha256: sha256(wire) });
    // Exact bytes need no transform.
    expect(arrivedAs({ text: wire }, body, known)).toEqual({ intact: true, transform: null });
    // Not without OpenRig's record of what it wrote, not on another version or program, not for another difference.
    expect(arrivedAs(part, body, { ...known, wireSha256s: [] }).intact).toBe(false);
    expect(arrivedAs(part, body, { ...known, version: "2.1.311" }).intact).toBe(false);
    expect(arrivedAs(part, body, { ...known, kind: "codex" }).intact).toBe(false);
    expect(arrivedAs({ text: wire.replace("\t", "  ") }, body, known).intact).toBe(false);
    const v = new Verdict();
    v.check("a", true, null);
    v.transformed("claude-code-tab-expansion");
    expect(v.result).toBe("PASS (program transform: claude-code-tab-expansion)");
    v.check("b", false, null);
    expect(v.result).toBe("FAIL");
  });

  it("judges PASS only when every check holds, and keeps NOT RUN's reason", () => {
    const v = new Verdict();
    v.check("a", true, null); v.info("note", 1);
    expect(v.result).toBe("PASS");
    v.check("b", false, { seen: 1 });
    expect(v.toJSON()).toMatchObject({ result: "FAIL", failed: ["b"] });
    const n = new Verdict(); n.skip("no program");
    expect(n.toJSON()).toMatchObject({ result: "NOT RUN", reason: "no program" });
  });
});

describe("delivery harness: the cell's surroundings", () => {
  it("contains a cell in a loopback-only namespace, then maps back to this user", () => {
    const argv = containedArgv(["node", "x.mjs", "a b"]);
    expect(argv.slice(0, 5)).toEqual(["unshare", "--user", "--map-root-user", "--net", "--"]);
    expect(argv[7]).toContain("ip link set lo up && exec unshare --user");
    expect(argv[7]).toContain(`--map-user=${process.getuid!()}`);
    // The command is passed through as arguments, never spliced into the shell text.
    expect(argv.slice(-3)).toEqual(["node", "x.mjs", "a b"]);
  });

  it("reads the input box of each program from a screen (recorded frames)", () => {
    const claude = ["● ok", "", "──────────── p-seat@dlv ─", "❯ half typed DLV-D03-draft-1 by a person", "──────────────────", "  ⏵⏵ accept edits on"].join("\n");
    expect(composerText("claude", claude)).toBe("half typed DLV-D03-draft-1 by a person");
    const codex = ["› From: someone", "• ok DLV-x", "", "› half typed words", "", "  stand-in default · /w"].join("\n");
    expect(composerText("codex", codex)).toBe("half typed words");
    expect(composerText("claude", "no prompt here")).toBeNull();
  });

  it("owns a process only by an exact HOME or tmux-socket entry in its environment", () => {
    const identity = { home: "/c/home", sockets: "/tmp/dlv-x" };
    expect(ownsEnviron("PATH=/bin\0HOME=/c/home\0", identity)).toBe(true);
    expect(ownsEnviron("TMUX_TMPDIR=/tmp/dlv-x\0HOME=/elsewhere", identity)).toBe(true);
    expect(ownsEnviron("XHOME=/c/home\0HOME=/elsewhere", identity)).toBe(false);
    expect(ownsEnviron("HOME=/c/home/sub", identity)).toBe(false);
  });

  it("never offers an old screen as the current one once a capture fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-screen-"));
    let fail = false;
    const cell = { session: "s", tmux: async (args: string[]) => { if (fail) throw new Error("no server"); return args[0] === "capture-pane" ? "screen A" : "0\t80x24"; } };
    const rec = recordScreen(cell, join(dir, "frames.jsonl"), { everyMs: 20 });
    try {
      await new Promise((r) => setTimeout(r, 80));
      expect(rec.last()?.screen).toBe("screen A");
      fail = true;
      await new Promise((r) => setTimeout(r, 80));
      expect(rec.last()).toBeNull();
      expect(rec.failures()).toBeGreaterThan(0);
    } finally { await rec.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("makes a cell NOT RUN, never a verdict, when it can't observe the screen or read the input box after an action", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-observe-"));
    let screen: string | null = "no prompt row here";
    const cell = { session: "s", logs: dir, record: () => {}, standIn: { requests: () => [] },
      tmux: async (args: string[]) => { if (screen === null) throw new Error("no server"); return args[0] === "capture-pane" ? screen : "0\t80x24"; } };
    const ctx = caseContext(cell, { caseId: "T", kind: "claude", version: "x" });
    try {
      await expect(ctx.readComposer()).rejects.toMatchObject({ notRun: true, message: expect.stringMatching(/input box couldn't be read/) });
      screen = "● ok\n────────\n❯ typed text\n────────";
      expect(await ctx.readComposer()).toBe("typed text");
      expect(await ctx.settle({ quietMs: 50, timeoutMs: 2000 })).toBe(true);
      screen = null;
      await new Promise((r) => setTimeout(r, 400));
      await expect(ctx.observe({ timeoutMs: 300 })).rejects.toMatchObject({ notRun: true });
      await expect(ctx.settle({ quietMs: 50, timeoutMs: 300 })).rejects.toMatchObject({ notRun: true, message: expect.stringMatching(/no screen observation/) });
    } finally { await ctx.screen.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("credits a capture with its start, so one begun before an action never counts as after it, however late it finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-capture-order-"));
    let screen = "● ok\n────────\n❯ PRE\n────────";
    let actionAt: number | null = null;
    let armed = false;
    const cell = { session: "s", logs: dir, record: () => {}, standIn: { requests: () => [] },
      tmux: async (args: string[]) => {
        if (args[0] === "capture-pane") {
          const content = screen;
          // The action happens while this capture is in flight: after its content was read, before its state read.
          if (armed && actionAt === null) { actionAt = performance.now(); screen = "● ok\n────────\n❯ POST\n────────"; }
          return content;
        }
        await new Promise((r) => setTimeout(r, 300)); // a slow display-message
        return "0\t80x24";
      } };
    const ctx = caseContext(cell, { caseId: "T", kind: "claude", version: "x" });
    try {
      expect(await ctx.readComposer()).toBe("PRE");
      armed = true;
      while (actionAt === null) await new Promise((r) => setTimeout(r, 10));
      expect(await ctx.readComposer({ after: actionAt, timeoutMs: 3000 })).toBe("POST");
    } finally { await ctx.screen.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports a cell's processes that survive SIGKILL or refuse a signal, and keeps the socket dir while any survive", async () => {
    const sockets = mkdtempSync("/tmp/dlv-test-reap-");
    const signals: string[] = [];
    const quick = { pause: async () => {} };
    try {
      // One survives everything, one refuses signals, one is already gone (ESRCH isn't a failure).
      const survivor = await reapByIdentity({ home: "/x", sockets }, { ...quick, list: () => [{ pid: 11, comm: "tmux: server" }],
        kill: (pid: number, sig: string) => { signals.push(`${pid}:${sig}`); } });
      expect(signals).toEqual(["11:SIGTERM", "11:SIGKILL"]);
      expect(survivor.unresolved).toEqual([{ pid: 11, comm: "tmux: server" }]);
      expect(existsSync(sockets)).toBe(true);
      let calls = 0;
      const refused = await reapByIdentity({ home: "/x", sockets }, { ...quick, list: () => (calls++ < 1 ? [{ pid: 12, comm: "node" }] : []),
        kill: () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); } });
      expect(refused.unresolved).toEqual([{ pid: 12, comm: "node", error: "SIGTERM: EPERM" }]);
      let gone = 0;
      const clean = await reapByIdentity({ home: "/x", sockets }, { ...quick, list: () => (gone++ < 1 ? [{ pid: 13, comm: "claude" }] : []),
        kill: () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); } });
      expect(clean.unresolved).toEqual([]);
      expect(existsSync(sockets)).toBe(false);
    } finally { rmSync(sockets, { recursive: true, force: true }); }
  });

  it("takes only the contract's refusal at a dialog as a refusal", () => {
    expect(isRefusal({ ok: false, sent: false, reason: "target_needs_input" })).toBe(true);
    expect(isRefusal({ ok: false, sent: false, reason: "daemon_unreachable" })).toBe(false);
    expect(isRefusal({ ok: false, reason: "target_needs_input" })).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });

  it("reads a process's name and parent from /proc stat even when the name holds parentheses and spaces", () => {
    expect(parseStat(7, "7 (a) b (c)) S 3 7 7 0 -1")).toEqual({ pid: 7, comm: "a) b (c)", state: "S", ppid: 3 });
  });

  it("logs each tmux call's argv and then runs the real tmux", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-tmux-"));
    try {
      const log = join(dir, "argv.jsonl");
      const real = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
      if (!real) return; // no tmux on this host: nothing to wrap
      const r = spawnSync(join(HARNESS, "tmux"), ["-V"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", DELIVERY_REAL_TMUX: real, DELIVERY_TMUX_LOG: log, DELIVERY_ARM: "t" } });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^tmux /);
      const [entry] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(entry).toMatchObject({ arm: "t", argv: [real, "-V"] });
      expect(Object.keys(entry).sort()).toEqual(["argv", "arm", "cwd", "monotonicNs", "pid", "timeNs"]);
      // A relative path is refused rather than guessed.
      expect(spawnSync(join(HARNESS, "tmux"), ["-V"], { env: { PATH: "/usr/bin:/bin", DELIVERY_REAL_TMUX: "tmux", DELIVERY_TMUX_LOG: log, DELIVERY_ARM: "t" } }).status).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("types an armed draft into exactly the armed pane, once, and shows it before letting the paste run", () => {
    const real = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
    if (!real) return; // no tmux on this host
    // The tmux server's socket goes where this run may reach it: CI's macOS sandbox allows socket connects only under
    // TMUX_TMPDIR. Kept short for the socket path limit, as the repo's other native tmux tests do.
    const sockets = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? (process.platform === "darwin" ? "/private/tmp" : tmpdir()), "dlv-test-")));
    const dir = mkdtempSync(join(tmpdir(), "delivery-inject-"));
    const env = { PATH: "/usr/bin:/bin", TMUX_TMPDIR: sockets, DELIVERY_REAL_TMUX: real, DELIVERY_TMUX_LOG: join(dir, "argv.jsonl"), DELIVERY_ARM: "t", DELIVERY_INJECT_DIR: dir };
    const tmux = (...args: string[]) => spawnSync(real, args, { encoding: "utf8", env });
    const wrapped = (...args: string[]) => spawnSync(join(HARNESS, "tmux"), args, { encoding: "utf8", env });
    try {
      // The setup must hold before the wrapper is judged: a tmux that can't start fails here, not as a paste.
      expect(tmux("new-session", "-d", "-s", "s", "-x", "80", "-y", "10", "cat")).toMatchObject({ status: 0, stderr: "" });
      const pane = tmux("display-message", "-p", "-t", "s", "#{pane_id}").stdout.trim();
      expect(pane).toMatch(/^%\d+$/);
      expect(tmux("set-buffer", "-b", "openrig_t_1", "NOTICE-TEXT")).toMatchObject({ status: 0, stderr: "" });
      expect(tmux("set-buffer", "-b", "other_1", "OTHER")).toMatchObject({ status: 0, stderr: "" });
      writeFileSync(join(dir, "arm.json"), JSON.stringify({ pane, text: "DRAFT-TEXT", bufferPrefix: "openrig_" }));
      // A paste from another buffer leaves the arm in place.
      expect(wrapped("paste-buffer", "-t", pane, "-b", "other_1")).toMatchObject({ status: 0, stderr: "" });
      expect(existsSync(join(dir, "fired.json"))).toBe(false);
      expect(existsSync(join(dir, "arm.json"))).toBe(true);
      expect(wrapped("paste-buffer", "-t", pane, "-b", "openrig_t_1").status).toBe(0);
      const fired = JSON.parse(readFileSync(join(dir, "fired.json"), "utf8"));
      expect(fired).toMatchObject({ target: pane, buffer: "openrig_t_1", text: "DRAFT-TEXT", visible: true });
      expect(fired.screenBeforePaste).toContain("DRAFT-TEXT");
      expect(fired.screenBeforePaste).not.toContain("NOTICE-TEXT");
      expect(existsSync(join(dir, "arm.json"))).toBe(false);
      // Once: a second paste types nothing more.
      tmux("set-buffer", "-b", "openrig_t_2", "SECOND");
      expect(wrapped("paste-buffer", "-t", pane, "-b", "openrig_t_2").status).toBe(0);
      const screen = tmux("capture-pane", "-p", "-t", pane).stdout;
      expect(screen.match(/DRAFT-TEXT/g)).toHaveLength(1);
      expect(screen).toContain("NOTICE-TEXT");
    } finally {
      tmux("kill-server");
      rmSync(sockets, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run into an --out that already holds a run, so no earlier verdict can be read as this run's", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-out-"));
    try {
      writeFileSync(join(dir, "RESULT.json"), "{}");
      const r = spawnSync(process.execPath, [join(HARNESS, "..", "run.mjs"), "run", "--out", dir, "--openrig", "/nonexistent"], { encoding: "utf8" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/already holds a run/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("banks the daemon's tables without credential-like columns, and flags credential-shaped text", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-bank-"));
    try {
      const home = join(dir, "home");
      const openrigHome = join(home, ".openrig");
      const logs = join(dir, "logs");
      for (const d of [openrigHome, logs]) spawnSync("mkdir", ["-p", d]);
      const db = new DatabaseSync(join(openrigHome, "openrig.sqlite"));
      db.exec("CREATE TABLE events (seq INTEGER, type TEXT, payload TEXT, created_at TEXT, auth_token TEXT)");
      db.prepare("INSERT INTO events VALUES (1, 'transport.delivery_evidence', ?, '2026-11-12 16:00:00', 'secret-value')").run(JSON.stringify({ wireSha256: "ab", written: "submitted" }));
      db.close();
      spawnSync("sh", ["-c", `printf '%s\\n' '{"leak":"sk-ant-api03-AAAAAAAAAAAAAAAAAAAA"}' > ${join(logs, "stand-in.jsonl")}`]);
      const cell = { root: dir, home, logs, env: { OPENRIG_HOME: openrigHome, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") } };
      const manifest = bankCell(cell, join(dir, "bank"));
      const tables = JSON.parse(readFileSync(join(dir, "bank", "daemon-tables.json"), "utf8"));
      expect(tables.events.dropped).toEqual(["auth_token"]);
      expect(JSON.stringify(tables)).not.toContain("secret-value");
      expect(JSON.parse(readFileSync(join(dir, "bank", "delivery-events.json"), "utf8"))).toMatchObject([{ type: "transport.delivery_evidence", payload: { wireSha256: "ab" } }]);
      expect(manifest.credentialScan).toEqual({ clean: false, files: ["stand-in.jsonl"] });
      expect(manifest.files.every((f: { sha256: string }) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
