import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { proofRoutes } from "../src/routes/proof.js";
import { readProjectReadiness } from "../src/domain/proof/judgments.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("serves another event-loop turn during a whole-project proof read without changing the result", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "proof-project-yield-")); roots.push(root);
  const missions = join(root, "missions");
  fs.mkdirSync(missions);
  fs.writeFileSync(join(root, "project.yaml"), "kind: project\nmetadata: { id: trial }\n");
  for (const name of ["alpha", "beta", "gamma"]) {
    fs.mkdirSync(join(missions, name));
    fs.writeFileSync(join(missions, name, "mission.yaml"), "kind: mission\nmetadata: { status: active }\ncomposition: { slices: [] }\n");
  }
  const expected = readProjectReadiness(missions);
  let sourceReady = true;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: missions } as never);
    c.set("proofSourceWatch" as never, { observation: () => ({ state: sourceReady ? "watching" : "unavailable", revision: "fixture" }) } as never);
    await next();
  });
  app.route("/api/proof", proofRoutes());
  let completed = false;
  const read = app.request("/api/proof").then(response => { completed = true; return response; });
  await new Promise<void>(resolve => setImmediate(resolve));
  if (completed) {
    const early = await read; expect(early.status).toBe(200);
    expect(await early.clone().json()).toMatchObject(expected);
  }
  expect(completed, "the proof read must yield before finishing the whole tree").toBe(false);
  sourceReady = false;
  const response = await read;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ...expected, sourceObservation: { state: "unavailable" } });
});
