// Build B — `rig doctor` spec-vs-live conformance check. RED-first.
//
// This check cannot discover its own input, and that is a finding rather than a shortcoming: NOTHING
// persists a running rig's spec path. The `rigs` table has no spec/rigRoot column, `rig_services.
// rig_root` is empty, and `projection_manifest.source_spec` is empty. The daemon does not remember
// where the file that describes a rig came from. So the check takes `--spec` explicitly, and when it
// is not given it must SKIP WITH THE REASON rather than pass — a check that cannot find its input
// and stays quiet is indistinguishable from one that looked and found nothing wrong.

import { describe, it, expect } from "vitest";
import { runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";

const SPEC_3_8 = `version: "0.2"
name: v-openrig-build
pods:
  - id: orch
    label: Orchestration
    members:
      - id: lead
      - id: advisor
  - id: dev
    label: Development
    members:
      - id: driver
      - id: guard
`;

function baseDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    exists: () => true,
    baseDir: "/tmp",
    readFile: () => null,
    exec: () => "tmux 3.4",
    checkPort: async () => true,
    configStore: {
      resolve: () => ({
        db: { path: "/tmp/openrig/openrig.sqlite" },
        transcripts: { path: "/tmp/openrig/transcripts" },
        daemon: { host: "127.0.0.1", port: 7433 },
      }),
    } as never,
    mkdirp: () => {},
    checkWritable: () => {},
    ...over,
  };
}

async function conformanceCheck(deps: DoctorDeps) {
  const { checks, asyncChecks } = runDoctorChecks(deps);
  const all = [...checks, ...(await Promise.all(asyncChecks))];
  return all.find((c) => c.name === "spec_live_conformance");
}

describe("rig doctor — spec vs live conformance", () => {
  it("SKIPS with the reason when no --spec is given — it must not read as a pass", async () => {
    const check = await conformanceCheck(baseDeps());
    expect(check).toBeDefined();
    expect(check!.status).toBe("skipped");
    // The reason has to name WHY it cannot self-discover, or the next reader files a bug.
    expect(`${check!.message} ${check!.reason ?? ""}`).toMatch(/not persisted|--spec/i);
  });

  it("PASSES silently when the spec matches the live rig — the negative control", async () => {
    const check = await conformanceCheck(baseDeps({
      specPath: "/specs/rig.yaml",
      readFile: () => SPEC_3_8,
      fetchLiveLogicalIds: async () => ["orch.lead", "orch.advisor", "dev.driver", "dev.guard"],
    }));
    expect(check!.status).toBe("pass");
    expect(check!.message).not.toMatch(/absent|WARNING/i);
  });

  it("WARNS and names the real delta when the live rig has undeclared pods", async () => {
    const check = await conformanceCheck(baseDeps({
      specPath: "/specs/rig.yaml",
      readFile: () => SPEC_3_8,
      fetchLiveLogicalIds: async () => [
        "orch.lead", "orch.advisor", "dev.driver", "dev.guard",
        "dev50.driver", "dev50.guard", "review50.r1",
      ],
    }));
    expect(check!.status).toBe("warn");
    expect(check!.message).toContain("dev50");
    expect(check!.message).toContain("review50");
    expect(check!.message).toContain("2 pods");
    expect(check!.message).toContain("4 seats");
  });

  it("SKIPS when the live topology cannot be read — absence of data is not conformance", async () => {
    const check = await conformanceCheck(baseDeps({
      specPath: "/specs/rig.yaml",
      readFile: () => SPEC_3_8,
      fetchLiveLogicalIds: async () => null,
    }));
    expect(check!.status).toBe("skipped");
  });

  it("FAILS loudly when an explicitly-given spec path cannot be read", async () => {
    const check = await conformanceCheck(baseDeps({
      specPath: "/specs/missing.yaml",
      readFile: () => null,
      fetchLiveLogicalIds: async () => ["orch.lead"],
    }));
    expect(check!.status).toBe("fail");
  });
});
