// SCOPES VIEW routes — wired through a Hono app with a fixture slices root.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scopesRoutes } from "../src/routes/scopes.js";

function scaffold(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scopes-rt-"));
  const sliceDir = path.join(root, "release-x", "slices", "01-thing");
  fs.mkdirSync(path.join(sliceDir, "proof"), { recursive: true });
  fs.writeFileSync(path.join(sliceDir, "README.md"), `---
id: OPR.X.1
status: spec
stage: building
approved-spec-by: pm@x
approved-spec-at: 2026-08-06T10:00:00.000Z
---

# Slice 01 — thing

## Intent

Do the thing.

## Mini-requirements

1. It works.

## Proof contract

- [ ] Works — captured.
- [ ] Survives restart — captured.
`);
  fs.writeFileSync(path.join(sliceDir, "proof", "qa.md"), `---
artifact_type: qa
verdict: PASS
evidences:
  - "1"
---
x`);
  fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "narrative only");
  return root;
}

function appWith(root: string): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: root } as never);
    await next();
  });
  app.route("/api/scopes", scopesRoutes());
  return app;
}

describe("scopes routes", () => {
  it("overview + detail + narrative serve store-direct", async () => {
    const root = scaffold();
    const app = appWith(root);
    const overview = await (await app.request("/api/scopes")).json() as { missions: Array<{ mission: string; slices: Array<{ proof: { paired: number; total: number } }> }> };
    expect(overview.missions[0]!.mission).toBe("release-x");
    expect(overview.missions[0]!.slices[0]!.proof).toEqual({ paired: 1, total: 2 });
    const detail = await (await app.request("/api/scopes/slice?mission=release-x&slice=01-thing")).json() as { intent: string; proofContract: Array<{ paired: boolean }> };
    expect(detail.intent).toBe("Do the thing.");
    expect(detail.proofContract.map((p) => p.paired)).toEqual([true, false]);
    const narrative = await (await app.request("/api/scopes/narrative?mission=release-x&slice=01-thing")).json() as { content: string };
    expect(narrative.content).toBe("narrative only");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
