// The delivery suite's harness pieces that need no real program: the receiver-side oracle, the containment command,
// the input-box reader, the /proc reader, the bank's export and credential scan, and the logging tmux. The real-program
// cells run from packages/test-system/delivery/run.mjs; these tests keep the parts they rely on honest.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// packages/daemon/test -> packages/test-system/delivery/harness
import { conversation, deliveriesOf, markersIn, partWith, seatThread, Verdict } from "../../test-system/delivery/harness/oracle.mjs";
import { containedArgv } from "../../test-system/delivery/harness/contain.mjs";
import { composerText } from "../../test-system/delivery/harness/screen.mjs";
import { parseStat } from "../../test-system/delivery/harness/world.mjs";
import { bankCell } from "../../test-system/delivery/harness/evidence.mjs";

const HARNESS = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test-system", "delivery", "harness");
const MARK = "DLV-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*";

// Request-log entries shaped as the stand-ins log them, with bodies shaped as the real programs sent them.
const codexMsg = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const codexAnswer = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
let seq = 0;
const codexReq = (input: unknown[], thread: string | null = "t1", tools = 13) =>
  ({ seq: ++seq, at: new Date(1_800_000_000_000 + seq * 1000).toISOString(), body: { input, tools: Array(tools).fill({}) }, request: { thread, tools, structuredOutput: tools === 0 } });
const claudeReq = (messages: unknown[], thread = "s1") =>
  ({ seq: ++seq, at: new Date(1_800_000_000_000 + seq * 1000).toISOString(), body: { messages }, request: { thread, tools: 13, structuredOutput: false } });

describe("delivery harness: the receiver-side oracle", () => {
  it("counts each message once when Codex re-requests a running turn with the next message added (recorded D09 shape)", () => {
    const start = [codexMsg("<environment_context/>"), codexMsg("startup"), codexAnswer("ok")];
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
    const requests = [codexReq([msg]), codexReq([codexMsg("Generate a title for: Delivery check DLV-D01-x-1")], null, 0)];
    expect(seatThread(requests)).toBe("t1");
    expect(deliveriesOf(requests, "DLV-D01-x-1").turns).toHaveLength(1);
  });

  it("counts a message twice when the program really submitted it twice", () => {
    const msg = codexMsg("Delivery check DLV-D01-dup-1");
    const requests = [codexReq([msg]), codexReq([msg, codexAnswer("ack"), msg])];
    expect(deliveriesOf(requests, "DLV-D01-dup-1").turns).toHaveLength(2);
  });

  it("counts a retried request once", () => {
    const body = [codexMsg("Delivery check DLV-D01-retry-1")];
    const requests = [codexReq(body), codexReq(body)];
    expect(deliveriesOf(requests, "DLV-D01-retry-1").turns).toHaveLength(1);
  });

  it("finds a message typed during a tool run beside the tool's result (Claude), and never counts a tool's output", () => {
    const first = { role: "user", content: [{ type: "text", text: "start DLV-D02-first-1" }] };
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
    const [item] = deliveriesOf([claudeReq([merged])], "DLV-D09-a-1").turns;
    expect(markersIn(item!, MARK)).toEqual(["DLV-D09-a-1", "DLV-D09-b-2"]);
    expect(partWith(item!, "DLV-D09-b-2", "b DLV-D09-b-2").intact).toBe(true);
    expect(partWith(item!, "DLV-D09-b-2", "b\tDLV-D09-b-2").intact).toBe(false);
    expect(conversation([claudeReq([merged])]).items).toHaveLength(1);
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
