import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { resolveIdentityVerifiedClaudeRecord, type ProcessRow } from "../src/domain/model-divergence/current-generation-record.js";
import { readClaudeEffectiveModel } from "../src/domain/model-divergence/effective-model-readers.js";

describe("S13 effective-model identity — repository-shaped causal specimen", () => {
  let db: Database.Database | null = null;
  let dir: string | null = null;

  afterEach(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    db = null;
    dir = null;
  });

  it("keeps the renamed predecessor discoverable while selecting the verified canonical occupant", async () => {
    const canonicalSession = "orch-advisor@v-openrig-build";
    const reserveSession = "orch-advisor-memory-20260830T2007Z@v-openrig-build";
    const canonicalId = "f16594c5-179a-4be7-bf5e-fd759b2b87a3";
    const reserveId = "9e1ac0df-505a-4050-857b-a494b46dabc6";
    db = createFullTestDb();
    const rigs = new RigRepository(db);
    const sessions = new SessionRegistry(db);
    const discovery = new DiscoveryRepository(db);
    const identities = new SeatIdentityStore(db);
    const rig = rigs.createRig("v-openrig-build");
    const node = rigs.addNode(rig.id, "orch.advisor", { runtime: "claude-code", cwd: "/project" });
    const session = sessions.registerSession(node.id, canonicalSession);
    sessions.updateStatus(session.id, "running");
    sessions.updateResumeToken(session.id, "claude_id", reserveId, "scrape");
    sessions.updateBinding(node.id, { tmuxSession: canonicalSession, tmuxPane: "%156" });
    const generation = sessions.currentOccupantTenure(node.id)!;
    const observedAt = new Date(Date.parse(generation.bootAt) + 60_000).toISOString();
    identities.upsert({
      nodeId: node.id,
      verdict: "verified",
      evidenceSource: "pane_process",
      reason: null,
      evidence: { registeredPane: "%156", observedPid: 10, observedCommand: "claude", matchedLayer: 1 },
      sessionName: canonicalSession,
      observedAt,
    });
    const reserve = discovery.upsertDiscoveredSession({
      tmuxSession: reserveSession,
      tmuxPane: "%6",
      pid: 40,
      activeCommand: "claude",
      runtimeHint: "claude-code",
      confidence: "high",
      cwd: "/project",
    });

    dir = mkdtempSync(join(tmpdir(), "openrig-s13-causal-"));
    const canonicalPath = join(dir, `${canonicalId}.jsonl`);
    const reservePath = join(dir, `${reserveId}.jsonl`);
    writeFileSync(canonicalPath, `${JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-fable-5-1" } })}\n`);
    writeFileSync(reservePath, `${JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5" } })}\n`);
    utimesSync(canonicalPath, new Date("2026-09-04T02:20:00Z"), new Date("2026-09-04T02:20:00Z"));
    utimesSync(reservePath, new Date("2026-09-04T02:40:00Z"), new Date("2026-09-04T02:40:00Z"));
    const processRows: ProcessRow[] = [
      { pid: 10, ppid: 1, command: "-zsh" },
      { pid: 20, ppid: 10, command: `claude --model claude-fable-5-1 --resume ${canonicalId} --name ${canonicalSession}` },
      { pid: 30, ppid: 1, command: "-zsh" },
      { pid: 40, ppid: 30, command: `claude --model claude-fable-5 --resume ${reserveId} --name ${canonicalSession}` },
    ];

    const selected = await resolveIdentityVerifiedClaudeRecord({
      sessionName: canonicalSession,
      generation: generation.generationUuid,
      occupantBootAt: generation.bootAt,
      binding: { tmuxSession: canonicalSession, tmuxPane: "%156" },
      identity: identities.getForNode(node.id),
      sidecar: {
        session_id: canonicalId,
        session_name: canonicalSession,
        transcript_path: canonicalPath,
        sampled_at: new Date(Date.parse(observedAt) + 1_000).toISOString(),
      },
    }, {
      getPanePid: async (target) => target === "%156" ? 10 : null,
      listProcesses: async () => processRows,
    }, (path) => { try { return statSync(path).isFile(); } catch { return false; } });

    expect(selected).toMatchObject({ ok: true, id: canonicalId, path: canonicalPath });
    expect(selected.ok && readClaudeEffectiveModel(selected.path)).toBe("claude-fable-5-1");
    expect(sessions.getSessionsForRig(rig.id).at(-1)?.resumeToken).toBe(reserveId);
    expect(discovery.getDiscoveredSession(reserve.id)).toMatchObject({
      tmuxSession: reserveSession,
      tmuxPane: "%6",
      status: "active",
      claimedNodeId: null,
    });
    expect(statSync(reservePath).mtimeMs).toBeGreaterThan(statSync(canonicalPath).mtimeMs);
  });
});
