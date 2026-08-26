// S5 fix round 1, r2-F4 (row 30045f39) — proof item 1's REAL-resume leg: after
// `set-model`, a REAL managed successor (SeatHandoverService + real CodexRuntimeAdapter,
// real codex TUI) runs the CANONICAL (post-set-model) model, with session lineage
// preserved. Modeled on seat-handover-model-fidelity-e2e (D15 isolation: per-run -L
// socket, env minus $TMUX, teardown by session name, never kill-server; skips when
// tmux/codex/auth absent).
//
// DISCRIMINATOR: the node is CREATED pinned to the runtime default (gpt-5.6-sol) and
// set-model moves it to a valid NON-default (gpt-5.6-luna). A successor footer showing
// luna can only arise from the UPDATED nodes.model threading through the real launcher
// at call time — a reverted or stale read shows sol.
//
// Evidence-class note (honest): this is an EVIDENCE leg, not a defect fix — the
// mechanism was already correct, so there is no RED for it; it strengthens proof
// item 1 from citation+persistence to a driven real resume.
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
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";

const pexec = promisify(execFile);
const SOCK = `openrig-s5f4-e2e-${process.pid}`;
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
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

const CREATED_MODEL = "gpt-5.6-sol";  // the runtime default — what a stale/reverted read shows
const CANONICAL_MODEL = "gpt-5.6-luna"; // set-model target; footer renders it verbatim only via the updated pin

function preflightOk(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v tmux"], { env: cleanEnv, stdio: "ignore" });
    execFileSync("sh", ["-c", "command -v codex"], { env: cleanEnv, stdio: "ignore" });
    return fs.existsSync(nodePath.join(os.homedir(), ".codex", "auth.json"));
  } catch { return false; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function realFsOps(): any {
  return {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
    listFiles: (dir: string) => fs.readdirSync(dir),
    statMode: (p: string) => fs.statSync(p).mode,
    chmod: (p: string, m: number) => fs.chmodSync(p, m),
    homedir: os.homedir(),
  };
}

const seats: string[] = [];
afterAll(async () => {
  for (const s of seats) await tmux(`kill-session -t ${q(s)}`).catch(() => {}); // BY NAME, never kill-server
});

describe("S5 F4: set-model then a REAL managed successor runs the canonical model (real codex, isolated tmux)", () => {
  it.runIf(preflightOk())(
    "the successor's EFFECTIVE model is the post-set-model canonical pin, and lineage survives",
    async () => {
      const sessions = await tmux("list-sessions -F '#{session_name}'").catch(() => "");
      expect(sessions).not.toMatch(/dev-guard@|dev-planner@|orch-|review-/);

      const SEAT = "dev-impl@s5f4-rig";
      seats.push(SEAT);
      const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), "s5f4-e2e-"));
      execFileSync("sh", ["-c", `cd ${q(cwd)} && git init -q`], { env: cleanEnv });
      const queueRoot = nodePath.join(os.homedir(), ".openrig", "shared-docs", "rigs", "s5f4-rig", "state", "dev");
      fs.mkdirSync(queueRoot, { recursive: true });

      await tmux(`kill-session -t ${q(SEAT)}`).catch(() => {});
      await tmux(`new-session -d -s ${q(SEAT)} -x 120 -y 34 -c ${q(cwd)}`);
      await sleep(200);
      const pane = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();

      const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
      const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
      const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
      const rig = rigRepo.createRig("s5f4-rig");
      // Created pinned to the DEFAULT — the value a stale read would thread.
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd, model: CREATED_MODEL });
      const session = sessionRegistry.registerSession(node.id, SEAT);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-26T07:00:00Z").toISOString());
      sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: pane });

      const realTmux = new TmuxAdapter(exec);

      // THE VERB UNDER PROOF: set-model AFTER creation, BEFORE the managed successor.
      const lifecycle = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: realTmux });
      const setResult = await lifecycle.setModel({
        seatRef: SEAT, model: CANONICAL_MODEL,
        reason: "F4 real-resume proof: default -> canonical", operator: "dev50-driver@test",
      });
      expect(setResult.ok).toBe(true);
      if (!setResult.ok) throw new Error(setResult.message);
      expect(setResult.from).toBe(CREATED_MODEL);
      expect(setResult.to).toBe(CANONICAL_MODEL);

      const tenuresBefore = (db.prepare("SELECT COUNT(*) AS c FROM occupant_tenures WHERE node_id = ?").get(node.id) as { c: number }).c;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const codexAdapter = new CodexRuntimeAdapter({ tmux: realTmux as any, fsOps: realFsOps() as any, listProcesses: () => [] }) as any;
      const service = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tmuxAdapter: realTmux as any, runtimeAdapters: { codex: codexAdapter },
        predecessorRecapResolver: () => null,
        readinessTimeoutMs: 90000, sleep,
      });

      const trustApprover = (async () => {
        for (let i = 0; i < 85; i++) {
          await sleep(1000);
          const c = await tmux(`capture-pane -p -t ${q(pane)}`).catch(() => "");
          if (/Do you trust the contents of this directory/.test(c)) {
            await tmux(`send-keys -t ${q(pane)} Enter`).catch(() => {});
            return;
          }
        }
      })();

      // THE REAL MANAGED SUCCESSOR — the launch path reads nodes.model at call time.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await service.handover({ seatRef: SEAT, reason: "F4 real-resume proof", source: "fresh", operator: "dev50-driver@test" });
      await trustApprover.catch(() => {});
      await sleep(3000);
      const cap = await tmux(`capture-pane -p -t ${q(pane)} -S -400`);
      const footer = cap.split("\n").reverse().find((l) => /gpt-[\w.-]+ \S+ · \//.test(l) && l.includes(nodePath.basename(cwd)))
        ?? cap.split("\n").reverse().find((l) => /gpt-[\w.-]+ \S+ · \//.test(l));
      // eslint-disable-next-line no-console
      console.log("[s5f4-e2e] handover result.ok=" + result.ok + " code=" + (result.code ?? "-") + " footer=" + JSON.stringify(footer));

      expect(result.ok, "handover completed (successor became a ready agent)").toBe(true);
      expect(cap, "no invalid-model rejection / fallback in the successor").not.toMatch(/invalid_request_error|model is not|Model metadata for .* not found/);
      expect(footer, "successor rendered an effective-model footer").toBeTruthy();
      // THE EFFECT (F4): the real successor's EFFECTIVE model is the POST-set-model canonical value...
      expect(footer, "successor EFFECTIVE model is the post-set-model canonical pin").toContain(CANONICAL_MODEL);
      // ...not the creation-time value a stale/reverted read would thread.
      expect(footer, "successor did NOT run the creation-time model").not.toContain(CREATED_MODEL);

      // LINEAGE PRESERVED: predecessor session row intact (superseded, not deleted);
      // the tenure ledger GREW by the handover generation with prior rows untouched.
      const rows = db.prepare("SELECT id, session_name, status FROM sessions WHERE node_id = ? ORDER BY id").all(node.id) as Array<{ id: string; status: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.some((r) => r.id === session.id)).toBe(true);
      const tenuresAfter = (db.prepare("SELECT COUNT(*) AS c FROM occupant_tenures WHERE node_id = ?").get(node.id) as { c: number }).c;
      expect(tenuresAfter).toBe(tenuresBefore + 1);
      // The audit event from set-model is durable beside the handover's records.
      const audit = db.prepare("SELECT COUNT(*) AS c FROM events WHERE type='node.model_changed'").get() as { c: number };
      expect(audit.c).toBe(1);

      db.close();
    },
    120_000,
  );
});
