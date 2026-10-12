import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import nodePath from "node:path";
import { expandCwd, resolveAuthoredCwd, resolveLaunchCwd } from "../src/domain/cwd-resolution.js";
import { resolveNodeConfig, type ResolutionContext } from "../src/domain/profile-resolver.js";
import { RigSpecPreflight } from "../src/domain/rigspec-preflight.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RigSpecPodMember } from "../src/domain/types.js";

describe("expandCwd", () => {
  const env = { WORK: "/srv/work", NAME: "proj" };

  it("expands a leading ~ to the home directory", () => {
    expect(expandCwd("~", env, "/home/q")).toBe("/home/q");
    expect(expandCwd("~/code/app", env, "/home/q")).toBe("/home/q/code/app");
  });

  it("leaves ~user and a mid-path ~ alone", () => {
    expect(expandCwd("~other/app", env, "/home/q")).toBe("~other/app");
    expect(expandCwd("a/~/b", env, "/home/q")).toBe("a/~/b");
  });

  it("expands $VAR and ${VAR}", () => {
    expect(expandCwd("$WORK/$NAME", env, "/h")).toBe("/srv/work/proj");
    expect(expandCwd("${WORK}/${NAME}-x", env, "/h")).toBe("/srv/work/proj-x");
  });

  it("keeps a reference to an unset variable as written", () => {
    expect(expandCwd("$MISSING/app", env, "/h")).toBe("$MISSING/app");
  });

  it("expands a variable set to the empty string to the empty string", () => {
    expect(expandCwd("/a/$EMPTY/b", { EMPTY: "" }, "/h")).toBe("/a//b");
  });
});

// Real directories literally named `~` and `$OPENRIG_CWD_VAR` prove the existence check end to end.
describe("cwd resolution: an existing literal path wins, otherwise the expansion", () => {
  const VAR = "OPENRIG_CWD_VAR";
  let root: string;
  let specRoot: string;
  let target: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "openrig-cwd-")));
    specRoot = nodePath.join(root, "spec");
    target = nodePath.join(root, "target");
    mkdirSync(nodePath.join(target, "app"), { recursive: true });
    mkdirSync(nodePath.join(specRoot, "~", "app"), { recursive: true });
    mkdirSync(nodePath.join(specRoot, `$${VAR}`, "app"), { recursive: true });
    mkdirSync(nodePath.join(root, "abs", `$${VAR}`, "app"), { recursive: true });
    mkdirSync(nodePath.join(root, "abs", "expanded", "app"), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const env = () => ({ [VAR]: target });

  it("keeps an existing literal ~ directory under the spec root, even when the expansion exists", () => {
    expect(resolveAuthoredCwd("~/app", specRoot, undefined, env(), target)).toBe(nodePath.join(specRoot, "~/app"));
  });

  it("keeps an existing literal $VAR directory under the spec root, even when the expansion exists", () => {
    expect(resolveAuthoredCwd(`$${VAR}/app`, specRoot, undefined, env(), "/h"))
      .toBe(nodePath.join(specRoot, `$${VAR}/app`));
  });

  it("expands ~ when the literal is absent", () => {
    expect(resolveAuthoredCwd("~/app", root, undefined, env(), target)).toBe(nodePath.join(target, "app"));
  });

  it("expands $VAR when the literal is absent", () => {
    expect(resolveAuthoredCwd(`\${${VAR}}/app`, root, undefined, env(), "/h")).toBe(nodePath.join(target, "app"));
  });

  it("keeps an existing absolute literal containing a set variable, even when the expansion exists", () => {
    const authored = nodePath.join(root, "abs", `$${VAR}`, "app");
    expect(resolveAuthoredCwd(authored, specRoot, undefined, { [VAR]: "expanded" }, "/h")).toBe(authored);
  });

  it("expands an absolute path containing a set variable when the literal is absent", () => {
    const authored = nodePath.join(root, "abs", `$${VAR}`, "missing");
    expect(resolveAuthoredCwd(authored, specRoot, undefined, { [VAR]: "expanded" }, "/h"))
      .toBe(nodePath.join(root, "abs", "expanded", "missing"));
  });

  it("resolves a relative expansion result under the spec root", () => {
    expect(resolveAuthoredCwd(`$${VAR}/app`, root, undefined, { [VAR]: "rel" }, "/h")).toBe(nodePath.join(root, "rel/app"));
  });

  it("leaves an unset reference as written, under the spec root", () => {
    expect(resolveAuthoredCwd("$OPENRIG_CWD_UNSET/app", specRoot, undefined, env(), "/h"))
      .toBe(nodePath.join(specRoot, "$OPENRIG_CWD_UNSET/app"));
  });

  it("without a spec root keeps a relative literal relative", () => {
    expect(resolveAuthoredCwd("rel/app", null, () => false, env(), "/h")).toBe("rel/app");
  });

  describe("through the launch, profile and preflight paths", () => {
    afterEach(() => { delete process.env[VAR]; });

    it("launch: literal wins, absent literal expands, --cwd wins over both", () => {
      process.env[VAR] = target;
      expect(resolveLaunchCwd(`$${VAR}/app`, specRoot)).toBe(nodePath.join(specRoot, `$${VAR}/app`));
      expect(resolveLaunchCwd("~/app", specRoot)).toBe(nodePath.join(specRoot, "~/app"));
      expect(resolveLaunchCwd(`$${VAR}/app`, root)).toBe(nodePath.join(target, "app"));
      expect(resolveLaunchCwd("~/openrig-cwd-absent", root)).toBe(nodePath.join(homedir(), "openrig-cwd-absent"));
      expect(resolveLaunchCwd(`$${VAR}/app`, specRoot, "/override")).toBe("/override");
      expect(resolveLaunchCwd("sub", "/spec/root")).toBe("/spec/root/sub");
    });

    function profileCwd(cwd: string, specRoot?: string, cwdOverride?: string): string {
      const member: RigSpecPodMember = { id: "impl", agentRef: "local:agents/test", profile: "default", runtime: "claude-code", cwd };
      const pod = { id: "dev", label: "Dev", members: [member], edges: [] };
      const ctx: ResolutionContext = {
        baseSpec: {
          spec: {
            version: "1.0.0", name: "test-agent", imports: [],
            startup: { files: [], actions: [] },
            resources: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
            profiles: { default: { uses: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
          },
          sourcePath: nodePath.join(root, "agent"), hash: "h",
        },
        importedSpecs: [], collisions: [], profileName: "default",
        specRoot, cwdOverride, member, pod,
        rig: { version: "0.2", name: "test-rig", pods: [pod], edges: [] },
        homedir: root,
      };
      const result = resolveNodeConfig(ctx);
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.config.cwd;
    }

    it("profile: literal wins, absent literal expands, --cwd wins over both", () => {
      process.env[VAR] = target;
      expect(profileCwd(`$${VAR}/app`, specRoot)).toBe(nodePath.join(specRoot, `$${VAR}/app`));
      expect(profileCwd(`$${VAR}/app`, root)).toBe(nodePath.join(target, "app"));
      expect(profileCwd(`$${VAR}/app`)).toBe(nodePath.join(target, "app"));
      expect(profileCwd(`$${VAR}/app`, specRoot, "/override")).toBe("/override");
    });

    async function preflightErrors(cwd: string): Promise<string[]> {
      const db = createDb();
      migrate(db, [coreSchema, bindingsSessionsSchema, nodeSpecFieldsSchema, rigArchiveSchema]);
      try {
        const tmuxAdapter = { hasSession: async () => false } as unknown as TmuxAdapter;
        const pf = new RigSpecPreflight({ rigRepo: new RigRepository(db), tmuxAdapter, exec: async () => "", cmuxExec: async () => "" });
        const result = await pf.check({ schemaVersion: 1, name: "r99", version: "1.0.0", nodes: [{ id: "worker", runtime: "claude-code", cwd }], edges: [] });
        return result.errors.filter((e) => e.includes("cwd"));
      } finally { db.close(); }
    }

    it("preflight: literal wins, absent literal expands, unset reference fails only when the literal is absent", async () => {
      const literal = nodePath.join(root, "abs", `$${VAR}`, "app");
      process.env[VAR] = "nowhere";
      expect(await preflightErrors(literal)).toEqual([]);

      process.env[VAR] = "expanded";
      const expandedOnly = nodePath.join(root, "abs", `$${VAR}`, "missing");
      expect(await preflightErrors(expandedOnly))
        .toEqual([`cwd '${nodePath.join(root, "abs", "expanded", "missing")}' does not exist for node 'worker'`]);
      process.env[VAR] = target;
      expect(await preflightErrors(`$${VAR}/app`)).toEqual([]);

      delete process.env[VAR];
      expect(await preflightErrors(literal)).toEqual([]);
      const missing = nodePath.join(root, `$${VAR}`, "app");
      expect(await preflightErrors(missing)).toEqual([`cwd '${missing}' does not exist for node 'worker'`]);
    });
  });
});
