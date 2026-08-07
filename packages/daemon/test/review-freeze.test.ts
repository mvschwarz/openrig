// OPR.0.4.4.20 FR-6 — approval-triggered frozen export ACs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { realpathSync, writeFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { ReviewGatherer } from "../src/domain/review/gather.js";
import { FileWriteService } from "../src/domain/files/file-write-service.js";
import { reviewRoutes } from "../src/routes/review.js";
import { makeFixtureWorkspace, writeFixtureSlice, writeFullGateSet, type FixtureWorkspace } from "./review-fixtures.js";

const NOW = "2026-07-04T12:00:00.000Z";

describe("POST /api/review/freeze", () => {
  let ws: FixtureWorkspace;
  let db: Database.Database;
  let app: Hono;
  let gatherer: ReviewGatherer;

  function insertApproveAudit(sliceId: string) {
    db.prepare(
      `INSERT INTO mission_control_actions (action_id, action_verb, qitem_id, actor_session, acted_at, audit_notes_json)
       VALUES (?, 'approve', NULL, 'approver@host', ?, ?)`,
    ).run(
      `act-${sliceId}`,
      NOW,
      JSON.stringify({ kind: "scope-approval", scope_tier: "slice", scope_id: sliceId, scope_path: `x/${sliceId}`, approval_scope: "delivery", on_behalf_of: null }),
    );
  }

  beforeEach(() => {
    ws = makeFixtureWorkspace();
    db = createDb(":memory:");
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema, queueTransitionsSchema, missionControlActionsSchema, queueItemSummarySchema]);
    const indexer = new SliceIndexer({ slicesRoot: ws.root, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    const allowlist = [{ name: "ws", canonicalPath: realpathSync(ws.root) }];
    const writeService = new FileWriteService({ allowlist, auditFilePath: path.join(ws.root, "audit.jsonl") });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("reviewGatherer" as never, gatherer);
      c.set("fileWriteService" as never, writeService);
      c.set("filesAllowlist" as never, allowlist);
      await next();
    });
    app.route("/api/review", reviewRoutes());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  });

  function approvedSlice(name: string): string {
    const dir = writeFixtureSlice(ws, "release-t", name, {
      id: `OPR.T.${name}`,
      intent: "Founder words.",
      prd: { miniReqs: ["one thing"], proofContract: ["a screenshot"] },
      approvedBy: "founder-delegate@host",
      approvedAt: NOW,
    });
    insertApproveAudit(`OPR.T.${name}`);
    return dir;
  }

  function freeze(name: string) {
    return app.request("/api/review/freeze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "slice", name, actor: "approver@host" }),
    });
  }

  // P21 I5 — review freeze is a founder-visible surface (the hill-climb): resolveActorWithDeferral.
  function freezeAs(name: string, session: string, bodyActor?: string) {
    return app.request("/api/review/freeze", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": session },
      body: JSON.stringify({ scope: "slice", name, ...(bodyActor !== undefined ? { actor: bodyActor } : {}) }),
    });
  }
  function lastAuditRow(): { actor: string; identity_provenance: string | null } {
    const lines = fs.readFileSync(path.join(ws.root, "audit.jsonl"), "utf8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1]!) as { actor: string; identity_provenance: string | null };
  }

  it("freeze — header present derives the actor + stamps the audit identity_provenance transport:v1", async () => {
    const dir = approvedSlice("40-id");
    writeFullGateSet(dir, "40-id", "cand40");
    const res = await freezeAs("40-id", "cli@host");
    expect(res.status).toBe(200);
    const row = lastAuditRow();
    expect(row.actor).toBe("cli@host");
    expect(row.identity_provenance).toBe("transport:v1");
  });

  it("freeze — header present + differing body actor → 409 identity_mismatch", async () => {
    const dir = approvedSlice("41-id");
    writeFullGateSet(dir, "41-id", "cand41");
    const res = await freezeAs("41-id", "cli@host", "mallory@host");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("identity_mismatch");
  });

  it("freeze — header absent records the body actor CLAIMED-era (identity_provenance null, never-break)", async () => {
    const dir = approvedSlice("42-id");
    writeFullGateSet(dir, "42-id", "cand42");
    const res = await freeze("42-id"); // no header, body actor approver@host (the UI deferral path)
    expect(res.status).toBe(200);
    const row = lastAuditRow();
    expect(row.actor).toBe("approver@host");
    expect(row.identity_provenance).toBeNull();
  });

  it("freeze — header absent + no body actor → 400", async () => {
    const dir = approvedSlice("43-id");
    writeFullGateSet(dir, "43-id", "cand43");
    const res = await app.request("/api/review/freeze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "slice", name: "43-id" }),
    });
    expect(res.status).toBe(400);
  });

  it("writes exactly one self-contained HTML file: inlined images, video by LINK with poster, no video bytes, no external fetches", async () => {
    const dir = approvedSlice("30-freeze");
    // A tiny valid PNG + a "video" file + its poster, referenced from PROOF.md.
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    writeFileSync(path.join(dir, "proof", "shot.png"), png);
    writeFileSync(path.join(dir, "proof", "walk.mp4"), Buffer.alloc(4096, 7));
    writeFileSync(path.join(dir, "proof", "walk.png"), png);
    writeFileSync(path.join(dir, "PROOF.md"), "# Proof\n\n![shot](proof/shot.png)\n\n<video src=\"proof/walk.mp4\"></video>\n");
    writeFullGateSet(dir, "30-freeze", "cand9");

    const res = await freeze("30-freeze");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alreadyFrozen).toBe(false);

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("REVIEW-OPR.T.30-freeze-2026-07-04.html");
    const html = fs.readFileSync(path.join(dir, files[0]!), "utf8");
    expect(html).toContain("data:image/png;base64,"); // images inlined
    expect(html).toContain('href="proof/walk.mp4"'); // video by link
    expect(html).not.toContain(Buffer.alloc(64, 7).toString("base64").slice(0, 40)); // no video bytes
    expect(html).not.toMatch(/src="https?:/); // no external fetches
    expect(html).not.toMatch(/href="https?:/);
    expect(html).toContain('class="locked"'); // verified proof-lock stamp renders solid
    expect(html).toContain("proof-lock (done)");
    expect(html).toContain("CLEAR"); // verbatim verdict tokens survive into the export
    // The one structure, statically mirrored — no superseded section survives.
    expect(html).toContain("<h2>Intent</h2>");
    expect(html).toContain("<h2>Plan</h2>");
    expect(html).toContain("<h2>Delivered</h2>");
    expect(html).not.toContain("Requirements (concise)");
    expect(html).not.toContain("item join");
    expect(html).not.toContain("<h2>Acceptance</h2>");
  });

  it("re-invoking for the same approval is idempotent — one file, no rewrite, alreadyFrozen=true", async () => {
    approvedSlice("31-idem");
    const first = await (await freeze("31-idem")).json();
    expect(first.alreadyFrozen).toBe(false);
    const statBefore = fs.statSync(first.path);
    const second = await (await freeze("31-idem")).json();
    expect(second.ok).toBe(true);
    expect(second.alreadyFrozen).toBe(true);
    expect(fs.statSync(first.path).mtimeMs).toBe(statBefore.mtimeMs); // frozen exports never rewritten
  });

  it("recomposition (GET) after freeze never rewrites the frozen file", async () => {
    approvedSlice("32-recompose");
    const { path: frozen } = await (await freeze("32-recompose")).json();
    const before = fs.statSync(frozen).mtimeMs;
    await app.request("/api/review/slice/32-recompose");
    await app.request("/api/review/slice/32-recompose");
    expect(fs.statSync(frozen).mtimeMs).toBe(before);
  });

  it("409s a freeze with no approval stamp — the stamp is the only trigger", async () => {
    writeFixtureSlice(ws, "release-t", "33-unstamped", { intent: "i", prd: { miniReqs: ["m"] } });
    const res = await freeze("33-unstamped");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("stamp_missing");
  });

  it("renders the UNVERIFIED stamp loudly when frontmatter claims approval with no audit row", async () => {
    // Approval stamp in frontmatter but NO matching mission_control_actions row.
    writeFixtureSlice(ws, "release-t", "34-unverified", {
      id: "OPR.T.34",
      intent: "i",
      prd: { miniReqs: ["m"] },
      approvedBy: "someone@host",
      approvedAt: NOW,
    });
    const res = await freeze("34-unverified");
    expect(res.status).toBe(200); // the freeze still renders — loudly labeled
    const { path: frozen } = await res.json();
    const html = fs.readFileSync(frozen, "utf8");
    expect(html).toContain("UNVERIFIED proof-lock (done) stamp");
    expect(html).not.toContain('class="locked"'); // never renders the verified banner
  });

  it("returns the structured allowlist error when the slice folder is outside every allowlist root", async () => {
    // Rebuild the app with an allowlist that does NOT cover the workspace.
    const otherRoot = fs.mkdtempSync(path.join(ws.root, "..", "other-"));
    const allowlist = [{ name: "elsewhere", canonicalPath: realpathSync(otherRoot) }];
    const writeService = new FileWriteService({ allowlist, auditFilePath: path.join(otherRoot, "audit.jsonl") });
    const narrowApp = new Hono();
    narrowApp.use("*", async (c, next) => {
      c.set("reviewGatherer" as never, gatherer);
      c.set("fileWriteService" as never, writeService);
      c.set("filesAllowlist" as never, allowlist);
      await next();
    });
    narrowApp.route("/api/review", reviewRoutes());
    approvedSlice("35-outside");
    const res = await narrowApp.request("/api/review/freeze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "slice", name: "35-outside", actor: "a@h" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("allowlist_missing");
    expect(body.hint).toContain("OPENRIG_FILES_ALLOWLIST");
    fs.rmSync(otherRoot, { recursive: true, force: true });
  });

  // rev1 fixback at d6135921 — the slice-19 path-containment class: the frozen
  // export must NEVER inline content from outside the slice dir, whatever the
  // agent-authored markdown says.
  it("traversal media refs render the muted outside-slice branch and are NEVER inlined", async () => {
    const dir = approvedSlice("36-traversal");
    // A secret file OUTSIDE the slice dir (inside the workspace so it exists).
    const outside = path.join(ws.root, "outside-secret.png");
    const secret = Buffer.from("89504e470d0a1a0a5345435245545f4d41524b4552", "hex");
    writeFileSync(outside, secret);
    writeFileSync(
      path.join(dir, "PROOF.md"),
      "# Proof\n\n![t1](../../outside-secret.png)\n\n![t2](proof/sub/../../../../outside-secret.png)\n\n<video src=\"../../outside-secret.mp4\"></video>\n",
    );

    const res = await freeze("36-traversal");
    expect(res.status).toBe(200);
    const { path: frozen } = await res.json();
    const html = fs.readFileSync(frozen, "utf8");
    expect(html).not.toContain(secret.toString("base64").slice(0, 24)); // never inlined
    expect((html.match(/media outside slice dir/g) ?? []).length).toBe(3); // visible, per ref
    expect(html).not.toContain('href="../../outside-secret.mp4"'); // no escaping link either
  });

  it("a symlink inside the slice pointing outside is refused (realpath containment)", async () => {
    const dir = approvedSlice("37-symlink");
    const outside = path.join(ws.root, "outside-symlinked.png");
    const secret = Buffer.from("89504e470d0a1a0a53594d4c494e4b5f4d41524b", "hex");
    writeFileSync(outside, secret);
    fs.symlinkSync(outside, path.join(dir, "proof", "inside.png"));
    writeFileSync(path.join(dir, "PROOF.md"), "# Proof\n\n![s](proof/inside.png)\n");

    const { path: frozen } = await (await freeze("37-symlink")).json();
    const html = fs.readFileSync(frozen, "utf8");
    expect(html).not.toContain(secret.toString("base64").slice(0, 24));
    expect(html).toContain("media outside slice dir");
  });

  it("404s an unknown slice and validates the request body", async () => {
    expect((await freeze("nope")).status).toBe(404);
    const bad = await app.request("/api/review/freeze", { method: "POST", body: "not json" });
    expect(bad.status).toBe(400);
  });
});
