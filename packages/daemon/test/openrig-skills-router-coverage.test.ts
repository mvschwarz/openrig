import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { resolveExternal } from "../src/domain/gateway/external-admission.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { buildProductionPackage } from "./helpers/eval-ref-resolution.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PLUGIN_ROOT = join(REPO_ROOT, "packages/daemon/assets/plugins/openrig-core");
const SPEC_ROOT = join(REPO_ROOT, "packages/daemon/specs/agents/shared/skills");
const BUILT_PACKS = buildProductionPackage(REPO_ROOT);
afterAll(BUILT_PACKS.cleanup);
const LAYOUT = JSON.parse(
  readFileSync(join(REPO_ROOT, "scripts/skill-edge-layout.generated.json"), "utf8"),
) as Layout;
const INDEX = readFileSync(join(PLUGIN_ROOT, "skills/openrig-skills/SKILL.md"), "utf8");

type Layout = {
  skills: Record<string, { edges: string[]; category: string | null }>;
};

const registry = {
  ok: true as const,
  entities: [{
    entityId: "human-founder",
    class: "human" as const,
    displayName: "Founder",
    address: "human-founder@external",
    connectorBindings: [{
      kind: "slack" as const,
      connectorRef: "primary",
      secretsRef: "env:SLACK_BOT_TOKEN",
      role: "primary" as const,
      handle: "UFOUNDER",
    }],
    prefs: { deliveryClass: "B" as const },
  }],
};

const scratchHomes: string[] = [];
afterEach(() => {
  for (const home of scratchHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function indexSection(markdown: string): string {
  return markdown.match(/\n## The index\n([\s\S]*?)\n## Need more than what ships here\?/)?.[1] ?? "";
}

function namedRows(markdown: string): string[] {
  return [...markdown.matchAll(/^- \*\*([^*]+)\*\*/gm)].map((match) => match[1]!);
}

function membershipSelector(markdown: string): string | null {
  return markdown.match(/^> Membership rule \(`([^`]+)`\):/m)?.[1] ?? null;
}

function membershipFor(selector: string | null, layout: Layout): string[] {
  if (selector !== "layout.skills[*].edges.length > 0") {
    throw new Error(`unsupported or missing index membership rule: ${selector ?? "<none>"}`);
  }
  return Object.entries(layout.skills)
    .filter(([, entry]) => entry.edges.length > 0)
    .map(([skill]) => skill)
    .sort();
}

function coverage(markdown: string, layout: Layout): { dark: string[]; dead: string[]; duplicates: string[] } {
  const expected = membershipFor(membershipSelector(markdown), layout);
  const rows = namedRows(indexSection(markdown));
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(row, (seen.get(row) ?? 0) + 1);
  return {
    dark: expected.filter((skill) => !seen.has(skill)),
    dead: [...seen.keys()].filter((skill) => !expected.includes(skill)).sort(),
    duplicates: [...seen.entries()].filter(([, count]) => count !== 1).map(([skill]) => skill).sort(),
  };
}

function spine(markdown: string): string[] {
  const body = markdown.match(
    /### Always loaded — the universal spine \(open its body when its moment hits\)\n([\s\S]*?)\n### Load when/,
  )?.[1] ?? "";
  return namedRows(body).sort();
}

function pluginSkills(): string[] {
  const manifest = JSON.parse(
    readFileSync(join(PLUGIN_ROOT, ".codex-plugin/plugin.json"), "utf8"),
  ) as { skills: string };
  const root = resolve(PLUGIN_ROOT, manifest.skills);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function builtinLibrary(): ContextPackLibraryService {
  const library = new ContextPackLibraryService({
    roots: [{ path: BUILT_PACKS.dir, sourceType: "builtin" }],
  });
  const scan = library.scan();
  expect(scan.errors).toEqual([]);
  return library;
}

describe("S22 OpenRig skill router coverage", () => {
  it("derives one complete index from its own stated membership rule", () => {
    expect(membershipSelector(INDEX)).toBe("layout.skills[*].edges.length > 0");
    expect(coverage(INDEX, LAYOUT)).toEqual({ dark: [], dead: [], duplicates: [] });
  });

  it("the zero/zero detector is RED-able for seeded dark and dead routes", () => {
    const darkLayout = structuredClone(LAYOUT);
    darkLayout.skills["seeded-dark-pack"] = { edges: ["spec"], category: "core" };
    expect(coverage(INDEX, darkLayout).dark).toContain("seeded-dark-pack");

    const deadIndex = INDEX.replace(
      "\n## Need more than what ships here?",
      "\n- **seeded-dead-route** — fixture only.\n\n## Need more than what ships here?",
    );
    expect(coverage(deadIndex, LAYOUT).dead).toContain("seeded-dead-route");
  });

  it("the always-loaded spine equals the Codex-visible plugin catalog", () => {
    const expected = Object.entries(LAYOUT.skills)
      .filter(([, entry]) => entry.edges.includes("plugin"))
      .map(([skill]) => skill)
      .sort();
    expect(spine(INDEX)).toEqual(expected);
    expect(pluginSkills()).toEqual(expected);
  });

  it("a fresh receiver can discover and retrieve both router refs from one projection", () => {
    expect(pluginSkills()).toContain("openrig-skills");
    const library = builtinLibrary();
    const full = library.getByRef("skills/core/openrig-skills");
    expect(full).not.toBeNull();
    const byName = library.list().filter((entry) => entry.name === "openrig-skills");
    expect(byName).toHaveLength(1);
    expect(byName[0]?.relativePath).toBe("skills/core/openrig-skills");

    const pluginBytes = readFileSync(join(PLUGIN_ROOT, "skills/openrig-skills/SKILL.md"), "utf8");
    const specBytes = readFileSync(join(SPEC_ROOT, "core/openrig-skills/SKILL.md"), "utf8");
    const servedBytes = readFileSync(join(full!.sourcePath, "SKILL.md"), "utf8");
    expect(specBytes).toBe(pluginBytes);
    expect(servedBytes).toBe(pluginBytes);
  });

  it("fresh Codex teaching routes a durable registered-human park to one Slack receipt", async () => {
    expect(pluginSkills()).toContain("messaging-the-human");
    const library = builtinLibrary();
    const teaching = library.getByRef("skills/core/messaging-the-human");
    expect(teaching).not.toBeNull();
    const taught = readFileSync(join(teaching!.sourcePath, "SKILL.md"), "utf8");
    expect(taught).toContain("rig gateway human list --json");
    expect(taught).toContain("Use `humans[].entityId` to derive the durable blocker as `<entityId>@host`");
    expect(taught).toContain("The entity id must use the human-seat prefix (`human` or `human-...`)");
    expect(taught).toMatch(/The returned\s+`humans\[\]\.address` is the gateway delivery address, not the `--on` value/);
    expect(taught).toContain("rig queue block <qitem-id> --on <entityId>@host");
    expect(taught).toMatch(/gateway.*Slack.*same row/is);
    expect(taught).toMatch(/any seat.*escalat/is);
    expect(taught).toMatch(/rig send.*agent.*terminal.*not.*Slack/is);

    const db: Database.Database = createDb();
    migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry } as never);
    const home = mkdtempSync(join(tmpdir(), "s22-human-route-"));
    scratchHomes.push(home);
    try {
      const row = await repo.create({
        sourceSession: "dev-qa@v-openrig-build",
        destinationSession: "orch-lead@v-openrig-build",
        body: "a founder decision is required",
        nudge: false,
      });
      const registeredHuman = registry.entities[0]!;
      const taughtBlocker = `${registeredHuman.entityId}@host`;
      repo.update({
        qitemId: row.qitemId,
        actorSession: "dev-qa@v-openrig-build",
        state: "blocked",
        blockedOn: taughtBlocker,
        summary: "Choose the release boundary",
        evidenceRef: "/proof/SPEC.md",
        transitionNote: "parked with exact continuation",
      });

      const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
      const [alert] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
      expect(alert).toMatchObject({
        qitemId: row.qitemId,
        destinationSession: "human-founder@external",
        sourceSession: "orch-lead@v-openrig-build",
        ownerNotificationLevel: "ALERT",
      });

      const secrets = join(home, "slack.env");
      writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
      saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
      const posts: Array<Record<string, unknown>> = [];
      const wire = buildSlackGatewayWire({
        home,
        queueRepo: repo,
        registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
        outboundIntervalMs: 60_000,
        fetchImpl: async (_url, init) => {
          posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true, ts: "1724.0001" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      try {
        wire.startServices?.();
        expect(wire.dispatcher.dispatch(OUTBOUND_OP, alert!.destinationSession!, alert)).toMatchObject({ ok: true });
        await new Promise((resolveWait) => setTimeout(resolveWait, 30));
        expect(posts).toHaveLength(1);
        const posted = JSON.stringify(posts[0]);
        expect(posted).toContain("a founder decision is required");
        expect(posted).not.toContain("<@UFOUNDER>");
        expect(await ports.listHumanAlerts({ minimumLevel: "NOTICE" })).toEqual([]);
        expect(
          repo.listTransitions(row.qitemId).filter((transition) =>
            transition.transitionNote?.startsWith("slack-owner-notification-posted "),
          ),
        ).toHaveLength(1);
      } finally {
        wire.stop();
      }
    } finally {
      db.close();
    }
  });

  it("preserves terminal send semantics and fails loud for an unregistered human", () => {
    const sendSource = readFileSync(join(REPO_ROOT, "packages/cli/src/commands/send.ts"), "utf8");
    expect(sendSource).toContain('.description("Send a message to an agent\'s terminal")');

    const unresolved = resolveExternal("not-registered", registry.entities);
    expect(unresolved.kind).toBe("unregistered");
    if (unresolved.kind === "unregistered") {
      expect(unresolved.error).toMatch(/not.*registered|no registered/i);
      expect(unresolved.error).toMatch(/rig gateway human add/);
      expect(unresolved.error).toMatch(/NOT downgraded to an agent seat/i);
    }
  });
});
