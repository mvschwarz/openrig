import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Hono } from "hono";
const [home, sourceRoot] = process.argv.slice(2);
const moduleRoot = sourceRoot ? join(sourceRoot, "packages/daemon/src") : fileURLToPath(new URL("../../dist/", import.meta.url));
const load = (name) => import(pathToFileURL(join(moduleRoot, name + (sourceRoot ? ".ts" : ".js"))));
const { collectClaudeStatuslineSignals } = await load("domain/provider/claude-usage-reader");
const { collectFourBlockReadModel } = await load("domain/provider/provider-collect");
const { providerRoutes } = await load("routes/provider");
const seat = "worker@reset-fixture";
const now = "2026-10-01T12:00:00.000Z";
const cases = [
  { name: "both-exhausted", five: { usedPercent: 100, resetsAt: "2026-10-01T13:00:00.000Z" }, weekly: { usedPercent: 100, resetsAt: "2026-10-05T12:00:00.000Z" }, expected: "2026-10-05T12:00:00.000Z" },
  { name: "only-five-exhausted", five: { usedPercent: 100, resetsAt: "2026-10-01T13:00:00.000Z" }, weekly: { usedPercent: 30, resetsAt: "2026-10-05T12:00:00.000Z" }, expected: "2026-10-01T13:00:00.000Z" },
  { name: "offset-order", five: { usedPercent: 100, resetsAt: "2026-10-02T15:00:00+04:00" }, weekly: { usedPercent: 100, resetsAt: "2026-10-02T12:00:00Z" }, expected: "2026-10-02T12:00:00Z" },
  { name: "one-unparseable-reset", five: { usedPercent: 100, resetsAt: "2026-10-01T13:00:00.000Z" }, weekly: { usedPercent: 100, resetsAt: "unknown" }, expected: undefined },
];
for (const test of cases) {
  const file = join(home, `${test.name}.json`);
  writeFileSync(file, JSON.stringify({ seatSession: seat, accountKind: "subscription", asOf: now,
    rateLimits: { five_hour: test.five, seven_day: test.weekly } }));
  const signals = collectClaudeStatuslineSignals({ listClaudeSeats: () => [{ seatSession: seat }],
    readCacheRaw: () => readFileSync(file, "utf8"), now: () => now });
  const model = collectFourBlockReadModel({ readCodexAuth: () => ({ profiles: [], seats: [] }),
    listSeats: () => [{ seatSession: seat, rigName: "reset-fixture", runtime: "claude-code", lifecycleState: "running" }],
    collectSignals: () => signals, now: () => now });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("providerService", { getReadModel: async () => model }); await next(); });
  app.route("/api/provider", providerRoutes());
  const response = await app.request("/api/provider/usage");
  assert.equal(response.status, 200);
  const row = (await response.json()).hostUsage[0];
  assert.equal(row.state, "limited");
  assert.equal(row.resetsAt, test.expected, test.name);
  assert.deepEqual(model.signals, signals, "raw per-window facts preserved");
  assert.deepEqual(row.windows.map(w => w.resetsAt), [test.five.resetsAt, test.weekly.resetsAt]);
}
console.log(JSON.stringify({ scenarios: cases.map(test => test.name), cacheCollectorAndRoute: true }));
