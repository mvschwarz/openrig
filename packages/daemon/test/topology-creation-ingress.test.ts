import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("single topology-creation ingress (OPR.0.5.8.9)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => db.close());

  const terminalMember = (id: string) => ({
    id,
    runtime: "terminal",
    agent_ref: "builtin:terminal",
    profile: "none",
    cwd: "/tmp",
  });

  it("routes pod expansion and ordinary member growth through the same materialize and launch effects", async () => {
    const rig = setup.rigRepo.createRig("shared-ingress");
    const materialize = vi.spyOn(setup.podInstantiator, "materializeValidatedSpec");
    const launch = vi.spyOn(setup.podInstantiator, "launchValidatedSpec");

    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "dev",
        label: "Development",
        members: [{
          id: "one",
          runtime: "terminal",
          agentRef: "builtin:terminal",
          profile: "none",
          cwd: "/tmp",
        }],
        edges: [],
      },
    });
    expect(expanded.ok).toBe(true);

    const added = await setup.podInstantiator.addMemberToPod(
      rig.id,
      "dev",
      terminalMember("two"),
      ".",
    );
    expect(added.ok).toBe(true);

    expect(materialize).toHaveBeenCalledTimes(2);
    expect(materialize.mock.calls.map((call) => call[3]?.existingPodNamespace ?? null))
      .toEqual([null, "dev"]);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls.map((call) => call[0].pods[0]?.members[0]?.id))
      .toEqual(["one", "two"]);
  });

  it("keeps one construction call site for each topology-creation effect", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/domain/rigspec-instantiator.ts"),
      "utf8",
    );
    const census = {
      createMemberNode: [...source.matchAll(/\bthis\.createMemberNode\(/g)].length,
      launchBinding: [...source.matchAll(/\bthis\.launchBinding\(/g)].length,
    };
    const addMemberBody = source.slice(
      source.indexOf("  async addMemberToPod("),
      source.indexOf("  async instantiate(", source.indexOf("  async addMemberToPod(")),
    );

    expect(census).toEqual({ createMemberNode: 1, launchBinding: 1 });
    expect(addMemberBody).toContain("this.materializeValidatedSpec(");
    expect(addMemberBody).toContain("this.launchValidatedSpec(");
    expect(addMemberBody).not.toContain("this.createMemberNode(");
    expect(addMemberBody).not.toContain("this.launchBinding(");
    expect(addMemberBody).not.toContain("this.db.transaction(");
  });
});
