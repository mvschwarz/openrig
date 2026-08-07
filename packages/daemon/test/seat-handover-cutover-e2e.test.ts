import { describe, it, expect, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";

// P14 — the committed money-proof e2e for the seat-handover CUTOVER (r1's LOW-optional; guards the
// tmux-version regression class that bit us: respawn-pane -k CLEARS scrollback, and tabs sanitize to "_"
// under env -i). Drives the REAL handover (createSuccessor → terminateRetiree → respawn-no-k → commit)
// against an ISOLATED tmux server, proving predecessor scrollback SURVIVES in the SAME pane on BOTH the
// graceful and forced retiree-exit paths.
//
// D15 isolation ([[real-run-e2e-daemon-isolation-doctrine]], [[tmux-kill-server-from-seat-reaps-fleet]]):
// a per-run `-L` socket on EVERY tmux command (overrides $TMUX), full env MINUS $TMUX (env -i strips the
// locale and breaks tab-delimited formats), verify-isolation-first, and teardown by SESSION NAME — NEVER
// kill-server. Guarded: skips when tmux is unavailable.

const pexec = promisify(execFile);
const SOCK = `openrig-e2e-${process.pid}`;
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

function tmuxAvailableSync(): boolean {
  try { execFileSync("sh", ["-c", "command -v tmux"], { env: cleanEnv, stdio: "ignore" }); return true; } catch { return false; }
}

const seats: string[] = [];
afterAll(async () => {
  for (const s of seats) await tmux(`kill-session -t ${q(s)}`).catch(() => {}); // BY NAME, never kill-server
});

describe("seat-handover cutover money-proof (isolated tmux, both retiree-exit paths)", () => {
  it.runIf(tmuxAvailableSync())(
    "predecessor scrollback SURVIVES in the SAME pane on graceful + forced paths",
    async () => {
      // Verify isolation FIRST: the -L socket must never show fleet seats.
      const sessions = await tmux("list-sessions -F '#{session_name}'").catch(() => "");
      expect(sessions).not.toMatch(/dev-guard@|dev-planner@|orch-|review-/);

      for (const graceful of [true, false]) {
        const SEAT = `dev-impl@${graceful ? "graceful" : "forced"}-rig`;
        seats.push(SEAT);
        await tmux(`kill-session -t ${q(SEAT)}`).catch(() => {});
        await tmux(`new-session -d -s ${q(SEAT)} -x 110 -y 24`);
        await sleep(200);
        const pane = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
        // GRACEFUL: arm a SIGTERM trap so the retiree shell exits cleanly; FORCED: no trap → SIGKILL fallback.
        if (graceful) { await tmux(`send-keys -t ${q(pane)} -l -- ${q("trap 'exit 0' TERM")}`); await tmux(`send-keys -t ${q(pane)} Enter`); }
        // ~28 predecessor lines → real DEEP scrollback (past the 24-row pane).
        for (let i = 1; i <= 28; i++) {
          await tmux(`send-keys -t ${q(pane)} -l -- ${q(`echo v1_line_${i}_atom_A5`)}`);
          await tmux(`send-keys -t ${q(pane)} Enter`);
        }
        await sleep(300);

        const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
        const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
        const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
        const rig = rigRepo.createRig(`${graceful ? "graceful" : "forced"}-rig`);
        const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/tmp" });
        const session = sessionRegistry.registerSession(node.id, SEAT);
        sessionRegistry.updateStatus(session.id, "running");
        sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
        sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: pane });

        const marker = {
          runtime: "codex",
          async launchHarness(binding: any) {
            await tmux(`send-keys -t ${q(binding.tmuxSession)} -l -- ${q("printf '\\n=== SUCCESSOR v2 in the SAME pane ===\\n'; stty -echo 2>/dev/null; cat")}`);
            await tmux(`send-keys -t ${q(binding.tmuxSession)} Enter`); await sleep(150);
            return { ok: true, resumeToken: "tok", resumeType: "codex_id" };
          },
          async checkReady() { return { ready: true }; },
        };
        const service = new SeatHandoverService({
          db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
          tmuxAdapter: new TmuxAdapter(exec) as any, runtimeAdapters: { codex: marker as any },
          predecessorRecapResolver: () => ({ recap: [{ role: "user", content: "finish A5" }, { role: "assistant", content: "A5 landed; handing to v2" }], recordPath: "/tmp/pred-record.jsonl" }),
          readinessTimeoutMs: 3000, sleep,
        });

        // (i-a) capture the retiree PROCESS (the pane's shell PID) BEFORE cutover — the
        // ghost-wake source (specimen 5) was gen-1's SESSION-LOCAL memory-only cron, which
        // lives and dies INSIDE this process. Proving the retiree is dead post-handover is
        // the class-closing pin: a session-local automation cannot fire once its process is gone.
        const retireePid = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_pid}'`)).trim();

        const result: any = await service.handover({ seatRef: SEAT, reason: "context ~85%", source: "fresh", operator: "orch@seat" });
        await sleep(500);
        const paneAfter = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
        const cap = await tmux(`capture-pane -p -t ${q(pane)} -S -400`);
        const predLines = cap.split("\n").filter((l) => l.includes("v1_line_")).length;

        // The money proof, both paths:
        expect(result.ok, `${graceful ? "graceful" : "forced"} handover`).toBe(true);
        expect(paneAfter, "SAME pane id (scrollback context)").toBe(pane);
        expect(predLines, "predecessor deep history PRESERVED in native scrollback").toBeGreaterThan(0);
        expect(cap, "successor booted in the same pane").toContain("SUCCESSOR v2");
        expect(cap, "stopgap from-record recap fired").toContain("from record");

        // (i-a) THE CLASS-CLOSING PIN: the retiree process is DEAD post-handover, so its
        // session-local memory-only automations (crons/timers registered in-process — the
        // ghost-wake source) died with it. A regression that let the retiree survive the
        // cutover (or respawned WITHOUT terminating it first) flips this red.
        let retireeAlive = true;
        try { execFileSync("sh", ["-c", `kill -0 ${retireePid}`], { env: cleanEnv, stdio: "ignore" }); }
        catch { retireeAlive = false; }
        expect(retireeAlive, `${graceful ? "graceful" : "forced"} retiree process (pid ${retireePid}) DEAD post-handover — session-local automations die with it`).toBe(false);
        db.close();
      }
    },
    60_000,
  );
});
