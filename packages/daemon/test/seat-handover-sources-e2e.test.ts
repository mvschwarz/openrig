import { describe, it, expect, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";

// OPR.0.5.5.5 — end-to-end money proof for the two NEW executable handover
// sources against an ISOLATED tmux server (same D15 isolation discipline as
// seat-handover-cutover-e2e: per-run -L socket, no $TMUX, teardown BY SESSION
// NAME, never kill-server; skips when tmux is unavailable).
//
// FORK: the real cutover runs and the resolved native id ARRIVES at the launch
// surface (the marker adapter renders the forkSource it received into the real
// pane) — proving fork execution is a native-fork launch, not a blank fresh
// launch relabeled. REBUILD: a real on-disk artifact chain is resolved and the
// priming packet is REALLY delivered (visible in the pane), with the executed
// set recorded on the result.

const pexec = promisify(execFile);
const SOCK = `openrig-s05e2e-${process.pid}`;
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
const tempDirs: string[] = [];
afterAll(async () => {
  for (const s of seats) await tmux(`kill-session -t ${q(s)}`).catch(() => {}); // BY NAME, never kill-server
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

async function seedPane(seat: string): Promise<string> {
  seats.push(seat);
  await tmux(`kill-session -t ${q(seat)}`).catch(() => {});
  await tmux(`new-session -d -s ${q(seat)} -x 110 -y 24`);
  await sleep(200);
  const pane = (await tmux(`list-panes -t ${q(seat)} -F '#{pane_id}'`)).trim();
  await tmux(`send-keys -t ${q(pane)} -l -- ${q("trap 'exit 0' TERM")}`);
  await tmux(`send-keys -t ${q(pane)} Enter`);
  // A just-created shell can swallow early send-keys during init — poll until
  // the predecessor sentinel has ACTUALLY rendered, so the post-cutover
  // scrollback assertion tests preservation, not send-keys timing.
  for (let attempt = 0; attempt < 10; attempt++) {
    await tmux(`send-keys -t ${q(pane)} -l -- ${q("echo predecessor_line_S05")}`);
    await tmux(`send-keys -t ${q(pane)} Enter`);
    await sleep(300);
    const pre = await tmux(`capture-pane -p -t ${q(pane)} -S -400`);
    if (pre.includes("predecessor_line_S05")) break;
  }
  return pane;
}

describe("seat-handover source execution e2e (isolated tmux)", () => {
  it.runIf(tmuxAvailableSync())(
    "FORK end-to-end: the resolved native id reaches the real launch in the preserved pane; continuity records forked",
    async () => {
      const SEAT = "dev-impl@fork-e2e-rig";
      const pane = await seedPane(SEAT);

      const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
      const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
      const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
      const rig = rigRepo.createRig("fork-e2e-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/tmp" });
      const session = sessionRegistry.registerSession(node.id, SEAT);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
      sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: pane });
      // The incumbent's native conversation id — what fork must resolve + carry.
      sessionRegistry.updateResumeToken(session.id, "codex_id", "native-e2e-abc123", "scrape");

      const marker = {
        runtime: "codex",
        async launchHarness(binding: any, opts: any) {
          // Render the RECEIVED fork source into the real pane — the pin below
          // reads it back from capture, proving the id crossed the whole path.
          const stamp = opts?.forkSource ? `FORKED_FROM_${opts.forkSource.value}` : "NO_FORK_SOURCE";
          await tmux(`send-keys -t ${q(binding.tmuxSession)} -l -- ${q(`printf '\\n=== SUCCESSOR ${stamp} ===\\n'; stty -echo 2>/dev/null; cat`)}`);
          await tmux(`send-keys -t ${q(binding.tmuxSession)} Enter`); await sleep(150);
          return { ok: true, resumeToken: "post-fork-tok", resumeType: "codex_id" };
        },
        async checkReady() { return { ready: true }; },
      };
      const service = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        tmuxAdapter: new TmuxAdapter(exec) as any, runtimeAdapters: { codex: marker as any },
        readinessTimeoutMs: 3000, sleep,
      });

      const result: any = await service.handover({ seatRef: SEAT, reason: "context-wall", source: `fork:${SEAT}`, operator: "orch@e2e" });
      await sleep(400);
      const paneAfter = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
      const cap = await tmux(`capture-pane -p -t ${q(pane)} -S -400`);

      expect(result.ok, "fork handover executes").toBe(true);
      expect(paneAfter, "SAME pane id (seat identity preserved)").toBe(pane);
      expect(cap, "the resolved native id reached the launch surface").toContain("FORKED_FROM_native-e2e-abc123");
      // Scrollback preservation (deep-history money proof) is owned by
      // seat-handover-cutover-e2e — fork rides the SAME respawn path; this file
      // pins what S05 adds: the native id arriving at the launch in-place.
      expect(result.result.currentStatus.continuityOutcome).toBe("forked");
      expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: SEAT });
      db.close();
    },
    60_000,
  );

  it.runIf(tmuxAvailableSync())(
    "REBUILD end-to-end: a real on-disk chain primes the successor through real delivery; the executed set is recorded; continuity records rebuilt",
    async () => {
      const SEAT = "dev-impl@rebuild-e2e-rig";
      const pane = await seedPane(SEAT);

      // Real durable chain on disk: RECAP.md present, LEARNED.md deliberately
      // ABSENT so the gap leg is proven end-to-end too.
      const seatDir = mkdtempSync(join(tmpdir(), "s05-rebuild-e2e-"));
      tempDirs.push(seatDir);
      writeFileSync(join(seatDir, "RECAP.md"), "# RECAP\nS05 e2e recap body\n");
      const recapAddress = join(seatDir, "RECAP.md");
      const learnedAddress = join(seatDir, "LEARNED.md"); // not written — a real gap

      const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
      const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
      const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
      const rig = rigRepo.createRig("rebuild-e2e-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/tmp" });
      const session = sessionRegistry.registerSession(node.id, SEAT);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
      sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: pane });

      const marker = {
        runtime: "codex",
        async launchHarness(binding: any, opts: any) {
          const stamp = opts?.forkSource || opts?.resumeToken ? "UNEXPECTED_NON_FRESH" : "FRESH_REBUILD_TARGET";
          await tmux(`send-keys -t ${q(binding.tmuxSession)} -l -- ${q(`printf '\\n=== SUCCESSOR ${stamp} ===\\n'; stty -echo 2>/dev/null; cat`)}`);
          await tmux(`send-keys -t ${q(binding.tmuxSession)} Enter`); await sleep(150);
          return { ok: true };
        },
        async checkReady() { return { ready: true }; },
      };
      const service = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        tmuxAdapter: new TmuxAdapter(exec) as any, runtimeAdapters: { codex: marker as any },
        // Production-shaped resolver: DECLARES addresses; the service existence-
        // filters them against the REAL filesystem (default existsSync).
        rebuildPrimingResolver: () => ({
          artifacts: [
            { address: recapAddress, label: "authored seat recap (highest trust)" },
            { address: learnedAddress, label: "seat lineage lessons" },
          ],
        }),
        readinessTimeoutMs: 3000, sleep,
      });

      const result: any = await service.handover({ seatRef: SEAT, reason: "degraded-incumbent", source: "rebuild", operator: "orch@e2e" });
      await sleep(500);
      const cap = await tmux(`capture-pane -p -t ${q(pane)} -S -400`);

      expect(result.ok, "rebuild handover executes").toBe(true);
      expect(cap, "successor launched fresh (no fork/resume)").toContain("FRESH_REBUILD_TARGET");
      // The priming packet REALLY landed in the pane and points at the artifact.
      expect(cap, "priming packet delivered end-to-end").toContain("Seat rebuild handover");
      expect(cap, "resolved artifact address delivered").toContain(recapAddress);
      expect(result.result.currentStatus.continuityOutcome).toBe("rebuilt");
      expect(result.result.sourceOutcome).toMatchObject({
        mode: "rebuild",
        primedArtifacts: [expect.objectContaining({ address: recapAddress })],
        gaps: [learnedAddress],
      });
      db.close();
    },
    60_000,
  );
});
