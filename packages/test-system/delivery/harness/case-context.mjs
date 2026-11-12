// What a case does to a cell, as plain verbs: send as OpenRig would, type as a person would, read what the receiver
// got. Each action is recorded in the cell's steps before and after, and a timeout is recorded as an unknown effect,
// never retried: a case doesn't blindly resend what may have landed.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deliveriesOf, Verdict } from "./oracle.mjs";
import { deliveryEvents } from "./evidence.mjs";
import { composerText, recordScreen } from "./screen.mjs";
import { RIG, sleep } from "./world.mjs";

/** Thrown when a case can't observe what it needs to judge: the cell is NOT RUN with this reason, never PASS or FAIL
 *  on evidence it doesn't have. */
export class NotRun extends Error {
  constructor(reason) { super(reason); this.notRun = true; }
}

export function caseContext(cell, { caseId, kind, version }) {
  const verdict = new Verdict();
  const screen = recordScreen(cell, join(cell.logs, "screen-frames.jsonl"));
  const used = new Set();

  const ctx = {
    cell, kind, version, caseId, verdict, screen, sleep,

    /** A marker no other send in this run carries, of the stand-in's default pattern: DLV-<case>-<label>-<random>. */
    mark(label = "m") {
      let marker;
      do { marker = `DLV-${caseId}-${label}-${randomBytes(3).toString("hex")}`; } while (used.has(marker));
      used.add(marker);
      return marker;
    },

    requests: () => cell.standIn.requests(),
    /** OpenRig's own records of what it wrote (#2937) and what the program's hook saw, for the part with this sha256. */
    evidenceFor(partSha256) {
      const events = deliveryEvents(join(cell.env.OPENRIG_HOME, "openrig.sqlite"));
      return {
        deliveryEvidence: events.filter((e) => e.type === "transport.delivery_evidence" && e.payload.wireSha256 === partSha256).map((e) => ({ seq: e.seq, written: e.payload.written, admitted: e.payload.admitted })),
        promptObservation: events.filter((e) => e.type === "transport.prompt_observation" && e.payload.promptSha256 === partSha256).map((e) => ({ seq: e.seq, source: e.payload.source })),
      };
    },
    /** What OpenRig recorded writing (#2937) since `at`: when the received bytes differ, this says on which side of
     *  the pane they changed. */
    writtenSince(at) {
      return deliveryEvents(join(cell.env.OPENRIG_HOME, "openrig.sqlite"))
        .filter((e) => e.type === "transport.delivery_evidence" && e.payload.wireSha256 && e.at >= at.replace("T", " ").replace(/Z$/, "").slice(0, 19))
        .map((e) => ({ seq: e.seq, at: e.at, written: e.payload.written, wireBytes: e.payload.wireBytes, wireSha256: e.payload.wireSha256 }));
    },
    deliveries: (marker) => deliveriesOf(cell.standIn.requests(), marker),

    /** `rig send` to the seat, as any sender would. Returns its parsed JSON (or its raw output), exit and timing. */
    async send(body, flags = []) {
      const started = new Date().toISOString();
      cell.record({ step: "send-intent", caseId, bytes: Buffer.byteLength(body), flags });
      const out = await cell.rig(["send", cell.session, body, "--json", ...flags], { allowFail: true, timeout: 120_000 });
      let json = null;
      try { json = JSON.parse(out.stdout); } catch { /* not JSON: kept raw */ }
      const result = { started, finished: new Date().toISOString(), exit: out.exit, json, stdout: json ? undefined : out.stdout.slice(0, 2000), stderr: out.stderr.slice(0, 2000) };
      cell.record({ step: "send-result", caseId, exit: out.exit, ok: json?.ok, sent: json?.sent, result: json?.result ?? json?.reason ?? null });
      return result;
    },

    /** Wait until `marker` has been delivered `count` times, or the time runs out; returns the deliveries seen. */
    async waitDelivered(marker, { count = 1, timeoutMs = 45_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let seen = ctx.deliveries(marker);
      while (seen.turns.length < count && Date.now() < deadline) { await sleep(250); seen = ctx.deliveries(marker); }
      return seen;
    },

    /** Wait until the screen has stopped changing for `quietMs` (the probe oracle's readiness settle). */
    /** Settled means a capture taken after this call succeeded and the screen hasn't changed for `quietMs`, counted
     *  from this call at the earliest: an action just taken (a key, a send) may not have redrawn the screen yet. With no
     *  capture after the call, the cell is NOT RUN. A screen that never settles is NOT RUN too, unless `optional`, for
     *  a case whose finding that is: then it returns false. */
    async settle({ quietMs = 1250, timeoutMs = 60_000, optional = false } = {}) {
      const started = performance.now();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const last = screen.last();
        if (last && screen.okAt() > started && performance.now() - Math.max(last.monotonicMs, started) >= quietMs) return true;
        await sleep(100);
      }
      if (!(screen.okAt() > started)) throw new NotRun("no screen observation after the action");
      if (optional) return false;
      throw new NotRun(`the screen never settled within ${Math.round(timeoutMs / 1000)} s`);
    },

    /** The screen as a capture taken after `after` (performance.now()) shows it; NOT RUN if none succeeds in time. */
    async observe({ after = performance.now(), timeoutMs = 10_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const last = screen.last();
        if (last && screen.okAt() > after) return last;
        await sleep(50);
      }
      throw new NotRun("no screen observation after the action");
    },

    /** The input box's text from a capture taken now or later. NOT RUN when it can't be read: an unreadable input box is
     *  unknown, never empty. */
    async readComposer(options) {
      const frame = await ctx.observe(options);
      const text = composerText(kind, frame.screen);
      if (text === null) throw new NotRun("the input box couldn't be read on screen");
      return text;
    },

    /** Wait until the screen shows `text`; returns the frame or null. */
    async waitScreen(text, { timeoutMs = 30_000 } = {}) {
      const started = performance.now();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const last = screen.last();
        if (last?.screen.includes(text) && screen.okAt() > started) return last;
        await sleep(100);
      }
      return null;
    },

    /** Wait until the screen matches any of `patterns` (regexes); returns { frame, pattern } or null. */
    async waitScreenAny(patterns, { timeoutMs = 30_000 } = {}) {
      const started = performance.now();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const last = screen.last();
        const hit = last && screen.okAt() > started && patterns.find((p) => p.test(last.screen));
        if (hit) return { frame: last, pattern: String(hit) };
        await sleep(100);
      }
      return null;
    },
    /** Keys a person presses (tmux key names, such as Escape or Enter), not literal text. */
    async personKeys(...keys) {
      cell.record({ step: "person-keys", caseId, keys });
      await cell.tmux(["send-keys", "-t", cell.session, ...keys]);
    },
    composer: () => composerText(kind, screen.last()?.screen ?? ""),
    composerOf: (text) => composerText(kind, text ?? ""),

    /** Type as a person at the keyboard would, through the seat's tmux pane, with no Enter. */
    async typeDraft(text) {
      cell.record({ step: "person-types", caseId, text });
      await cell.tmux(["send-keys", "-t", cell.session, "-l", text]);
    },
    /** Delete `count` characters before the cursor, as a person would. */
    async eraseDraft(count) {
      cell.record({ step: "person-erases", caseId, count });
      await cell.tmux(["send-keys", "-t", cell.session, "-N", String(count), "BSpace"]);
    },
    async enterCopyMode() { cell.record({ step: "person-copy-mode", caseId }); await cell.tmux(["copy-mode", "-t", cell.session]); },
    async leaveCopyMode() { cell.record({ step: "person-leaves-copy-mode", caseId }); await cell.tmux(["send-keys", "-t", cell.session, "-X", "cancel"]); },
    async inMode() { return (await cell.tmux(["display-message", "-p", "-t", cell.session, "#{pane_in_mode}"])).trim() === "1"; },

    /** Arm the logging tmux to type `text` as a person into the seat's pane between OpenRig's last read of the input
     *  box and its next paste there (once). */
    armDraftInjection(text) {
      const spec = { pane: cell.paneId, text, bufferPrefix: "openrig_" };
      writeFileSync(join(cell.env.DELIVERY_INJECT_DIR, "arm.json"), JSON.stringify(spec));
      cell.record({ step: "arm-injection", caseId, ...spec });
    },
    /** What the injection did, or null if no paste came to fire it. */
    injection() {
      const path = join(cell.env.DELIVERY_INJECT_DIR, "fired.json");
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    },
    async waitInjection({ timeoutMs = 90_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (!ctx.injection() && Date.now() < deadline) await sleep(250);
      return ctx.injection();
    },

    /** A watchdog periodic reminder aimed at the seat: OpenRig's own automatic notice, from its scheduler. */
    async registerReminder(message, intervalSeconds) {
      const specPath = join(cell.root, `reminder-${randomBytes(3).toString("hex")}.yaml`);
      writeFileSync(specPath, `message: ${JSON.stringify(message)}\n`);
      const out = await cell.rig(["watchdog", "register", "--policy", "periodic-reminder", "--target-session", cell.session,
        "--interval-seconds", String(intervalSeconds), "--spec", specPath, "--registered-by", "delivery-suite@harness", "--json"]);
      const json = JSON.parse(out.stdout);
      const jobId = json.jobId ?? json.job?.jobId ?? json.id;
      verdict.info("watchdog reminder registered", { jobId, intervalSeconds });
      return jobId;
    },
    async stopWatchdog(jobId) { await cell.rig(["watchdog", "stop", jobId, "--json"], { allowFail: true }); },

    async setGuard(mode) {
      const out = await cell.rig(["seat", "set-typing-guard", cell.session, "--mode", mode, "--reason", `delivery suite ${caseId}`, "--json"]);
      verdict.info(`typing guard set to ${mode}`, out.stdout.trim().slice(0, 400));
    },
    async setDraftDelivery(value) {
      await cell.rig(["config", "set", "transport.draft_delivery", value]);
      verdict.info(`transport.draft_delivery set to ${value}`, (await cell.rig(["config", "get", "transport.draft_delivery"])).stdout.trim());
    },
    async heldMessages() {
      const out = await cell.rig(["seat", "held-messages", cell.session, "--json"], { allowFail: true });
      try { return JSON.parse(out.stdout); } catch { return { raw: out.stdout, exit: out.exit }; }
    },

    /** OpenRig's tmux calls that wrote to the seat's pane at or after `sinceNs` (the logging tmux's record): keys or a
     *  paste aimed at the pane, by its id (as OpenRig targets it) or its session's name. */
    paneWrites(sinceNs) {
      const path = join(cell.logs, "tmux-argv.jsonl");
      if (!existsSync(path)) return [];
      const targets = new Set([cell.paneId, cell.session]);
      return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        .filter((r) => r.timeNs >= sinceNs && ["send-keys", "paste-buffer"].includes(r.argv[1])
          && r.argv.some((a, i) => r.argv[i - 1] === "-t" && (targets.has(a) || a.startsWith(`${cell.session}:`))))
        .map((r) => ({ timeNs: r.timeNs, argv: r.argv.slice(1) }));
    },
    nowNs: () => Date.now() * 1_000_000,

    async seatState() {
      const out = await cell.rig(["ps", "--nodes", "--rig", RIG, "--json"], { allowFail: true });
      try { const rows = JSON.parse(out.stdout); return (Array.isArray(rows) ? rows : rows.entries ?? [])[0] ?? null; } catch { return null; }
    },
  };
  return ctx;
}
