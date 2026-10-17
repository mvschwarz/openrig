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

  // Content-surfaces discipline: a `?mission=` / `?slice=` value must never leave
  // the slices root. scope-audit.ts and scope-approve.ts enforce the same
  // containment; the scopes-view read routes must match them. The check is
  // lexical: the name is joined onto the root the way main already does, and
  // only a target that lands outside the root is refused.
  it("refuses a mission that escapes the slices root via .. traversal", async () => {
    const root = scaffold();
    // A real, readable folder ONE level above the slices root with a slice whose
    // PROGRESS.md holds a canary — exactly what a `../` value would reach.
    const outside = path.join(root, "..", `outside-${path.basename(root)}`);
    const secretSlice = path.join(outside, "slices", "01-secret");
    fs.mkdirSync(secretSlice, { recursive: true });
    fs.writeFileSync(path.join(secretSlice, "PROGRESS.md"), "TOP-SECRET-NARRATIVE");
    try {
      const app = appWith(root);

      const overview = await app.request("/api/scopes?mission=..%2F" + path.basename(outside));
      expect(overview.status).toBe(404);
      expect((await overview.json() as { error?: string }).error).toBe("mission_not_found");

      const narrative = await app.request(`/api/scopes/narrative?mission=..%2F${path.basename(outside)}&slice=01-secret`);
      expect(narrative.status).toBe(404);
      expect(await narrative.text()).not.toContain("TOP-SECRET-NARRATIVE");

      const slice = await app.request(`/api/scopes/slice?mission=..%2F${path.basename(outside)}&slice=01-secret`);
      expect(slice.status).toBe(404);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a slice that escapes the slices root via .. traversal", async () => {
    const root = scaffold();
    // A real, readable slice ONE level above the slices root — a `..` slice value
    // would reach it if the join were unchecked.
    const outside = path.join(root, "..", `outside-${path.basename(root)}`);
    const secretSlice = path.join(outside, "slices", "01-secret");
    fs.mkdirSync(path.join(secretSlice, "proof"), { recursive: true });
    fs.writeFileSync(path.join(secretSlice, "README.md"), `---\nid: SECRET\nstatus: spec\n---\n# secret\n\n## Intent\nLEAKED-SECRET-INTENT\n\n## Mini-requirements\n1. x\n\n## Proof contract\n- [ ] y\n`);
    fs.writeFileSync(path.join(secretSlice, "PROGRESS.md"), "TOP-SECRET-NARRATIVE");
    try {
      const app = appWith(root);
      // mission stays inside the root; only the slice name escapes.
      const rel = `../../../${path.basename(outside)}/slices/01-secret`;
      const slice = await app.request(`/api/scopes/slice?mission=release-x&slice=${encodeURIComponent(rel)}`);
      expect(slice.status).toBe(404);
      expect(await slice.text()).not.toContain("LEAKED-SECRET-INTENT");

      const narrative = await app.request(`/api/scopes/narrative?mission=release-x&slice=${encodeURIComponent(rel)}`);
      expect(narrative.status).toBe(404);
      expect(await narrative.text()).not.toContain("TOP-SECRET-NARRATIVE");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // A leading-slash name keeps its current meaning: `path.join(root, "/x")`
  // stays under the root, so the mission named `x` is still served.
  it("keeps today's meaning for a leading-slash mission name that stays inside the root", async () => {
    const root = scaffold();
    const app = appWith(root);
    const res = await app.request("/api/scopes?mission=%2Frelease-x");
    expect(res.status).toBe(200);
    const body = await res.json() as { mission: string };
    expect(body.mission).toBe("/release-x");
    fs.rmSync(root, { recursive: true, force: true });
  });

  // A name with an inner `..` that still lands inside the root keeps working.
  it("serves a mission whose inner .. still lands inside the root", async () => {
    const root = scaffold();
    const app = appWith(root);
    const res = await app.request("/api/scopes?mission=inner%2F..%2Frelease-x");
    expect(res.status).toBe(200);
    const body = await res.json() as { mission: string };
    expect(body.mission).toBe("inner/../release-x");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

