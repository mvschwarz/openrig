import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

const root = "/fixture/first-start";
const skillIds = ["development-team", "systematic-debugging", "test-driven-development", "verification-before-completion"];
const member = { id: "pi", agent_ref: "local:agent", profile: "default", runtime: "pi", model: "provider/model", cwd: root };
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

async function failedAdd() {
  const db = createFullTestDb();
  closers.push(() => db.close());
  const files: Record<string, string> = {
    [root]: "",
    [`${root}/agent/agent.yaml`]: `name: implementer\nversion: "1.0.0"\nresources:\n  skills:\n${skillIds.map(id => `    - id: ${id}\n      path: skills/${id}`).join("\n")}\nprofiles:\n  default:\n    uses:\n      skills: [${skillIds.join(", ")}]\nstartup:\n  files:\n    - path: role.md\n      required: true\n      delivery_hint: send_text\n`,
    [`${root}/agent/role.md`]: "Read the role and preserve the existing seat.",
    ...Object.fromEntries(skillIds.flatMap(id => [[`${root}/agent/skills/${id}`, ""], [`${root}/agent/skills/${id}/SKILL.md`, `# ${id}`]])),
  };
  let projectionBlocked = true;
  const adapter: RuntimeAdapter = {
    runtime: "pi",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: projectionBlocked ? skillIds.map(effectiveId => ({ effectiveId, error: "EACCES: projection ancestor" })) : [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 1, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
  const tmux = mockTmuxAdapter();
  const setup = createTestApp(db, {
    tmux, adapters: { pi: adapter },
    podInstantiatorFsOps: { exists: path => path in files, readFile: path => { if (!(path in files)) throw new Error(`Missing ${path}`); return files[path]!; } },
  });
  const rig = setup.rigRepo.createRig("first-start");
  const seeded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: { id: "dev", label: "Dev", members: [{ id: "sibling", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: root }], edges: [] } });
  expect(seeded.ok).toBe(true);
  const added = await setup.podInstantiator.addMemberToPod(rig.id, "dev", member, root);
  expect(added).toMatchObject({ ok: true, result: { node: { status: "failed", logicalId: "dev.pi" } } });
  const node = setup.rigRepo.getRig(rig.id)!.nodes.find(n => n.logicalId === "dev.pi")!;
  expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?").get(node.id)).toBeUndefined();
  expect(adapter.launchHarness).not.toHaveBeenCalled();
  const firstSession = setup.sessionRegistry.getSessionsForRig(rig.id).find(s => s.nodeId === node.id)!;
  const failure = db.prepare("SELECT * FROM events WHERE node_id = ? AND type = 'node.startup_failed'").get(node.id);
  expect(firstSession.resumeToken).toBeNull();
  setup.snapshotCapture.captureSnapshot(rig.id, "manual");
  const lifecycle = new SeatLifecycleService({ ...setup, db, tmuxAdapter: tmux });
  // Models the separately authorized normal shell exit; no real process exists.
  tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
  const clean = await lifecycle.cleanSeat({ seatRef: "dev-pi@first-start", reason: "Projection failed before native launch; shell has exited" });
  expect(clean.ok).toBe(true);
  projectionBlocked = false;
  const request = (retryMember: Record<string, unknown> = member) => setup.app.request(`/api/rigs/${rig.id}/nodes/dev.pi/launch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ retryStartupFrom: { member: retryMember, rigRoot: root } }),
  });
  return { ...setup, db, rig, node, adapter, tmux, files, firstSession, failure, request };
}

describe("explicit first-start retry after projection failure", () => {
  it("reprojects and delivers required startup on the same node without touching its sibling or history", async () => {
    const f = await failedAdd();
    const before = f.rigRepo.getRig(f.rig.id)!;
    const sibling = before.nodes.find(n => n.logicalId === "dev.sibling")!;
    const siblingSessions = f.sessionRegistry.getSessionsForRig(f.rig.id).filter(s => s.nodeId === sibling.id);
    const res = await f.request();
    const body = await res.json();
    expect({ status: res.status, body }, JSON.stringify(body)).toMatchObject({ status: 201, body: { ok: true, nodeId: f.node.id, status: "launched" } });
    const after = f.rigRepo.getRig(f.rig.id)!;
    expect(after.nodes.map(n => n.id)).toEqual(before.nodes.map(n => n.id));
    expect(after.nodes.find(n => n.id === sibling.id)).toEqual(sibling);
    expect(f.sessionRegistry.getSessionsForRig(f.rig.id).filter(s => s.nodeId === sibling.id)).toEqual(siblingSessions);
    expect(f.db.prepare("SELECT * FROM events WHERE node_id = ? AND type = 'node.startup_failed'").get(f.node.id)).toEqual(f.failure);
    expect(f.sessionRegistry.getSessionsForRig(f.rig.id).find(s => s.id === f.firstSession.id)?.startupStatus).toBe("failed");
    expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.adapter.launchHarness).mock.calls[0]![1]?.resumeToken).toBeUndefined();
    const projected = vi.mocked(f.adapter.project).mock.calls.at(-1)![0].entries;
    expect(projected.filter(e => e.category === "skill").map(e => e.effectiveId).sort()).toEqual([...skillIds].sort());
    expect(vi.mocked(f.adapter.project).mock.invocationCallOrder.at(-1)!).toBeLessThan(vi.mocked(f.adapter.launchHarness).mock.invocationCallOrder[0]!);
    const context = f.db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?").get(f.node.id) as { projection_entries_json: string; resolved_files_json: string };
    expect(JSON.parse(context.projection_entries_json).filter((e: { category: string }) => e.category === "skill")).toHaveLength(4);
    expect(JSON.parse(context.resolved_files_json)).toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining("role.md"), required: true, deliveryHint: "send_text" })]));
    expect(f.adapter.deliverStartup).toHaveBeenCalled();
    expect(vi.mocked(f.adapter.deliverStartup).mock.calls.flatMap(call => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ absolutePath: `${root}/agent/role.md`, required: true, deliveryHint: "send_text" }),
    ]));
    expect(f.sessionRegistry.getSessionsForRig(f.rig.id).filter(s => s.nodeId === f.node.id).every(s => s.resumeToken === null)).toBe(true);
    expect(f.tmux.killSession).not.toHaveBeenCalled();
    // Ready occupants can never be reclassified as a failed first start.
    expect((await f.request()).status).toBe(409);
    expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
  });

  it.each(["present", "unknown"])("refuses %s liveness without effects", async state => {
    const f = await failedAdd();
    vi.mocked(f.tmux.probeSession).mockResolvedValue(state === "present" ? { state: "present" } : { state: "transport_unavailable", cause: "transport failure" });
    const changes = f.db.prepare("SELECT total_changes() AS n").get();
    expect((await f.request()).status).toBe(409);
    expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(f.adapter.launchHarness).not.toHaveBeenCalled();
    expect(f.adapter.project).toHaveBeenCalledTimes(1);
  });

  it("refuses a seat change during asynchronous liveness checks", async () => {
    const f = await failedAdd();
    vi.mocked(f.tmux.probeSession).mockImplementation(async () => {
      f.db.prepare("UPDATE nodes SET model = 'other/model' WHERE id = ?").run(f.node.id);
      return { state: "absent" };
    });
    const res = await f.request();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ message: "Seat changed during recovery checks; inspect it before retrying." });
    expect(f.adapter.launchHarness).not.toHaveBeenCalled();
    expect(f.adapter.project).toHaveBeenCalledTimes(1);
  });

  it.each(["resume", "native", "late-failure", "changed-spec", "changed-member", "overrides"])("refuses %s without projection or launch", async control => {
    const f = await failedAdd();
    if (control === "resume") f.sessionRegistry.updateResumeToken(f.firstSession.id, "pi", "native-id");
    if (control === "native") f.db.prepare("UPDATE occupant_tenures SET native_session_id_at_boot = 'native-id' WHERE node_id = ?").run(f.node.id);
    if (control === "late-failure") f.db.prepare("UPDATE events SET payload = ? WHERE node_id = ? AND type = 'node.startup_failed'").run(JSON.stringify({ type: "node.startup_failed", nodeId: f.node.id, sessionId: f.firstSession.id, error: "Harness launch failed" }), f.node.id);
    if (control === "changed-spec") f.files[`${root}/agent/agent.yaml`] += "\n# changed\n";
    const changes = f.db.prepare("SELECT total_changes() AS n").get();
    const res = await f.request(control === "changed-member" ? { ...member, model: "different/model" } : control === "overrides" ? { ...member, startup: { files: [] } } : member);
    expect(res.status).toBe(409);
    expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(f.adapter.launchHarness).not.toHaveBeenCalled();
    expect(f.adapter.project).toHaveBeenCalledTimes(1);
  });
});
