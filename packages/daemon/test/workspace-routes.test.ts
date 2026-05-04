// PL-007 Workspace Primitive v0 — workspace HTTP route tests.
//
// Pins:
//   - POST /api/workspace/validate returns the structured gap report
//   - 400 on missing root
//   - 400 on invalid workspace kind
//   - kind-agnostic invocation (no workspaceKind) returns 0 gaps when no
//     contract enforced

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workspaceRoutes } from "../src/routes/workspace.js";

let dir: string;
let app: Hono;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl007-route-"));
  app = new Hono();
  app.route("/api/workspace", workspaceRoutes());
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("workspace HTTP routes (PL-007)", () => {
  it("POST /validate returns structured gap report on knowledge canon", async () => {
    fs.writeFileSync(path.join(dir, "a.md"), "---\ndoc: a\nstatus: active\ncreated: 2026-05-04\nowner: x\n---\n", "utf-8");
    fs.writeFileSync(path.join(dir, "missing.md"), "---\ndoc: m\nstatus: active\ncreated: 2026-05-04\n---\n", "utf-8");
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dir, workspaceKind: "knowledge" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { totalFiles: number; gapCount: number; gaps: Array<{ kind: string; field: string | null }> };
    expect(body.totalFiles).toBe(2);
    expect(body.gapCount).toBe(1);
    expect(body.gaps[0]?.field).toBe("owner");
  });

  it("POST /validate rejects missing root with 400", async () => {
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /validate rejects unknown workspace kind", async () => {
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dir, workspaceKind: "rd-pod" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /validate without workspaceKind runs structural-only check", async () => {
    fs.writeFileSync(path.join(dir, "a.md"), "---\ndoc: a\n---\n", "utf-8");
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dir }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { gapCount: number; workspaceKind: string | null };
    expect(body.gapCount).toBe(0);
    expect(body.workspaceKind).toBeNull();
  });
});
