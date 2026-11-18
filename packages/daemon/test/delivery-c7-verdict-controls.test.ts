// Scripted receiver/state observations exercise the registered cases and real Verdict.
// These controls test fixture judgments, not a native compaction or delivery.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CASES as D12 } from "../../test-system/delivery/cases/d12.mjs";
import { CASES as C7 } from "../../test-system/delivery/cases/c7-0719.mjs";
import { Verdict } from "../../test-system/delivery/harness/oracle.mjs";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function world() {
  const root = mkdtempSync(join(tmpdir(), "c7-verdict-")); roots.push(root);
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return { root, now: () => now, sleep: async (ms: number) => { now += ms; } };
}
const TEXT = {
  prep: "Write this attempt's complete restore map",
  summary: "Respond with TEXT ONLY",
  compact: "<command-name>/compact</command-name>",
  boundary: "OpenRig post-compaction turn boundary",
  restore: "Please respond to this normal user message now by restoring",
  audit: "Now audit your compaction restore",
};
type Step = keyof typeof TEXT;
const ORDER = ["preparing", "compact-sent", "restore-sent", "audit-sent"];
async function compaction(id: string, { missing = [], stages = ORDER, duplicate }: {
  missing?: Step[]; stages?: string[]; duplicate?: Step;
} = {}) {
  const w = world(), verdict = new Verdict();
  let triggered = false, released = false, answered = false, read = 0;
  let draft = "";
  const requests = Object.entries(TEXT).filter(([key]) => !missing.includes(key as Step)).map(([key, text], index) => ({
    key, seq: index + 1, turn: { parts: [{ text }] },
  }));
  if (duplicate) requests.push({ key: duplicate, seq: requests.length + 1, turn: { parts: [{ text: TEXT[duplicate] }] } });
  const ctx = {
    verdict, nowNs: w.now, sleep: w.sleep,
    cell: {
      session: "fixture@dlv", logs: w.root, env: { OPENRIG_HOME: w.root },
      standIn: { release: () => { released = true; } },
      rig: async (args: string[]) => {
        let value: unknown = {};
        if (args[0] === "ps") value = [{ contextUsage: { availability: id === "D12-E" ? "unavailable" : "known" } }];
        if (args[0] === "compact") {
          if (!args.includes("--state")) triggered = true;
          else if (id === "D12-D" && !answered) value = { stage: "preparing", preparation: { awaitingInput: { current: true } } };
          else value = { stage: stages[Math.min(read++, stages.length - 1)] };
        }
        return { exit: 0, stdout: JSON.stringify(value), stderr: "" };
      },
    },
    requests: () => {
      if (!triggered) return [];
      if (id === "D12-D" && !answered) return requests.filter((r) => r.key === "prep");
      if (id === "D12-Bd-restore" && !released) return requests.filter((r) => ["prep", "summary"].includes(r.key));
      if (id === "D12-Bd-compact" && !released) return [
        ...requests.filter((r) => r.key === "prep"),
        { key: "map", seq: 99, turn: { parts: [{ text: "File created successfully at: RESTORE-MAP.md.tmp" }] } },
      ];
      return requests;
    },
    paneWrites: () => [], settle: async () => {},
    typeDraft: async (text: string) => { draft = text; }, readComposer: async () => draft,
    waitScreen: async () => true, waitScreenAny: async () => "Do you want to proceed?",
    personKeys: async () => { answered = true; },
  };
  await D12.find((c) => c.id === id)!.run(ctx);
  return verdict;
}

describe("D12: receiver completion is required after a gated summary", () => {
  it.each<Step>(["boundary", "restore", "audit"])("D12-Bd-restore fails when %s is missing", async (missing) => {
    const verdict = await compaction("D12-Bd-restore", { missing: [missing] });
    expect(verdict.result).toBe("FAIL");
    expect(verdict.toJSON().failed).toEqual([expect.stringMatching(/boundary.*restore.*audit/)]);
  });
  it("fails when no post-summary step arrives, even though the draft survives", async () => {
    expect((await compaction("D12-Bd-restore", { missing: ["boundary", "restore", "audit"] })).result).toBe("FAIL");
  });
  it("passes the completed sequence and keeps the compact leg's distinct no-command outcome", async () => {
    expect((await compaction("D12-Bd-restore")).result).toBe("PASS");
    expect((await compaction("D12-Bd-compact", { missing: ["summary", "compact", "boundary", "restore", "audit"], stages: ["preparing"] })).result).toBe("PASS");
  });
});

describe("D12: current-stage samples are not history", () => {
  it.each([
    ["all stages", ORDER, "PASS"],
    ["an omitted transient stage", ["compact-sent", "audit-sent"], "PASS"],
    ["a reversal", ["compact-sent", "preparing", "audit-sent"], "FAIL"],
    ["no terminal evidence despite receipt", ["preparing", "compact-sent", "restore-sent"], "FAIL"],
  ])("judges %s", async (_label, stages, expected) => {
    const verdict = await compaction("D12-Bd-prep", { stages: stages as string[] });
    expect(verdict.result).toBe(expected);
  });
  it("still rejects a duplicate receiver step even with valid stage samples", async () => {
    expect((await compaction("D12-Bd-prep", { duplicate: "audit" })).result).toBe("FAIL");
  });
});

describe.each(["D12-D", "D12-E"])("%s: audit request arrival, not model completion", (id) => {
  it("fails when summary and restore arrive but the audit request does not", async () => {
    const verdict = await compaction(id, { missing: ["audit"] });
    expect(verdict.result).toBe("FAIL");
    expect(verdict.toJSON().failed).toEqual([expect.stringMatching(/audit request/)]);
  });
  it("passes when the audit request arrives once", async () => {
    expect((await compaction(id)).result).toBe("PASS");
  });
});

const PANE = "%7";
const capture = (timeNs: number, ansi: boolean, target = PANE) =>
  JSON.stringify({ timeNs, argv: ["tmux", "capture-pane", "-p", ...(ansi ? ["-e"] : []), "-t", target] }) + "\n";
const enter = (timeNs: number) => JSON.stringify({ timeNs, argv: ["tmux", "send-keys", "-t", PANE, "Enter"] }) + "\n";

describe("C7-3176-notice: wait for the daemon's post-injection read", () => {
  it.each([
    ["already present", 0, capture(600, true), "PASS"],
    ["delayed", 300, capture(600, true), "PASS"],
    ["absent", null, "", "FAIL"],
    // Another reader's styled capture, with no pre-Enter read: one after that delivery's Enter, or the session's annotation.
    ["only after that delivery's Enter", 0, enter(550) + capture(600, true), "FAIL"],
    ["only of another target", 0, capture(600, true, "=fixture@dlv:"), "FAIL"],
  ])("handles a read that is %s", async (_label, delay, late, expected) => {
    const w = world(), verdict = new Verdict();
    let draft = "", published = false, barrierAt: number | undefined;
    const log = join(w.root, "tmux-argv.jsonl");
    // Neither an earlier ANSI read nor a later plain read proves the barrier.
    writeFileSync(log, capture(399, true) + capture(500, false));
    const publish = () => {
      if (!published && delay !== null && w.now() >= Number(delay)) {
        appendFileSync(log, late); published = true;
      }
    };
    const check = verdict.check.bind(verdict);
    vi.spyOn(verdict, "check").mockImplementation((name, ok, seen) => {
      if (name.startsWith("barrier:")) barrierAt = w.now();
      return check(name, ok, seen);
    });
    const stopWatchdog = vi.fn(async () => {});
    const ctx = {
      verdict, cell: { logs: w.root }, nowNs: () => 0,
      sleep: async (ms: number) => { await w.sleep(ms); publish(); },
      setGuard: async () => {}, setDraftDelivery: async () => {}, settle: async () => {},
      readComposer: async () => draft, composerOf: (screen: string) => screen,
      mark: () => "DLV-notice", armDraftInjection: (text: string) => { draft = text; },
      registerReminder: async () => "job", watchdogStatus: async () => ({}), heldMessages: async () => [], stopWatchdog,
      waitInjection: async () => { publish(); return { at: "pre-enter", target: PANE, pasteRc: 0, visible: true,
        pasteDoneNs: 200, typedNs: 300, visibleNs: 400, screenAfterPaste: "PASTED" }; },
      paneWrites: () => [], requests: () => [], deliveries: () => ({ turns: [] }),
    };
    await C7.find((c) => c.id === "C7-3176-notice")!.run(ctx);
    expect(verdict.result).toBe(expected);
    expect(stopWatchdog).toHaveBeenCalledOnce();
    if (expected === "FAIL") {
      expect(barrierAt).toBe(10_000);
      expect(verdict.toJSON().failed).toEqual([expect.stringMatching(/^barrier:/)]);
    } else if (delay === 0) expect(barrierAt).toBe(0);
    else expect(barrierAt).toBeGreaterThanOrEqual(Number(delay));
  });
});
