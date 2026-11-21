import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { buildExecutionView } from "../src/domain/execution-view.js";
import { workflowWaitWakeMessage } from "../src/domain/workflow-projector.js";
import type { WorkflowInstance, WorkflowSpec, WorkflowStepSpec } from "../src/domain/workflow-types.js";

const example = parse(readFileSync(new URL("../../../docs/reference/project-release-profile.yaml", import.meta.url), "utf8"));
const ids = ["mission-outcome", "exact-release-candidate", "capability-delta", "exact-cut-substance",
  "release-verification", "git-canonicalization", "public-release", "parent-adoption", "record-shipped", "release-boundary"];
const RECEIPT_FLAG = " --evidence-ref <agent-judged-receipt>";

function continuation(text: string): string {
  const line = text.split("\n").find((l) => l.startsWith("Continuation: "));
  expect(line, "the text carries a Continuation line").toBeDefined();
  return line!.slice("Continuation: ".length);
}

describe("a workflow packet's Continuation names the receipt a required step needs", () => {
  let root: string;
  let missionPath: string;
  let mission: Record<string, unknown>;
  function save() {
    writeFileSync(join(root, "project.yaml"), stringify(example));
    writeFileSync(join(missionPath, "mission.yaml"), stringify(mission));
  }
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "packet-evidence-ref-")));
    missionPath = join(root, "missions", "release-0.5.11");
    mkdirSync(missionPath, { recursive: true });
    mission = { kind: "mission", metadata: { name: "release-0.5.11" }, composition: { slices: [] } };
    save();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function withRuntime(run: (runtime: WorkflowRuntime, queue: QueueRepository, view: () => Promise<Array<Record<string, unknown>>>) => Promise<void>) {
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const bus = new EventBus(db);
      const queue = new QueueRepository(db, bus, { validateRig: () => true });
      const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
      const view = async () => {
        const built = await buildExecutionView({ db, slicesRoot: () => join(root, "missions"), buildInfo: { semver: null, commit: null, dirty: null, builtAt: null } }, { mission: "release-0.5.11" }) as { lifecycle_instances: Array<{ frontier_packets: Array<Record<string, unknown>> }> };
        return built.lifecycle_instances[0]!.frontier_packets;
      };
      await run(runtime, queue, view);
    } finally { db.close(); }
  }

  it("a required step's packet names --evidence-ref, as the execution view does", async () => {
    await withRuntime(async (runtime, queue, view) => {
      const created = await runtime.instantiateLifecycle({ missionPath, operationKey: "release", rootObjective: "Ship release", createdBySession: "orch@example" });
      const start = runtime.inspect(created.instance.instanceId).frontier[0]!;
      expect(start.stepId).toBe("mission-outcome");
      const command = continuation(queue.getByIdOrThrow(start.packetId).body);
      expect(command).toContain(RECEIPT_FLAG);
      const projected = (await view()).find((p) => p["packet_id"] === start.packetId);
      expect(command).toBe(projected?.["targeted_action"]);
    });
  });

  // Passes before the fix too: an unrequired step never named the flag anywhere.
  it("an unrequired step's packet names no receipt, as the execution view does", async () => {
    mission.lifecycle = { profile: "release-boundary-v0", mode: "extend", workflow: {
      steps: [{ id: "activate-successor", actor_role: "orchestrator", depends_on: ["release-boundary"], allowed_exits: ["done", "waiting", "failed"] }],
    } };
    save();
    await withRuntime(async (runtime, queue, view) => {
      const created = await runtime.instantiateLifecycle({ missionPath, operationKey: "release", rootObjective: "Ship release", createdBySession: "orch@example" });
      const instanceId = created.instance.instanceId;
      for (const id of ids) {
        const packet = runtime.inspect(instanceId).frontier[0]!;
        expect(packet.stepId).toBe(id);
        await runtime.project({ instanceId, currentPacketId: packet.packetId, exit: id === "release-boundary" ? "done" : "handoff", actorSession: "orch@example", closureEvidence: { evidence_ref: `proof/${id}.md` } });
      }
      const successor = runtime.inspect(instanceId).frontier[0]!;
      expect(successor.stepId).toBe("activate-successor");
      const command = continuation(queue.getByIdOrThrow(successor.packetId).body);
      expect(command).not.toContain("--evidence-ref");
      const projected = (await view()).find((p) => p["packet_id"] === successor.packetId);
      expect(command).toBe(projected?.["targeted_action"]);
    });
  });

  it("a wait re-presentation names --evidence-ref only for a required step", () => {
    const spec = { id: "flow", version: "1", steps: [] } as unknown as WorkflowSpec;
    const instance = { instanceId: "wf-1", lifecycleBinding: { graphSource: { requiredSteps: ["s"] } } } as unknown as WorkflowInstance;
    const wake = (id: string) => workflowWaitWakeMessage({
      spec, instance, step: { id, actor_role: "orchestrator" } as unknown as WorkflowStepSpec, packetId: "qitem-1", ownerSession: "orch@example",
    });
    expect(continuation(wake("s"))).toBe(`rig workflow project --instance wf-1 --current-packet qitem-1 --exit <handoff|waiting|done|failed>${RECEIPT_FLAG}`);
    expect(continuation(wake("t"))).not.toContain("--evidence-ref");
  });
});
