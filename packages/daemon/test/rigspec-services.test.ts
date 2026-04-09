import { describe, it, expect } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { migrate } from "../src/db/migrate.js";
import { rigServicesSchema } from "../src/db/migrations/020_rig_services.js";
import type { RigSpec, RigServicesRecordInput } from "../src/domain/types.js";

const VALID_RIG_WITH_SERVICES = {
  version: "0.2",
  name: "services-rig",
  pods: [
    {
      id: "dev",
      label: "Development",
      members: [
        {
          id: "impl",
          agent_ref: "local:agents/development/implementer",
          profile: "default",
          runtime: "claude-code",
          cwd: ".",
        },
      ],
      edges: [],
    },
  ],
  edges: [],
  services: {
    kind: "compose",
    compose_file: "./compose.yaml",
    project_name: "services-rig",
    profiles: ["core"],
    down_policy: "down",
    wait_for: [
      { service: "vault", condition: "healthy" },
      { url: "http://127.0.0.1:3000/healthz" },
      { tcp: "127.0.0.1:5432" },
    ],
    surfaces: {
      urls: [{ name: "app", url: "http://127.0.0.1:3000" }],
      commands: [{ name: "psql", command: "psql postgresql://app:dev@127.0.0.1:5432/app" }],
    },
    checkpoints: [
      {
        id: "vault",
        export: "docker compose exec -T vault vault status",
        import: "docker compose exec -T vault vault status",
      },
    ],
  },
};

function createServicesDb() {
  const db = createFullTestDb();
  migrate(db, [rigServicesSchema]);
  return db;
}

describe("RigSpec services contract", () => {
  it("rejects non-compose services kinds", () => {
    const rig = structuredClone(VALID_RIG_WITH_SERVICES) as Record<string, unknown>;
    (rig.services as Record<string, unknown>).kind = "kubernetes";

    const result = RigSpecSchema.validate(rig);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("services.kind") && e.includes("compose"))).toBe(true);
  });

  it("normalize preserves the services block", () => {
    const normalized = RigSpecSchema.normalize(structuredClone(VALID_RIG_WITH_SERVICES) as Record<string, unknown>);

    expect(normalized.services).toBeDefined();
    expect(normalized.services.kind).toBe("compose");
    expect(normalized.services.composeFile).toBe("./compose.yaml");
    expect(normalized.services.projectName).toBe("services-rig");
    expect(normalized.services.downPolicy).toBe("down");
    expect(normalized.services.waitFor).toHaveLength(3);
    expect(normalized.services.waitFor[2].tcp).toBe("127.0.0.1:5432");
    expect(normalized.services.surfaces.urls[0].name).toBe("app");
    expect(normalized.services.checkpoints[0].id).toBe("vault");
  });

  it("defaults project_name deterministically from the rig name when omitted", () => {
    const rig = structuredClone(VALID_RIG_WITH_SERVICES) as Record<string, unknown>;
    delete (rig.services as Record<string, unknown>).project_name;
    rig.name = "Demo Rig / V1";

    const validated = RigSpecSchema.validate(rig);
    expect(validated.valid).toBe(true);

    const normalized = RigSpecSchema.normalize(rig) as RigSpec;
    expect(normalized.services.projectName).toBe("demo-rig-v1");
  });

  it("rejects invalid explicit project_name values", () => {
    const rig = structuredClone(VALID_RIG_WITH_SERVICES) as Record<string, unknown>;
    (rig.services as Record<string, unknown>).project_name = "Bad Project Name!";

    const result = RigSpecSchema.validate(rig);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("services.project_name") && e.includes("match"))).toBe(true);
  });

  it("RigRepository persists and updates a services record", () => {
    const db = createServicesDb();
    const repo = new RigRepository(db);
    const rig = repo.createRig("services-rig");

    const initial: RigServicesRecordInput = {
      kind: "compose" as const,
      specJson: JSON.stringify(VALID_RIG_WITH_SERVICES.services),
      rigRoot: "/tmp/services-rig",
      composeFile: "/tmp/services-rig/compose.yaml",
      latestReceiptJson: null,
    };

    const stored = repo.setServicesRecord(rig.id, initial);
    expect(stored.rigId).toBe(rig.id);
    expect(stored.composeFile).toBe("/tmp/services-rig/compose.yaml");
    expect(stored.projectName).toBe("services-rig");

    const fetched = repo.getServicesRecord(rig.id);
    expect(fetched).not.toBeNull();
    if (!fetched) throw new Error("expected services record");
    expect(fetched.rigId).toBe(rig.id);
    expect(fetched.specJson).toContain('"compose"');

    const updated = repo.updateServicesReceipt(rig.id, JSON.stringify({ status: "healthy" }));
    expect(updated).not.toBeNull();
    if (!updated) throw new Error("expected updated services record");
    expect(updated.latestReceiptJson).toContain("healthy");

    const fetchedAgain = repo.getServicesRecord(rig.id);
    expect(fetchedAgain).not.toBeNull();
    if (!fetchedAgain) throw new Error("expected fetched services record");
    expect(fetchedAgain.latestReceiptJson).toContain("healthy");

    db.close();
  });

  it("createDaemon wires the rig_services migration", async () => {
    const { createDaemon } = await import("../src/startup.js");
    const { db } = await createDaemon({ dbPath: ":memory:" });

    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toContain("rig_services");
    } finally {
      db.close();
    }
  });
});
