import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { proofRoutes } from "../src/routes/proof.js";
import { slicesRoutes } from "../src/routes/slices.js";
import { readProjectReadiness } from "../src/domain/proof/judgments.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it.each(["proof", "slices"])("serves another event-loop turn during the %s project read without changing the result", async target => {
  const root = fs.mkdtempSync(join(tmpdir(), "proof-project-yield-")); roots.push(root);
  const missions = join(root, "missions");
  fs.mkdirSync(missions);
  fs.writeFileSync(join(root, "project.yaml"), "kind: project\nmetadata: { id: trial }\n");
  for (const name of ["alpha", "beta", "gamma"]) {
    fs.mkdirSync(join(missions, name));
    fs.writeFileSync(join(missions, name, "mission.yaml"), "kind: mission\nmetadata: { status: active }\ncomposition: { slices: [] }\n");
  }
  const readiness = readProjectReadiness(missions);
  const expected = target === "proof" ? readiness : {
    slices: [], totalCount: 0, filter: "all", boundToWorkflow: null,
    missions: Object.fromEntries(readiness.missions.map(m => [m.name, { authoredStatus: m.historicalStatus, readiness: m }])),
  };
  let sourceReady = true;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: missions,
      withMembershipBatch: (fn: () => unknown) => fn(), list: () => [],
      observedQueueCounts: () => new Map(), missionAuthoredStatuses: () => ({}),
    } as never);
    c.set("sliceDetailProjector" as never, {} as never);
    c.set("proofSourceWatch" as never, { observation: () => ({ state: sourceReady ? "watching" : "unavailable", revision: "fixture" }) } as never);
    await next();
  });
  app.route("/api/proof", proofRoutes());
  app.route("/api/slices", slicesRoutes());
  let completed = false;
  const read = app.request(`/api/${target}`).then(response => { completed = true; return response; });
  await new Promise<void>(resolve => setImmediate(resolve));
  if (completed) {
    const early = await read; expect(early.status).toBe(200);
    expect(await early.clone().json()).toMatchObject(expected);
  }
  expect(completed, "the proof read must yield before finishing the whole tree").toBe(false);
  sourceReady = false;
  const response = await read;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject(target === "proof" ? { ...expected, sourceObservation: { state: "unavailable" } } : expected);
});
