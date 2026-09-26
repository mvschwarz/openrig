// Issue #36: the Claude/Codex session_identity hook must report tokenPersisted from the stored
// state, not from token format validity. A higher-provenance (operator) token refuses the hook
// write; that only counts as persisted when the exact type and token are already stored.

import { describe, it, expect } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

const cases = [
  { runtime: "claude-code", resumeType: "claude_id", otherType: "codex_id", incoming: "0f6cf1cc-9c4e-4f7e-9d38-1c1f80f9e002" },
  { runtime: "codex", resumeType: "codex_id", otherType: "claude_id", incoming: "thread-different-session" },
] as const;

type Seed = { type: string; token: string } | null;

async function postIdentity(runtime: string, incoming: string, seed: Seed) {
  const db = createFullTestDb();
  try {
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("protected");
    const node = rigRepo.addNode(rig.id, "dev.worker", { runtime });
    const reg = new SessionRegistry(db);
    const sess = reg.registerSession(node.id, "dev-worker@protected");
    reg.updateStatus(sess.id, "running");
    if (seed) reg.updateResumeToken(sess.id, seed.type, seed.token, "operator");
    const { app } = createTestApp(db, { activityHookToken: "tok" });

    const res = await app.request("/api/activity/hooks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-openrig-activity-token": "tok" },
      body: JSON.stringify({ eventFamily: "session_identity", sessionName: "dev-worker@protected", runtime, sessionId: incoming }),
    });
    const body: unknown = await res.json();
    const tokenPersisted = body !== null && typeof body === "object" && "tokenPersisted" in body ? body.tokenPersisted : undefined;
    const stored = db.prepare("SELECT resume_type, resume_token, resume_provenance FROM sessions WHERE id = ?").get(sess.id);
    return { status: res.status, tokenPersisted, stored };
  } finally {
    db.close();
  }
}

describe("identity hook tokenPersisted reports the stored state, not format validity", () => {
  for (const { runtime, resumeType, otherType, incoming } of cases) {
    describe(runtime, () => {
      it("an ordinary hook write persists", async () => {
        expect(await postIdentity(runtime, incoming, null)).toEqual({
          status: 200,
          tokenPersisted: true,
          stored: { resume_type: resumeType, resume_token: incoming, resume_provenance: "hook" },
        });
      });

      it("a different protected operator token refuses the write and reports false", async () => {
        expect(await postIdentity(runtime, incoming, { type: resumeType, token: "operator-session" })).toEqual({
          status: 200,
          tokenPersisted: false,
          stored: { resume_type: resumeType, resume_token: "operator-session", resume_provenance: "operator" },
        });
      });

      it("an equal protected operator token reports true without downgrading provenance", async () => {
        expect(await postIdentity(runtime, incoming, { type: resumeType, token: incoming })).toEqual({
          status: 200,
          tokenPersisted: true,
          stored: { resume_type: resumeType, resume_token: incoming, resume_provenance: "operator" },
        });
      });

      it("equal token text under a different protected resume type reports false", async () => {
        expect(await postIdentity(runtime, incoming, { type: otherType, token: incoming })).toEqual({
          status: 200,
          tokenPersisted: false,
          stored: { resume_type: otherType, resume_token: incoming, resume_provenance: "operator" },
        });
      });
    });
  }
});
