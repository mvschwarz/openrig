import { describe, it, expect, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import nodePath from "node:path";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";

// 0.5.2-07 — THE MONEY PROOF (the EFFECT leg, PM gate). Boot a codex seat PINNED to a CHEAP model,
// HAND IT OVER through the REAL SeatHandoverService + the REAL CodexRuntimeAdapter, then read the
// SUCCESSOR'S EFFECTIVE model off its live TUI. The seat runs on the SPEC model (gpt-5.1-codex-mini),
// NOT the runtime default (gpt-5.6-sol). Spec != default is the DISCRIMINATOR: a successor footer
// showing the cheap model can only arise from -m being threaded through the successor binding (A2-1) —
// on main the handover reverts and the footer shows the default. This is the effect, not the indicator:
// a real codex process, launched by the real adapter, reporting the model it is actually running.
//
// D15 isolation ([[real-run-e2e-daemon-isolation-doctrine]], [[tmux-kill-server-from-seat-reaps-fleet]]):
// a per-run `-L` socket on EVERY tmux command (overrides $TMUX), full env MINUS $TMUX/$TMUX_TMPDIR,
// verify-isolation-first, teardown by SESSION NAME — never kill-server. Skips when tmux/codex/auth absent.

const pexec = promisify(execFile);
const SOCK = `openrig-mf-e2e-${process.pid}`;
const cleanEnv: any = { ...process.env };
delete cleanEnv.TMUX;
delete cleanEnv.TMUX_TMPDIR;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const exec = async (cmd: string): Promise<string> => {
  const safe = cmd.startsWith("tmux ") ? `tmux -L ${SOCK} ${cmd.slice(5)}` : cmd;
  const { stdout } = await pexec("sh", ["-c", safe], { env: cleanEnv });
  return stdout;
};
const tmux = (a: string) => exec(`tmux ${a}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// SPEC_MODEL is a VALID non-default model that codex renders VERBATIM in its effective-model footer
// (no 400 / no silent fallback). DEFAULT_MODEL is the codex runtime default (fleet) that a REVERTED
// handover would show. The proof reads the EFFECTIVE model off the persistent footer ("gpt-X <tier> ·
// <cwd>"), NOT the banner echo ("model: X /model to change") — a banner can show a requested model that
// the API then rejects and falls back from, which is exactly the indicator-vs-effect trap.
const SPEC_MODEL = "gpt-5.6-luna"; // valid, distinct from the default; footer shows it verbatim
const DEFAULT_MODEL = "gpt-5.6-sol"; // the no-flag runtime default — the reverted-handover failure mode

function preflightOk(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v tmux"], { env: cleanEnv, stdio: "ignore" });
    execFileSync("sh", ["-c", "command -v codex"], { env: cleanEnv, stdio: "ignore" });
    return fs.existsSync(nodePath.join(os.homedir(), ".codex", "auth.json"));
  } catch { return false; }
}

function realFsOps() {
  return {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
    listFiles: (dir: string) => fs.readdirSync(dir),
    statMode: (p: string) => fs.statSync(p).mode,
    chmod: (p: string, m: number) => fs.chmodSync(p, m),
    homedir: os.homedir(),
  } as any;
}

const seats: string[] = [];
afterAll(async () => {
  for (const s of seats) await tmux(`kill-session -t ${q(s)}`).catch(() => {}); // BY NAME, never kill-server
});

describe("seat-handover model-fidelity money-proof (real codex, isolated tmux)", () => {
  it.runIf(preflightOk())(
    "the successor runs on the SPEC-pinned model, not the runtime default",
    async () => {
      // isolation FIRST: the -L socket must never show fleet seats.
      const sessions = await tmux("list-sessions -F '#{session_name}'").catch(() => "");
      expect(sessions).not.toMatch(/dev-guard@|dev-planner@|orch-|review-/);

      const SEAT = "dev-impl@mf-rig";
      seats.push(SEAT);
      // A real cwd with a .git so the adapter's `--add-dir <cwd>/.git` is a real path.
      const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), "mf-e2e-"));
      execFileSync("sh", ["-c", `cd ${q(cwd)} && git init -q`], { env: cleanEnv });

      // The codex adapter appends `--add-dir <queue-state-root>` derived from the seat name. If that
      // directory does not exist, codex silently degrades its -m to a fallback tier (a real quirk worth
      // its own note — a missing queue dir drops the pin). Production ensures it; create it here so -m
      // takes effect and the successor renders the EXACT pinned model.
      const queueRoot = nodePath.join(os.homedir(), ".openrig", "shared-docs", "rigs", "mf-rig", "state", "dev");
      fs.mkdirSync(queueRoot, { recursive: true });

      await tmux(`kill-session -t ${q(SEAT)}`).catch(() => {});
      await tmux(`new-session -d -s ${q(SEAT)} -x 120 -y 34 -c ${q(cwd)}`);
      await sleep(200);
      const pane = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();

      const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
      const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
      const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
      const rig = rigRepo.createRig("mf-rig");
      // THE PIN: the seat is spec-pinned to the cheap model.
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd, model: SPEC_MODEL });
      const session = sessionRegistry.registerSession(node.id, SEAT);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
      sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: pane });

      const realTmux = new TmuxAdapter(exec) as any;
      // The REAL adapter — createSuccessor's binding (carrying the spec model via A2-1) flows through
      // its real fresh-launch command construction, which emits -m.
      const codexAdapter = new CodexRuntimeAdapter({ tmux: realTmux, fsOps: realFsOps(), listProcesses: () => [] }) as any;

      const service = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        tmuxAdapter: realTmux, runtimeAdapters: { codex: codexAdapter },
        predecessorRecapResolver: () => null, // no recap typed — keep the successor TUI clean for the footer read
        // The readiness verify polls the real successor until it is an interactive agent. Codex boots in
        // ~8s and then shows the workspace-trust gate; a trusted workspace (production) or an operator
        // approves it. We simulate that approval CONCURRENTLY (below) so the readiness window observes a
        // genuinely-ready agent — the handover's not-ready signal is HONEST, not a false-negative, so we
        // must make the successor actually ready rather than assert around it.
        //
        // 90s, NOT 30s (post-5.2-cut root-cause, 2026-08-22): under FULL-SUITE conditions on this
        // 4-core box the successor becomes ready at ~30s (measured: an in-suite pass at 29,997ms —
        // 3ms under the old ceiling) versus ~8s on a quiet box, so 30s sat exactly ON the loaded
        // boot time and the test failed by timing, not by product (each failure showed the service's
        // HONEST not-ready, and every green run renders the pinned model verbatim). Synthetic
        // loadavg 29 alone does NOT reproduce it — the mechanism is the suite's process/API
        // contention, not CPU. Headroom belongs in the TEST; the service default is untouched.
        readinessTimeoutMs: 90000, sleep,
      });

      // Approve the codex workspace-trust gate DURING the readiness window (what a trusted workspace /
      // operator provides in production). Spaced Enters cover boot-timing variance.
      // Approve the trust gate CONDITIONALLY: poll for the prompt, send EXACTLY ONE Enter when it
      // appears, then stop. (Unconditional/repeated Enters over-navigate codex mid-resolution and can
      // flip the effective model — a real trap this proof must not fall into.)
      const trustApprover = (async () => {
        // 85 polls, matching the 90s readiness window: under loaded-suite conditions the trust
        // gate itself can appear late, and an approver that gives up at 25s makes the readiness
        // headroom above unreachable in exactly the case it exists for.
        for (let i = 0; i < 85; i++) {
          await sleep(1000);
          const c = await tmux(`capture-pane -p -t ${q(pane)}`).catch(() => "");
          if (/Do you trust the contents of this directory/.test(c)) {
            await tmux(`send-keys -t ${q(pane)} Enter`).catch(() => {});
            return;
          }
        }
      })();

      const result: any = await service.handover({ seatRef: SEAT, reason: "tiering", source: "fresh", operator: "orch@seat" });
      await trustApprover.catch(() => {});
      await sleep(3000);
      const cap = await tmux(`capture-pane -p -t ${q(pane)} -S -400`);

      // The EFFECTIVE-model line is the persistent footer "gpt-<name> <tier> · <cwd>", NOT the banner
      // "model: X /model to change" (the banner echoes the REQUESTED model even when the API rejects it
      // and codex falls back — the indicator-vs-effect trap). Read the footer for this run's cwd.
      const footer = cap.split("\n").reverse().find((l) => /gpt-[\w.-]+ \S+ · \//.test(l) && l.includes(nodePath.basename(cwd)))
        ?? cap.split("\n").reverse().find((l) => /gpt-[\w.-]+ \S+ · \//.test(l));
      // eslint-disable-next-line no-console
      console.log("[mf-e2e] handover result.ok=" + result.ok + " code=" + (result.code ?? "-"));
      // eslint-disable-next-line no-console
      console.log("[mf-e2e] EFFECTIVE footer: " + JSON.stringify(footer));

      expect(result.ok, "handover completed (successor became a ready agent)").toBe(true);
      // No silent fallback: the pin must be VALID for this proof — a rejected model is the A3 case, not this one.
      expect(cap, "no invalid-model rejection / fallback in the successor").not.toMatch(/invalid_request_error|model is not|Model metadata for .* not found/);
      expect(footer, "successor rendered an effective-model footer").toBeTruthy();
      // THE EFFECT: the successor's EFFECTIVE model (footer) is the SPEC pin...
      expect(footer, "successor EFFECTIVE model is the SPEC pin").toContain(SPEC_MODEL);
      // ...and NOT the runtime default (the reverted-handover failure mode on main).
      expect(footer, "successor did NOT revert to the runtime default").not.toContain(DEFAULT_MODEL);

      db.close();
    },
    120_000,
  );
});
