import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

describe("Bootstrap service gate (T03)", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createFullTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "services-up-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSpec(specYaml: string): string {
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, specYaml);
    return specPath;
  }

  it("services-free spec launches through existing path with no service overhead", async () => {
    const specPath = writeSpec(`
version: "0.2"
name: no-services-rig
pods:
  - id: infra
    label: Infra
    members:
      - id: server
        runtime: terminal
        agent_ref: "builtin:terminal"
        profile: none
        cwd: /tmp
    edges: []
`);

    const setup = createTestApp(db);
    const result = await setup.bootstrapOrchestrator.bootstrap({
      sourceRef: specPath,
      mode: "apply",
    });

    expect(result.status).toBe("completed");
    // No service_boot stage should appear
    expect(result.stages.some((s) => s.stage === "service_boot")).toBe(false);
  });

  it("services-enabled spec boots services before agent launch", async () => {
    const composePath = path.join(tmpDir, "docker-compose.yml");
    fs.writeFileSync(composePath, "version: '3'\nservices:\n  vault:\n    image: vault:1.15\n");

    const specPath = writeSpec(`
version: "0.2"
name: services-rig
services:
  kind: compose
  compose_file: docker-compose.yml
  wait_for:
    - url: http://localhost:8200/v1/sys/health
pods:
  - id: infra
    label: Infra
    members:
      - id: server
        runtime: terminal
        agent_ref: "builtin:terminal"
        profile: none
        cwd: /tmp
    edges: []
`);

    // Wire a ServiceOrchestrator with mock exec
    const composeAdapter = new ComposeServicesAdapter(mockExec({
      "up -d": "",
      "ps --format json": COMPOSE_PS_HEALTHY,
      "curl": "200",
    }));
    const rigRepo = new RigRepository(db);
    const serviceOrch = new ServiceOrchestrator({ rigRepo, composeAdapter });

    const setup = createTestApp(db);
    // Inject service deps into bootstrap orchestrator via reflection
    (setup.bootstrapOrchestrator as any).deps.serviceOrchestrator = serviceOrch;
    (setup.bootstrapOrchestrator as any).deps.rigRepo = rigRepo;

    const result = await setup.bootstrapOrchestrator.bootstrap({
      sourceRef: specPath,
      mode: "apply",
    });

    expect(result.status).toBe("completed");
    // Service boot stage should appear and succeed
    const serviceStage = result.stages.find((s) => s.stage === "service_boot");
    expect(serviceStage).toBeDefined();
    expect(serviceStage!.status).toBe("ok");
  });

  it("service boot failure blocks agent launch with honest error", async () => {
    const composePath = path.join(tmpDir, "docker-compose.yml");
    fs.writeFileSync(composePath, "version: '3'\nservices:\n  vault:\n    image: vault:1.15\n");

    const specPath = writeSpec(`
version: "0.2"
name: failing-services-rig
services:
  kind: compose
  compose_file: docker-compose.yml
  wait_for:
    - url: http://localhost:8200/v1/sys/health
pods:
  - id: infra
    label: Infra
    members:
      - id: server
        runtime: terminal
        agent_ref: "builtin:terminal"
        profile: none
        cwd: /tmp
    edges: []
`);

    // Wire a ServiceOrchestrator that always fails boot
    const composeAdapter = new ComposeServicesAdapter(mockExec());
    const rigRepo = new RigRepository(db);
    const serviceOrch = new ServiceOrchestrator({ rigRepo, composeAdapter });
    // Mock boot() to return immediate failure
    vi.spyOn(serviceOrch, "boot").mockResolvedValue({
      ok: false,
      code: "wait_timeout",
      error: "Service wait targets not healthy after 30s: HTTP probe failed: http://localhost:8200/v1/sys/health",
      receipt: {
        kind: "compose",
        composeFile: "docker-compose.yml",
        projectName: "failing-services-rig",
        services: [{ name: "vault", status: "running", health: "starting" }],
        waitFor: [{ target: { url: "http://localhost:8200/v1/sys/health" }, status: "unhealthy", detail: "HTTP probe failed" }],
        capturedAt: new Date().toISOString(),
      },
    });

    const setup = createTestApp(db);
    (setup.bootstrapOrchestrator as any).deps.serviceOrchestrator = serviceOrch;
    (setup.bootstrapOrchestrator as any).deps.rigRepo = rigRepo;

    const result = await setup.bootstrapOrchestrator.bootstrap({
      sourceRef: specPath,
      mode: "apply",
    });

    expect(result.status).toBe("failed");
    // Error should mention the blocking target
    expect(result.errors.some((e) => e.includes("Service boot failed"))).toBe(true);
    // Service boot stage should show failed
    const serviceStage = result.stages.find((s) => s.stage === "service_boot");
    expect(serviceStage).toBeDefined();
    // No agent sessions should have been launched
    const createdRig = rigRepo.findRigsByName("failing-services-rig")[0];
    expect(createdRig).toBeDefined();
    const sessions = createdRig ? setup.sessionRegistry.getSessionsForRig(createdRig.id) : [];
    expect(sessions).toHaveLength(0);
    expect(serviceStage!.status).toBe("failed");
  });

  it("plan mode does not boot services", async () => {
    const composePath = path.join(tmpDir, "docker-compose.yml");
    fs.writeFileSync(composePath, "version: '3'\nservices:\n  vault:\n    image: vault:1.15\n");

    const specPath = writeSpec(`
version: "0.2"
name: plan-services-rig
services:
  kind: compose
  compose_file: docker-compose.yml
pods:
  - id: infra
    label: Infra
    members:
      - id: server
        runtime: terminal
        agent_ref: "builtin:terminal"
        profile: none
        cwd: /tmp
    edges: []
`);

    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const composeAdapter = new ComposeServicesAdapter(exec);
    const rigRepo = new RigRepository(db);
    const serviceOrch = new ServiceOrchestrator({ rigRepo, composeAdapter });

    const setup = createTestApp(db);
    (setup.bootstrapOrchestrator as any).deps.serviceOrchestrator = serviceOrch;
    (setup.bootstrapOrchestrator as any).deps.rigRepo = rigRepo;

    const result = await setup.bootstrapOrchestrator.bootstrap({
      sourceRef: specPath,
      mode: "plan",
    });

    // Plan mode should not call docker compose at all
    expect(exec).not.toHaveBeenCalled();
    // No service_boot stage in plan mode
    expect(result.stages.some((s) => s.stage === "service_boot")).toBe(false);
  });
});
