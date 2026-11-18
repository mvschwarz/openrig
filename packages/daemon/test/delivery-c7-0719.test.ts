// 0.7.19 D5's nine C7 entries, checked from source without running a native cell: each item is named once and
// registered, nothing is dropped or merged, a missing capability is NOT RUN with its reason, D18's automatic cells keep
// the watchdog's own record, and the logging tmux types a person's draft at the point each injection names.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { CASES } from "../../test-system/delivery/cases/index.mjs";
import { C7_0719_ITEMS } from "../../test-system/delivery/cases/c7-0719.mjs";
import { CASES as D12 } from "../../test-system/delivery/cases/d12.mjs";
import { occurrenceResult, recordedReason } from "../../test-system/delivery/cases/d18.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DELIVERY = resolve(HERE, "../../test-system/delivery");
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

type Case = { id: string; title: string; programs: string[]; notRun?: string; run: (ctx: unknown) => Promise<void> };
const registered = CASES as Case[];

describe("0.7.19 D5: the nine C7 entries", () => {
  it("names nine items once each, and every case an item names is registered once, in no other item", () => {
    expect(C7_0719_ITEMS.map((i) => i.item)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(C7_0719_ITEMS.map((i) => i.name)).size).toBe(9);
    const ids = registered.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const named = C7_0719_ITEMS.flatMap((i) => i.cases ?? []);
    expect(new Set(named).size).toBe(named.length);
    for (const id of named) expect(ids.filter((x) => x === id)).toHaveLength(1);
    // Item 6 is D12's whole set; item 9 is the run's --tmux option.
    for (const c of D12 as Case[]) expect(ids).toContain(c.id);
    expect(C7_0719_ITEMS.find((i) => i.item === 9)).toMatchObject({ runOption: "--tmux" });
    const run = readFileSync(join(DELIVERY, "run.mjs"), "utf8");
    expect(run).toMatch(/hostPins\(typeof opts\.tmux === "string" \? opts\.tmux : null\)/);
    expect(run).toMatch(/tmux isn't available: \$\{pins\.host\.tmuxUnavailable\}/);
  });

  it("records item 1 NOT RUN with its source reason and opens no cell for it", async () => {
    const c = registered.find((x) => x.id === "C7-3339-withdrawal")!;
    expect(c.notRun).toMatch(/on main \(26598a18\), runner-channel\.ts:7-11/);
    expect(c.notRun).toMatch(/runner_unavailable/);
    expect(readFileSync(join(DELIVERY, "run.mjs"), "utf8")).toMatch(/if \(c\.notRun\) \{ cells\.push\(\{ \.\.\.base, result: "NOT RUN", reason: c\.notRun \}\); continue; \}/);
    await expect(c.run.call(c, {})).rejects.toMatchObject({ notRun: true });
    // No other C7 case is short-circuited but #3176's conditional leg (round 1, F1).
    expect(registered.filter((x) => x.id.startsWith("C7-") && x.notRun).map((x) => x.id)).toEqual(["C7-3339-withdrawal", "C7-3176-conditional"]);
  });

  // Round 1 (#3453): each control the oracle names but no cell can run yet is its own NOT RUN case, inside its item.
  it("registers #3176's conditional leg, D15's #2800 control and D18's queue-only mode as NOT RUN cases of their own, with why", async () => {
    const item = (n: number) => C7_0719_ITEMS.find((i) => i.item === n)!;
    const expectations: Array<[string, number, RegExp]> = [
      ["C7-3176-conditional", 4, /beforeKeys exists only for a conditional send with expectedIdentity/],
      ["D15-2800-unreadable", 8, /can't produce an unreadable input box/],
      ["D18-queue-only", 7, /no expected outcome in the oracle yet/],
    ];
    for (const [id, n, why] of expectations) {
      const c = registered.find((x) => x.id === id)!;
      expect(c, id).toBeDefined();
      expect(c.notRun).toMatch(why);
      expect(item(n).cases).toContain(id);
      expect(c.programs).toEqual(["claude", "codex"]);
      await expect(c.run.call(c, {})).rejects.toMatchObject({ notRun: true });
    }
    // The cells #3176's fix doesn't change are named for what they prove, and D15 itself still runs.
    for (const id of ["C7-3176-send", "C7-3176-notice"]) expect(registered.find((x) => x.id === id)!.title).toMatch(/^post-paste refusal \(not #3176's fix\)/);
    expect(registered.find((x) => x.id === "D15")!.notRun).toBeUndefined();
    expect(item(5).name).toMatch(/native-standin/);
  });

  it("keeps the watchdog's own record of an automatic notice's outcome, and invents no reason code", () => {
    const retained = occurrenceResult({ deliveryStatus: "retained", outcome: "skipped", skipReason: "typing_guard_retained", evaluationNotes: { outboxIds: ["o1"], deliveryFact: "held" } });
    expect(retained).toMatchObject({ outcome: "retained", reason: null, recorded: { actor: "watchdog@system", skipReason: "typing_guard_retained", deliveryFact: "held", deliveryCode: null } });
    expect(recordedReason(retained.recorded)).toBe("typing_guard_retained");
    const refused = occurrenceResult({ deliveryStatus: "failed", outcome: "refused", evaluationNotes: { deliveryInputPhase: "not_reached", deliveryReason: "Refused: at an interactive prompt" } });
    expect(refused).toMatchObject({ ok: false, sent: false, reason: null, recorded: { deliveryReason: "Refused: at an interactive prompt", inputPhase: "not_reached" } });
    expect(recordedReason(refused.recorded)).toBe("Refused: at an interactive prompt");
    expect(recordedReason(occurrenceResult({ deliveryStatus: "retained" }).recorded)).toBeNull();
  });
});

describe("the logging tmux's injection points", () => {
  /** A fake real tmux: it logs each call, keeps the pane's text in a file, and shows it on capture-pane. */
  function world(pasteExit = 0) {
    const root = mkdtempSync(join(tmpdir(), "c7-inject-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const fake = join(root, "real-tmux");
    writeFileSync(fake, `#!/bin/sh
echo "$*" >> "${root}/calls"
case "$1" in
  paste-buffer) printf 'PASTED ' >> "${root}/pane"; exit ${pasteExit} ;;
  send-keys) [ "$4" = "-l" ] && printf '%s' "$5" >> "${root}/pane" ;;
  capture-pane) cat "${root}/pane" 2>/dev/null ;;
esac
exit 0
`);
    chmodSync(fake, 0o755);
    const inject = join(root, "inject");
    spawnSync("mkdir", [inject]);
    const env = { ...process.env, DELIVERY_REAL_TMUX: fake, DELIVERY_TMUX_LOG: join(root, "log.jsonl"), DELIVERY_ARM: "test", DELIVERY_INJECT_DIR: inject };
    const arm = (spec: Record<string, unknown>) => writeFileSync(join(inject, "arm.json"), JSON.stringify({ pane: "%1", text: "DRAFT", bufferPrefix: "openrig_", ...spec }));
    const paste = () => spawnSync(join(DELIVERY, "harness", "tmux"), ["paste-buffer", "-b", "openrig_x", "-t", "%1"], { env, encoding: "utf8" });
    const calls = () => readFileSync(join(root, "calls"), "utf8").trim().split("\n");
    const fired = () => JSON.parse(readFileSync(join(inject, "fired.json"), "utf8"));
    return { root, arm, paste, calls, fired, inject };
  }
  const order = (calls: string[]) => calls.filter((c) => c.startsWith("paste-buffer") || c.startsWith("send-keys")).map((c) => c.split(" ")[0]);

  it("pre-paste (the default, #3076): types the draft and waits for it before the paste runs", () => {
    const w = world();
    w.arm({});
    expect(w.paste().status).toBe(0);
    expect(order(w.calls())).toEqual(["send-keys", "paste-buffer"]);
    expect(w.fired()).toMatchObject({ at: "pre-paste", visible: true, target: "%1" });
    expect(w.fired().screenBeforePaste).toBe("DRAFT");
  });

  it("pre-enter (#3176): lets the paste finish first, then types the draft and waits until it shows", () => {
    const w = world();
    w.arm({ at: "pre-enter" });
    expect(w.paste().status).toBe(0);
    expect(order(w.calls())).toEqual(["paste-buffer", "send-keys"]);
    const fired = w.fired();
    expect(fired).toMatchObject({ at: "pre-enter", pasteRc: 0, visible: true });
    expect(statSync(join(w.inject, "fired.json")).mode & 0o777).toBe(0o600);
    expect(fired.screenAfterPaste).toBe("PASTED ");
    expect(fired.screenAfterTyping).toBe("PASTED DRAFT");
    expect(fired.pasteDoneNs).toBeLessThan(fired.typedNs);
    expect(fired.typedNs).toBeLessThanOrEqual(fired.visibleNs);
  });

  it("pre-enter keeps the paste's own exit, fires once, and leaves another pane's paste alone", () => {
    const w = world(3);
    w.arm({ at: "pre-enter", pane: "%9" });
    expect(w.paste().status).toBe(3); // not the armed pane: the paste runs as the real tmux, untouched
    expect(existsSync(join(w.inject, "fired.json"))).toBe(false);
    expect(existsSync(join(w.inject, "arm.json"))).toBe(true);
    w.arm({ at: "pre-enter" });
    expect(w.paste().status).toBe(3);
    expect(w.fired()).toMatchObject({ at: "pre-enter", pasteRc: 3 });
    w.paste();
    expect(order(w.calls()).filter((c) => c === "send-keys")).toHaveLength(1);
  });
});
