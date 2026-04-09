import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import type { RigServicesSpec } from "../src/domain/types.js";

function mockExec(responses?: Record<string, string | Error>): ExecFn {
  return async (cmd: string) => {
    if (responses) {
      for (const [pattern, response] of Object.entries(responses)) {
        if (cmd.includes(pattern)) {
          if (response instanceof Error) throw response;
          return response;
        }
      }
    }
    return "";
  };
}

const COMPOSE_PS_HEALTHY = JSON.stringify({
  Service: "vault",
  State: "running",
  Status: "Up",
  Health: "healthy",
});

describe("Services snapshot/restore/teardown (T04)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function seedRigWithServices(spec: RigServicesSpec) {
    const rig = setup.rigRepo.createRig("test-rig");
    setup.rigRepo.setServicesRecord(rig.id, {
      kind: "compose",
      specJson: JSON.stringify(spec),
      rigRoot: "/tmp/test-rig",
      composeFile: spec.composeFile,
      projectName: "test-rig",
      latestReceiptJson: JSON.stringify({
        kind: "compose",
        composeFile: spec.composeFile,
        projectName: "test-rig",
        services: [{ name: "vault", status: "running", health: "healthy" }],
        waitFor: [],
        capturedAt: new Date().toISOString(),
      }),
    });
    return rig;
  }

  it("snapshot captures env receipt from services record", () => {
    const spec: RigServicesSpec = { kind: "compose", composeFile: "docker-compose.yml" };
    const rig = seedRigWithServices(spec);

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "test");

    expect(snapshot.data.envReceipt).toBeDefined();
    expect(snapshot.data.envReceipt!.kind).toBe("compose");
    expect(snapshot.data.envReceipt!.services).toHaveLength(1);
    expect(snapshot.data.envReceipt!.services[0]!.name).toBe("vault");
  });

  it("snapshot without services has null envReceipt", () => {
    const rig = setup.rigRepo.createRig("plain-rig");

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "test");

    expect(snapshot.data.envReceipt).toBeNull();
  });

  it("teardown calls service teardown for services-enabled rig", async () => {
    const spec: RigServicesSpec = { kind: "compose", composeFile: "docker-compose.yml", downPolicy: "down" };
    const rig = seedRigWithServices(spec);

    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const composeAdapter = new ComposeServicesAdapter(exec);
    const serviceOrch = new ServiceOrchestrator({ rigRepo: setup.rigRepo, composeAdapter });

    // Inject service orchestrator into teardown
    (setup.teardownOrchestrator as any).deps.serviceOrchestrator = serviceOrch;

    const result = await setup.teardownOrchestrator.teardown(rig.id);

    expect(result.errors).toHaveLength(0);
    // Service teardown should have called docker compose down
    const downCalls = exec.mock.calls.filter((c) => (c[0] as string).includes("down"));
    expect(downCalls.length).toBeGreaterThan(0);
  });

  it("teardown with leave_running policy does not call compose down", async () => {
    const spec: RigServicesSpec = { kind: "compose", composeFile: "docker-compose.yml", downPolicy: "leave_running" };
    const rig = seedRigWithServices(spec);

    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const composeAdapter = new ComposeServicesAdapter(exec);
    const serviceOrch = new ServiceOrchestrator({ rigRepo: setup.rigRepo, composeAdapter });

    (setup.teardownOrchestrator as any).deps.serviceOrchestrator = serviceOrch;

    const result = await setup.teardownOrchestrator.teardown(rig.id);

    expect(result.errors).toHaveLength(0);
    // leave_running = no docker compose down call
    const downCalls = exec.mock.calls.filter((c) => (c[0] as string).includes("down"));
    expect(downCalls).toHaveLength(0);
  });

  it("teardown without services does not attempt service teardown", async () => {
    const rig = setup.rigRepo.createRig("plain-rig");

    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const composeAdapter = new ComposeServicesAdapter(exec);
    const serviceOrch = new ServiceOrchestrator({ rigRepo: setup.rigRepo, composeAdapter });

    (setup.teardownOrchestrator as any).deps.serviceOrchestrator = serviceOrch;

    const result = await setup.teardownOrchestrator.teardown(rig.id);

    expect(result.errors).toHaveLength(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it("snapshot continuity is receipt_only without checkpoint hooks", () => {
    const spec: RigServicesSpec = { kind: "compose", composeFile: "docker-compose.yml" };
    const rig = seedRigWithServices(spec);

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "test");

    // envReceipt is present but there are no checkpoint artifacts
    expect(snapshot.data.envReceipt).toBeDefined();
    // No envCheckpoint field — receipt-only honesty
    expect((snapshot.data as Record<string, unknown>)["envCheckpoint"]).toBeUndefined();
  });
});
