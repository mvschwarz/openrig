// The activity hook's token is compared in constant time, like every other token the daemon checks.
//
// The comparison itself cannot be observed from outside — a test that timed it would be measuring the
// host, not the code — so this pins the property that matters and can be read: the route uses the
// shared constant-time comparator and never compares a token with `===`/`!==`. The behavioural half
// (right token accepted, wrong token refused) is asserted alongside it so the structural check cannot
// pass on a route that simply stopped checking.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const SOURCE = readFileSync(fileURLToPath(new URL("../src/routes/activity.ts", import.meta.url)), "utf8");

describe("the activity hook token comparison", () => {
  it("routes every token comparison through constantTimeEqual", () => {
    expect(SOURCE).toContain('import { constantTimeEqual } from "../middleware/auth-bearer-token.js"');
    // A direct comparison of a caller-supplied token with the expected one is the shape this forbids.
    expect(SOURCE).not.toMatch(/bearerToken\s*(?:===|!==)\s*expectedToken/);
    expect(SOURCE).not.toMatch(/headerToken\s*(?:===|!==)\s*expectedToken/);
    expect(SOURCE).not.toMatch(/expectedToken\s*(?:===|!==)\s*(?:bearerToken|headerToken)/);
  });

  it("accepts the configured token and refuses a wrong one", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db, { activityHookToken: "the-configured-hook-token" });

    const accepted = await app.request("/api/activity/hooks", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer the-configured-hook-token" },
      body: JSON.stringify({ session: "dev-impl@r", state: "agent_active" }),
    });
    expect(accepted.status).not.toBe(401);

    const refused = await app.request("/api/activity/hooks", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer a-different-token" },
      body: JSON.stringify({ session: "dev-impl@r", state: "agent_active" }),
    });
    expect(refused.status).toBe(401);
    expect((await refused.json() as { code: string }).code).toBe("activity_hook_unauthorized");
    db.close();
  });
});
