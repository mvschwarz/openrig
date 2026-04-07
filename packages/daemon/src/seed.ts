/**
 * Seed script — creates a sample rig with nodes and edges for visual QA.
 * Usage: npx tsx packages/daemon/src/seed.ts [dbPath]
 */
import { createDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { coreSchema } from "./db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "./db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "./db/migrations/003_events.js";
import { RigRepository } from "./domain/rig-repository.js";
import { SessionRegistry } from "./domain/session-registry.js";

const dbPath = process.argv[2] ?? "openrig.sqlite";

console.log(`Seeding database: ${dbPath}`);

const db = createDb(dbPath);
migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema]);

const repo = new RigRepository(db);

// Create a sample rig
const rig = repo.createRig("r99");
console.log(`Created rig: ${rig.id} (${rig.name})`);

// Add nodes — use r99-demo-* names to avoid colliding with real tmux sessions
const orch = repo.addNode(rig.id, "demo1-lead", { role: "orchestrator", runtime: "claude-code", model: "opus" });
const impl = repo.addNode(rig.id, "demo1-impl", { role: "worker", runtime: "claude-code", model: "opus" });
const qa = repo.addNode(rig.id, "demo1-qa", { role: "qa", runtime: "codex", model: "gpt-5.4" });
const reviewer = repo.addNode(rig.id, "demo1-rev", { role: "reviewer", runtime: "claude-code", model: "opus" });

console.log(`Created nodes: ${orch.logicalId}, ${impl.logicalId}, ${qa.logicalId}, ${reviewer.logicalId}`);

// Add edges
repo.addEdge(rig.id, orch.id, impl.id, "delegates_to");
repo.addEdge(rig.id, orch.id, qa.id, "delegates_to");
repo.addEdge(rig.id, impl.id, qa.id, "can_observe");
repo.addEdge(rig.id, orch.id, reviewer.id, "delegates_to");

console.log("Created edges: orch->impl, orch->qa, impl->qa, orch->reviewer");

// Add a binding with cmuxSurface to the orchestrator for focus click-through QA
const sessionRegistry = new SessionRegistry(db);
sessionRegistry.updateBinding(orch.id, {
  tmuxSession: "r99-demo1-lead",
  cmuxSurface: "surface-orch-1",
});
console.log("Added cmuxSurface binding to orch1-lead (surface-orch-1)");

db.close();
console.log("Done. Start daemon with: OPENRIG_DB=" + dbPath + " npx tsx packages/daemon/src/index.ts");
