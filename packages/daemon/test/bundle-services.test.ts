import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PodBundleAssembler, type PodAssemblerFsOps } from "../src/domain/pod-bundle-assembler.js";
import { pack, unpack } from "../src/domain/bundle-archive.js";
import { computeIntegrity } from "../src/domain/bundle-integrity.js";
import { serializePodBundleManifest } from "../src/domain/bundle-types.js";
import { describeBundleBehaviour } from "../src/domain/bundle-behaviour.js";
import { parse } from "yaml";
import { fileURLToPath } from "node:url";
import { resolveAgentRef } from "../src/domain/agent-resolver.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const rig = `version: "0.2"
name: service-demo
services:
  kind: compose
  compose_file: services/compose.yaml
  down_policy: down
  wait_for:
    - url: http://127.0.0.1:8200/v1/sys/health
pods:
  - id: demo
    label: Demo
    members:
      - id: shell
        agent_ref: builtin:terminal
        runtime: terminal
        profile: none
        cwd: .
    edges: []
edges: []
`;
const compose = `services:
  vault:
    image: hashicorp/vault:1.15
    ports: ["8200:8200"]
    cap_add: [IPC_LOCK]
    environment:
      VAULT_DEV_ROOT_TOKEN_ID: openrig-dev-token
      PRIVATE_VALUE: do-not-display
    healthcheck:
      test: [CMD, vault, status]
  worker:
    image: "\${WORKER_IMAGE}"
    ports:
      - target: 8080
        published: "\${HOST_PORT}"
        host_ip: 127.0.0.1
    privileged: true
    environment: [API_KEY, OTHER=not-a-public-default]
    volumes: ["\${DATA_DIR}:/data"]
`;
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function filesUnder(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? filesUnder(path.join(root, entry.name)).map(file => `${entry.name}/${file}`) : [entry.name]);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-services-")); roots.push(root);
  const source = path.join(root, "source"); fs.mkdirSync(path.join(source, "services"), { recursive: true });
  fs.writeFileSync(path.join(source, "rig.yaml"), rig);
  fs.writeFileSync(path.join(source, "services/compose.yaml"), compose);
  fs.writeFileSync(path.join(source, ".env"), "PRIVATE_SECRET=must-not-travel");
  const fsOps: PodAssemblerFsOps = {
    readFile: p => fs.readFileSync(p, "utf8"), readFileBuffer: fs.readFileSync,
    exists: fs.existsSync, realpath: fs.realpathSync,
    mkdirp: p => { fs.mkdirSync(p, { recursive: true }); },
    writeFile: (p, content, mode) => { fs.writeFileSync(p, content, { mode }); },
    copyDir: (s, d) => { fs.cpSync(s, d, { recursive: true }); }, listFiles: filesUnder,
  };
  const assemble = (servicesEnabled = false) => new PodBundleAssembler({ fsOps }).assemble({
    rigRoot: source, rigSpecPath: path.join(source, "rig.yaml"), outputDir: path.join(root, "staging"),
    bundleName: "demo", bundleVersion: "1.0.0", servicesEnabled,
  });
  return { root, source, assemble, fsOps };
}

describe("opt-in service bundles", () => {
  it.each([false, true])("uses the typed switch at the actual create/inspect routes (enabled=%s)", async enabled => {
    vi.stubEnv("OPENRIG_BUNDLE_SERVICES_ENABLED", String(enabled));
    const { root, source } = fixture(), db = createFullTestDb();
    try {
      const { app } = createTestApp(db);
      const bundlePath = path.join(root, "created.rigbundle");
      const post = (route: string, body: unknown) => app.request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const created = await post("/api/bundles/create", { specPath: path.join(source, "rig.yaml"), rigRoot: source, bundleName: "demo", bundleVersion: "1.0.0", outputPath: bundlePath });
      expect(created.status, await created.clone().text()).toBe(201);
      const extracted = path.join(root, "api-extracted"); fs.mkdirSync(extracted); await unpack(bundlePath, extracted);
      expect(filesUnder(extracted).sort()).toEqual(enabled ? ["bundle.yaml", "rig.yaml", "services/compose.yaml"] : ["bundle.yaml", "rig.yaml"]);
      const inspected = await post("/api/bundles/inspect", { bundlePath });
      expect(inspected.status).toBe(200);
      const result = await inspected.json();
      if (enabled) expect(result.behaviour.services).toHaveLength(2);
      else expect(result.behaviour).not.toHaveProperty("services");
    } finally { db.close(); }
  });
  it("keeps the selected specimen's agent and import refs inside its repository", () => {
    const repository = fileURLToPath(new URL("../../../", import.meta.url));
    const source = path.join(repository, "packages/daemon/specs/rigs/launch/secrets-manager");
    const spec = parse(fs.readFileSync(path.join(source, "rig.yaml"), "utf8"));
    const { fsOps } = fixture();
    const resolved = resolveAgentRef(spec.pods[0].members[0].agent_ref, source, fsOps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved));
    for (const agent of [resolved.resolved, ...resolved.imports]) {
      const relative = path.relative(fs.realpathSync(repository), fs.realpathSync(agent.sourcePath));
      expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(false);
      expect(fs.existsSync(path.join(agent.sourcePath, "agent.yaml"))).toBe(true);
    }
  });
  it("packs only the declared compose file at its relative path in a real archive", async () => {
    const { root, assemble } = fixture(); const { manifest } = assemble(true);
    const staging = path.join(root, "staging");
    const integrityFs = {
      readFile: (p: string) => fs.readFileSync(p, "utf8"), readFileBuffer: fs.readFileSync,
      writeFile: fs.writeFileSync, exists: fs.existsSync, walkFiles: filesUnder,
    };
    manifest.integrity = computeIntegrity(staging, integrityFs);
    fs.writeFileSync(path.join(staging, "bundle.yaml"), serializePodBundleManifest(manifest));
    const archive = path.join(root, "demo.rigbundle"); await pack(staging, archive);
    const extracted = path.join(root, "extracted"); fs.mkdirSync(extracted); await unpack(archive, extracted);
    expect(filesUnder(extracted).sort()).toEqual(["bundle.yaml", "rig.yaml", "services/compose.yaml"]);
    expect(fs.readFileSync(path.join(extracted, "services/compose.yaml"), "utf8")).toBe(compose);
  });

  it("keeps the old archive file list while disabled", () => {
    const { root, assemble } = fixture(); assemble();
    expect(filesUnder(path.join(root, "staging")).sort()).toEqual(["bundle.yaml", "rig.yaml"]);
  });

  it("preserves creation with a missing compose declaration and shows it as unresolved", () => {
    const { source, assemble } = fixture(); fs.unlinkSync(path.join(source, "services/compose.yaml"));
    expect(assemble(true).collectedFiles).not.toContain("services/compose.yaml");
    const view = describeBundleBehaviour({ files: new Map([["rig.yaml", rig]]), manifest: { schema_version: 2, rig_spec: "rig.yaml" }, generator: { openrigVersion: "test" }, digestValid: true, filesVerified: true, servicesEnabled: true });
    expect(view.state === "generated" && view.alsoRuns).toEqual(expect.arrayContaining([expect.objectContaining({ pathOrRef: "services/compose.yaml", resolution: "unresolved" })]));
  });

  const inspect = (servicesEnabled: boolean, composeText = compose) => describeBundleBehaviour({
    files: new Map([["rig.yaml", rig], ["services/compose.yaml", composeText]]),
    manifest: { schema_version: 2, rig_spec: "rig.yaml" }, generator: { openrigVersion: "test" },
    digestValid: true, filesVerified: true, servicesEnabled,
  });

  it("describes each archived service without exposing arbitrary env values or resolving host interpolation", () => {
    const view = inspect(true);
    expect(view.state).toBe("generated");
    if (view.state !== "generated") throw new Error(view.reason);
    expect(view.services).toMatchObject([
      { name: "vault", image: "hashicorp/vault:1.15", ports: ["8200:8200"], capAdd: ["IPC_LOCK"], environment: ["VAULT_DEV_ROOT_TOKEN_ID", "PRIVATE_VALUE"], downPolicy: "down" },
      { name: "worker", image: "${WORKER_IMAGE}", privileged: true, environment: ["API_KEY", "OTHER"], mounts: ["${DATA_DIR}:/data"] },
    ]);
    expect(view.services?.[0]?.waitFor).toEqual([{ url: "http://127.0.0.1:8200/v1/sys/health" }]);
    expect(view.services?.[0]?.notes.join(" ")).toMatch(/public.*dev|development/i);
    expect(view.services?.[1]?.unresolved).toEqual(expect.arrayContaining(["image", "ports", "mounts"]));
    expect(JSON.stringify(view)).not.toContain("do-not-display");
    expect(JSON.stringify(view)).not.toContain("not-a-public-default");
  });

  it("summarizes fields inherited through YAML merge keys", () => {
    const view = inspect(true, `x-common: &common
  privileged: true
  cap_add: [SYS_ADMIN]
  ports: ["0.0.0.0:80:80"]
services:
  app:
    <<: *common
    image: example/app:1
`);
    expect(view.state).toBe("generated");
    if (view.state !== "generated") throw new Error(view.reason);
    expect(view.services).toMatchObject([{ name: "app", privileged: true, capAdd: ["SYS_ADMIN"], ports: ["0.0.0.0:80:80"] }]);
  });

  it("names every unsummarized service key without exposing its values", () => {
    const view = inspect(true, `services:
  app:
    image: example/app:1
    network_mode: host
    pid: host
    user: private-user-value
    x-extra: private-extra-value
`);
    expect(view.state).toBe("generated");
    if (view.state !== "generated") throw new Error(view.reason);
    expect(view.services?.[0]?.notes).toContain("Also declared, not summarized: network_mode, pid, user, x-extra");
    expect(JSON.stringify(view)).not.toContain("private-user-value");
    expect(JSON.stringify(view)).not.toContain("private-extra-value");
  });

  it("leaves the old view unchanged while disabled", () => {
    expect(inspect(false)).not.toHaveProperty("services");
  });

  it("reports an unreadable compose declaration as unknown without refusing the view", () => {
    const view = inspect(true, "services: [broken");
    expect(view.state).toBe("generated");
    expect(view.state === "generated" && view.unknownBeforeLaunch.some(item => item.subject === "services/compose.yaml")).toBe(true);
  });
});
