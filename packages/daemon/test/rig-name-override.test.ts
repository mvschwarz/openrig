import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { rigNameComposeProjectConflict, withRigName } from "../src/domain/rig-name-override.js";

const SPEC = [
  `# team spec`,
  `version: "0.2"`,
  `name: solo # the spec's own name`,
  `pods:`,
  `  - id: work`,
  `    label: Work`,
  `    members: [{id: worker, agent_ref: "builtin:terminal", runtime: terminal, profile: none, cwd: .}]`,
  `    edges: []`,
  `edges: []`,
].join("\n") + "\n";

describe("withRigName", () => {
  it("leaves the text unchanged when no name is given", () => {
    expect(withRigName(SPEC, undefined)).toBe(SPEC);
  });

  it("sets name and keeps every other key", () => {
    const out = withRigName(SPEC, "alpha");
    const { name, ...rest } = parse(out) as Record<string, unknown>;
    const { name: _old, ...before } = parse(SPEC) as Record<string, unknown>;
    expect(name).toBe("alpha");
    expect(rest).toEqual(before);
  });

  it("adds name to a spec that has none", () => {
    expect((parse(withRigName(`version: "0.2"\npods: []\n`, "alpha")) as { name: string }).name).toBe("alpha");
  });

  it("leaves text it cannot parse as a mapping for the existing parse error", () => {
    for (const text of ["pods: [unclosed\n", "- a\n- b\n"]) expect(withRigName(text, "alpha")).toBe(text);
  });
});

describe("rigNameComposeProjectConflict", () => {
  const withServices = (projectName?: string) => `version: "0.2"\nname: solo\nservices:\n  kind: compose\n  compose_file: compose.yaml\n${projectName ? `  project_name: ${projectName}\n` : ""}pods: []\nedges: []\n`;

  it("refuses a chosen name when the spec fixes services.project_name, naming the project", () => {
    const message = rigNameComposeProjectConflict(withServices("shared-db"), "alpha");
    expect(message).toContain("shared-db");
    expect(message).toContain("--name alpha");
  });

  it("allows a launch without a chosen name, a spec without project_name, and a spec without services", () => {
    expect(rigNameComposeProjectConflict(withServices("shared-db"), undefined)).toBeNull();
    expect(rigNameComposeProjectConflict(withServices(), "alpha")).toBeNull();
    expect(rigNameComposeProjectConflict(SPEC, "alpha")).toBeNull();
  });

  it("leaves text it cannot parse for the existing parse error", () => {
    expect(rigNameComposeProjectConflict("services: [unclosed\n", "alpha")).toBeNull();
  });
});
