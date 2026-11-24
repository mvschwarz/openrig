import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sweepCompactionPackets } from "../src/domain/compaction-packet-sweep.js";
import { RESTART_RECOVERY_WINDOW_MS_DEFAULT } from "../src/domain/claude-compaction-enforcer.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const OLD = NOW - RESTART_RECOVERY_WINDOW_MS_DEFAULT - 60_000;
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  vi.stubEnv("OPENRIG_COMPACTION_OUT_ROOT", "");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "packet-sweep-"))); roots.push(root);
  const home = path.join(root, "home");
  const packets = path.join(home, "run", "compaction-restore");
  const pending = path.join(home, "compaction", "restore-pending");
  const jobs = path.join(home, "compaction", "packet-jobs");
  for (const dir of [packets, pending, jobs]) mkdirSync(dir, { recursive: true });
  /** A packet folder as restore-from-jsonl.mjs names it, with its mtime. */
  const packet = (dir: string, session: string, minute: number, at = OLD) => {
    const p = path.join(dir, `${session}-2026-11-24T08-${String(minute).padStart(2, "0")}-00-000Z`);
    mkdirSync(p, { recursive: true });
    writeFileSync(path.join(p, "restore-instructions.md"), "# packet\n");
    utimesSync(p, at / 1000, at / 1000);
    return p;
  };
  const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
  return { root, home, packets, pending, jobs, packet, json };
}

describe("sweepCompactionPackets", () => {
  it("removes only old packets that no marker, current build or recent write still needs", () => {
    const f = fixture();
    const unreferenced = f.packet(f.packets, A, 1);
    const delivered = f.packet(f.packets, A, 2);
    const superseded = f.packet(f.packets, B, 3);
    const pendingPacket = f.packet(f.packets, B, 4);
    const recent = f.packet(f.packets, A, 5, NOW - 60_000);
    const built = f.packet(f.packets, A, 6);
    f.json(path.join(f.pending, "a@rig.json"), { sessionId: A, outputDir: delivered, deliveryCount: 1 });
    f.json(path.join(f.pending, "b@rig.superseded.json"), { sessionId: B, outputDir: superseded });
    f.json(path.join(f.pending, "b@rig.json"), { sessionId: B, outputDir: pendingPacket, deliveryCount: 0 });
    // A finished current build whose marker isn't published (another one's was): its own result names its packet.
    const result = path.join(f.jobs, "c@rig.job1.result.json");
    f.json(result, { jobId: "job1", ok: true, outputDir: built });
    f.json(path.join(f.pending, "c@rig.expected.json"), { sessionId: A, packetJob: { jobId: "job1", pid: 999999, resultPath: result } });
    // Not packet-shaped, a file, and a link: never touched.
    mkdirSync(path.join(f.packets, "notes"));
    writeFileSync(path.join(f.packets, `${A}-2026-11-24T08-07-00-000Z`), "a file");
    symlinkSync(unreferenced, path.join(f.packets, `${B}-2026-11-24T08-08-00-000Z`));
    utimesSync(path.join(f.packets, "notes"), OLD / 1000, OLD / 1000);

    const sweep = sweepCompactionPackets({ openrigHome: f.home, now: NOW, isAlive: () => false });
    expect(sweep.removed).toEqual([unreferenced]);
    for (const kept of [delivered, superseded, pendingPacket, recent, built, path.join(f.packets, "notes")]) expect(existsSync(kept)).toBe(true);
    expect(existsSync(path.join(f.packets, `${A}-2026-11-24T08-07-00-000Z`))).toBe(true);
    expect(sweep.kept).toBe(5);
  });

  it("touches nothing of a build still running: its session's packets and any staging folder stay", () => {
    const f = fixture();
    const mine = f.packet(f.packets, A, 1);
    const other = f.packet(f.packets, B, 2);
    const staging = path.join(f.packets, ".partial-Ab12Cd");
    mkdirSync(staging);
    utimesSync(staging, OLD / 1000, OLD / 1000);
    const result = path.join(f.jobs, "a@rig.job2.result.json");
    f.json(path.join(f.pending, "a@rig.expected.json"), { sessionId: A, packetJob: { jobId: "job2", pid: 4242, resultPath: result } });

    const running = sweepCompactionPackets({ openrigHome: f.home, now: NOW, isAlive: pid => pid === 4242 });
    expect(running.removed).toEqual([other]);
    expect(existsSync(mine) && existsSync(staging)).toBe(true);

    // Its pid not recorded yet (the hook writes the sentinel before it starts the build): treated as running.
    f.json(path.join(f.pending, "a@rig.expected.json"), { sessionId: A, packetJob: { jobId: "job2", resultPath: result } });
    expect(sweepCompactionPackets({ openrigHome: f.home, now: NOW, isAlive: () => false }).removed).toEqual([]);

    // A running build with no session id recorded keeps every packet.
    f.json(path.join(f.pending, "a@rig.expected.json"), { packetJob: { jobId: "job2", pid: 4242, resultPath: result } });
    expect(sweepCompactionPackets({ openrigHome: f.home, now: NOW, isAlive: () => true }).removed).toEqual([]);

    // Once its finisher is gone without a result, nothing is held for it.
    f.json(path.join(f.pending, "a@rig.expected.json"), { sessionId: A, packetJob: { jobId: "job2", pid: 4242, resultPath: result } });
    expect(sweepCompactionPackets({ openrigHome: f.home, now: NOW, isAlive: () => false }).removed.sort()).toEqual([mine, staging].sort());
  });

  it("sweeps a launch project's packet folder that a marker or an earlier build names, by the same rule", () => {
    const f = fixture();
    const projectPackets = path.join(f.root, "project", ".openrig", "compaction", "packets");
    const current = f.packet(projectPackets, A, 1);
    const earlier = f.packet(projectPackets, A, 2);
    const leftover = f.packet(path.join(f.root, "other-project", ".openrig", "compaction", "packets"), B, 3);
    f.json(path.join(f.pending, "a@rig.json"), { sessionId: A, outputDir: current });
    // The seat has relaunched and moved to the home's folder: only an old build's result still names this project.
    f.json(path.join(f.jobs, "b@rig.old.result.json"), { jobId: "old", ok: true, outputDir: path.join(path.dirname(leftover), `${B}-2026-11-24T07-00-00-000Z`) });
    // A folder outside these is never listed, even beside a named packet.
    const elsewhere = f.packet(path.join(f.root, "elsewhere"), B, 4);
    f.json(path.join(f.pending, "e@rig.json"), { outputDir: path.join(path.dirname(elsewhere), "named-but-gone") });

    const sweep = sweepCompactionPackets({ openrigHome: f.home, now: NOW, isAlive: () => false });
    expect(sweep.removed.sort()).toEqual([earlier, leftover].sort());
    expect(existsSync(current) && existsSync(elsewhere)).toBe(true);
  });

  it("keeps a marker's packet when the marker spells the folder through a symlink", () => {
    const f = fixture();
    const packet = f.packet(f.packets, A, 1);
    symlinkSync(f.home, path.join(f.root, "home-link"));
    f.json(path.join(f.pending, "a@rig.json"), { sessionId: A, outputDir: path.join(f.root, "home-link", "run", "compaction-restore", path.basename(packet)) });
    expect(sweepCompactionPackets({ openrigHome: path.join(f.root, "home-link"), now: NOW, isAlive: () => false }).removed).toEqual([]);
    expect(sweepCompactionPackets({ openrigHome: f.home, now: NOW, isAlive: () => false }).removed).toEqual([]);
    expect(existsSync(packet)).toBe(true);
  });

  it("is a no-op for a home with no packets or records", () => {
    const root = mkdtempSync(path.join(tmpdir(), "packet-sweep-empty-")); roots.push(root);
    expect(sweepCompactionPackets({ openrigHome: path.join(root, "missing"), now: NOW })).toEqual({ removed: [], kept: 0 });
  });
});

describe("startCompactionPacketSweep", () => {
  it("sweeps once at boot and then daily", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const { startCompactionPacketSweep } = await import("../src/index.js");
      const first = f.packet(f.packets, A, 1, Date.now() - RESTART_RECOVERY_WINDOW_MS_DEFAULT - 60_000);
      const handle = startCompactionPacketSweep(f.home);
      expect(existsSync(first)).toBe(false);
      const second = f.packet(f.packets, A, 2, Date.now() - RESTART_RECOVERY_WINDOW_MS_DEFAULT - 60_000);
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(existsSync(second)).toBe(false);
      clearInterval(handle);
    } finally {
      vi.useRealTimers();
    }
  });
});
