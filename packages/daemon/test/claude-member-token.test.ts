import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigSpecCodec, LegacyRigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { claudeSeatTokenStep, isClaudeSeatTokenFallback, readClaudeSeatTokenRef } from "../src/domain/claude-seat-token.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { LegacyRigSpec, RigSpec } from "../src/domain/types.js";
import { createTestApp } from "./helpers/test-app.js";

// A Claude member can name its own subscription token file in the spec, so the seat's first launch already starts on
// that account. The spec and the seat's record hold the label and the path only; the file is read as Claude starts.

const opened: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(path.join(tmpdir(), "claude-member-token-")); dirs.push(dir); return dir; };
const SYNTHETIC = "synthetic-fixture-value-not-a-credential";
// There is no such file: storing the reference never reads it, and a launch starts with the existing fallback notice.
const tokenFile = path.join(tmpdir(), "no-such-dir-claude-member-token", "dev.token");
const ref = { label: "dev-sub", tokenFile };
const member = (extra: Record<string, unknown> = {}) => ({ id: "dev", agent_ref: "local:dev.agent.yaml", profile: "default",
  runtime: "claude-code", cwd: "/same/project", claude_token: { label: "dev-sub", file: tokenFile }, ...extra });
const spec = (m: Record<string, unknown>) => ({ version: "0.2", name: "tokens", pods: [{ id: "team", label: "Team", members: [m], edges: [] }], edges: [] });
const flat = (node: Record<string, unknown>) => ({ schema_version: 1, name: "flat", version: "1", nodes: [node], edges: [] });

function database() {
  const db = new Database(":memory:"); opened.push(db);
  migrate(db, ALL_MIGRATIONS);
  return db;
}

async function materialize(db: Database.Database, extra: Record<string, unknown> = {}) {
  const setup = createTestApp(db, { podInstantiatorFsOps: {
    readFile: () => 'name: dev\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []', exists: () => true,
  } });
  const raw = spec(member(extra));
  expect(RigSpecSchema.validate(raw).errors).toEqual([]);
  const result = await setup.podInstantiator.materializeStructured(raw, "/project");
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error("not materialized");
  const rigId = result.result.rigId;
  const node = setup.rigRepo.getRig(rigId)!.nodes[0]!;
  const exporter = new RigSpecExporter({ rigRepo: setup.rigRepo, sessionRegistry: setup.sessionRegistry, podRepo: new PodRepository(db) });
  return { setup, rigId, node, exported: () => RigSpecCodec.serialize(exporter.exportRig(rigId) as RigSpec) };
}

describe("a Claude member's own subscription token (claude_token)", () => {
  it("is stored on the seat when the rig is created, reaches each launch, and clears like a switched one", async () => {
    const db = database();
    const { setup, node, exported } = await materialize(db);
    expect(readClaudeSeatTokenRef(db, node.id)).toEqual(ref);
    const managed = new ClaudeManagedLaunch(db, { PATH: "/usr/bin:/bin", HOME: tmpdir() }, {}, async () => undefined);
    // The first launch and a later one carry the same step; a file that can't be read gives the existing notice.
    for (let launch = 0; launch < 2; launch++) {
      const token = managed.seatTokenLaunch(node.id);
      expect(token?.ref).toEqual(ref);
      expect(token?.step).toContain(tokenFile);
      expect(token?.warnings.some(isClaudeSeatTokenFallback)).toBe(true);
    }
    // `rig provider switch --stored-login` clears the seat's reference through this same record.
    expect(setup.rigRepo.setNodeClaudeTokenRef(node.id, null)).toBe(true);
    expect(managed.seatTokenLaunch(node.id)).toBeNull();
    expect(exported()).not.toContain("claude_token");
  });

  it("exports the seat's current reference, on pod members and on legacy flat nodes", async () => {
    const db = database();
    const { exported } = await materialize(db);
    const parsed = RigSpecCodec.parse(exported());
    expect(RigSpecSchema.normalize(parsed).pods[0]!.members[0]!.claudeTokenRef).toEqual(ref);

    expect(LegacyRigSpecSchema.validate(flat({ id: "dev", runtime: "claude-code", claude_token: { label: "dev-sub", file: tokenFile } })).errors).toEqual([]);
    const flatDb = database(), repo = new RigRepository(flatDb), rig = repo.createRig("flat");
    const node = repo.addNode(rig.id, "dev", { runtime: "claude-code", cwd: "/same/project", claudeTokenRef: ref });
    expect(readClaudeSeatTokenRef(flatDb, node.id)).toEqual(ref);
    const flatSpec = new RigSpecExporter({ rigRepo: repo, sessionRegistry: new SessionRegistry(flatDb) }).exportRig(rig.id);
    const flatParsed = LegacyRigSpecCodec.parse(LegacyRigSpecCodec.serialize(flatSpec as LegacyRigSpec));
    expect(LegacyRigSpecSchema.normalize(flatParsed).nodes[0]!.claudeTokenRef).toEqual(ref);
    expect(() => repo.addNode(rig.id, "other", { runtime: "codex", claudeTokenRef: ref })).toThrow(/claude_token/);
    // An account-home selection isn't exported, so neither is the token that goes with it.
    flatDb.prepare("UPDATE nodes SET account_home = ? WHERE id = ?").run(tempDir(), node.id);
    const homed = new RigSpecExporter({ rigRepo: repo, sessionRegistry: new SessionRegistry(flatDb) }).exportRig(rig.id);
    expect(LegacyRigSpecCodec.serialize(homed as LegacyRigSpec)).not.toContain("claude_token");
  });

  // r1: a spec-declared token gets the switch's credential-precedence check, said as a launch warning, never a refusal.
  it("warns, in the switch's terms, when the seat's settings would outrank its token", async () => {
    const db = database(), cwd = tempDir(), home = tempDir();
    // A readable token file: the warning is about what outranks it, not about the file.
    const readable = path.join(home, "dev.token");
    writeFileSync(readable, `${SYNTHETIC}\n`, { mode: 0o600 });
    const own = { label: "dev-sub", tokenFile: readable };
    mkdirSync(path.join(cwd, ".claude"));
    const project = path.join(cwd, ".claude", "settings.json");
    writeFileSync(project, JSON.stringify({ apiKeyHelper: "/bin/echo not-a-key", env: { ANTHROPIC_API_KEY: "placeholder" } }));
    const { node } = await materialize(db, { cwd, claude_token: { label: "dev-sub", file: readable } });
    const managed = new ClaudeManagedLaunch(db, { PATH: "/usr/bin:/bin", HOME: home }, {}, async () => undefined);
    const [warning, ...rest] = await managed.tokenPrecedenceWarnings(node.id, own);
    expect(rest).toEqual([]);
    expect(warning).toContain("Claude Code would use these instead");
    expect(warning).toContain(`apiKeyHelper (project settings ${project}`);
    expect(warning).toContain(`ANTHROPIC_API_KEY (the env block of project settings ${project}`);
    writeFileSync(project, "{}");
    expect(await managed.tokenPrecedenceWarnings(node.id, own)).toEqual([]);
  });

  // r2: the token step unsets the outranking names before Claude starts, so a credential in the daemon's or the seat's
  // environment doesn't outrank the token and isn't warned about. A settings file still does: Claude Code reads it itself.
  it("doesn't warn about a daemon or seat environment credential the token step removes", async () => {
    const db = database(), cwd = tempDir(), home = tempDir();
    const readable = path.join(home, "dev.token");
    writeFileSync(readable, `${SYNTHETIC}\n`, { mode: 0o600 });
    const own = { label: "dev-sub", tokenFile: readable };
    const { node } = await materialize(db, { cwd, claude_token: { label: "dev-sub", file: readable } });
    db.prepare("UPDATE nodes SET env_json = ? WHERE id = ?").run(JSON.stringify({ ANTHROPIC_AUTH_TOKEN: "placeholder" }), node.id);
    const managed = new ClaudeManagedLaunch(db, { PATH: "/usr/bin:/bin", HOME: home, ANTHROPIC_API_KEY: "placeholder" }, {}, async () => undefined);
    // The switch's own check still names both.
    expect((await managed.credentialPrecedence(node.id)).conflicts.map((c) => c.name)).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    expect(await managed.tokenPrecedenceWarnings(node.id, own)).toEqual([]);
    mkdirSync(path.join(cwd, ".claude"));
    const project = path.join(cwd, ".claude", "settings.json");
    writeFileSync(project, JSON.stringify({ apiKeyHelper: "/bin/echo not-a-key" }));
    const [warning, ...rest] = await managed.tokenPrecedenceWarnings(node.id, own);
    expect(rest).toEqual([]);
    expect(warning).toContain(`apiKeyHelper (project settings ${project}`);
    expect(warning).not.toContain("ANTHROPIC_");
  });

  // r1: a pane shell with tracing on must not print the token as the step reads and assigns it.
  it("keeps the token out of a traced shell, restores its tracing, and keeps a required step's failure", () => {
    const dir = tempDir(), tokenFile = path.join(dir, "dev.token");
    writeFileSync(tokenFile, `${SYNTHETIC}\n`, { mode: 0o600 });
    const step = claudeSeatTokenStep({ label: "dev-sub", tokenFile }, shellQuote);
    const traced = spawnSync("/bin/sh", ["-xc", `${step} && /bin/sh -c 'printf %s "$CLAUDE_CODE_OAUTH_TOKEN"'; echo traced-after`],
      { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(traced.status, traced.stderr).toBe(0);
    expect(traced.stdout).toBe(`${SYNTHETIC}traced-after\n`);
    expect(traced.stderr).not.toContain(SYNTHETIC);
    expect(traced.stderr).toContain("echo traced-after");
    const missing = claudeSeatTokenStep({ label: "dev-sub", tokenFile: path.join(dir, "missing.token") }, shellQuote, { required: true });
    const failed = spawnSync("/bin/sh", ["-xc", `${missing}; echo "rc=$?"`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(failed.stdout).toBe("rc=1\n");
  });

  // An API-key selection (#2191) isn't a subscription token: re-imported from a spec it would become one, and the
  // subscription precedence check doesn't apply to it.
  it("leaves an API-key reference out of export and out of the subscription-token precedence warning", async () => {
    const db = database(), cwd = tempDir(), repo = new RigRepository(db), rig = repo.createRig("flat");
    mkdirSync(path.join(cwd, ".claude"));
    writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "/bin/echo not-a-key" }));
    const node = repo.addNode(rig.id, "dev", { runtime: "claude-code", cwd });
    const apiKey = { ...ref, kind: "api-key" as const };
    expect(repo.setNodeClaudeTokenRef(node.id, apiKey)).toBe(true);
    const exported = new RigSpecExporter({ rigRepo: repo, sessionRegistry: new SessionRegistry(db) }).exportRig(rig.id);
    expect(LegacyRigSpecCodec.serialize(exported as LegacyRigSpec)).not.toContain("claude_token");
    const managed = new ClaudeManagedLaunch(db, { PATH: "/usr/bin:/bin", HOME: tempDir() }, {}, async () => undefined);
    expect(await managed.tokenPrecedenceWarnings(node.id, ref)).not.toEqual([]);
    expect(await managed.tokenPrecedenceWarnings(node.id, apiKey)).toEqual([]);
  });

  it.each([
    ["a label that doesn't start with a letter or digit", { claude_token: { label: "-dev", file: tokenFile } }],
    ["a relative token file", { claude_token: { label: "dev-sub", file: "tokens/dev.token" } }],
    ["a bare path", { claude_token: tokenFile }],
    ["no file", { claude_token: { label: "dev-sub" } }],
    ["a field besides label and file", { claude_token: { label: "dev-sub", file: tokenFile, token: "not-a-token" } }],
    ["a seat that isn't Claude", { runtime: "codex" }],
  ])("refuses %s when the spec is validated", (_why, extra) => {
    // The field's own refusal, not the one any unknown key gets.
    const named = (errors: string[]) => errors.filter((error) => error.includes("claude_token") && !error.includes("unknown key"));
    expect(named(RigSpecSchema.validate(spec(member(extra))).errors)).not.toEqual([]);
    const node = { id: "dev", runtime: "claude-code", claude_token: { label: "dev-sub", file: tokenFile }, ...extra };
    expect(named(LegacyRigSpecSchema.validate(flat(node)).errors)).not.toEqual([]);
  });
});
