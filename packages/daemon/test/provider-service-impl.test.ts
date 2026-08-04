// Slice-04 (OPR.0.5.0.4) C1 — production ProviderService wiring pins (getReadModel over injected
// deps; precheck fail-closed on unknown auth per BR-3; switch never fabricates success).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";

const ASOF = "2026-08-04T00:00:00.000Z";

function emptyCodexHomeEnv(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "provider-impl-codex-"));
  return { CODEX_HOME: home } as NodeJS.ProcessEnv;
}

function makeSvc() {
  return new ProviderServiceImpl({
    db: createFullTestDb(),
    listRigs: () => [], // no rigs → no seats; getReadModel never touches getNodeInventory
    env: emptyCodexHomeEnv(),
    now: () => ASOF,
  });
}

describe("ProviderServiceImpl — production getReadModel/precheck/switch wiring", () => {
  it("getReadModel over an empty codex home + no rigs is a well-formed empty four-block", async () => {
    const model = await makeSvc().getReadModel();
    expect(model).toEqual({ accounts: [], bindings: [], signals: [], asOf: ASOF });
  });

  it("precheck for an unknown/absent target fails CLOSED (target_auth_unknown), never safe", async () => {
    const r = await makeSvc().precheck({ seat: "dev-driver@rig", toAccount: "no-such-account" });
    expect(r.safe).toBe(false);
    if (r.safe === false) expect(r.reasons).toContain("target_auth_unknown");
  });

  it("switchAccount precheck-gates to failed_safely (never fabricates succeeded)", async () => {
    const r = await makeSvc().switchAccount({ seat: "dev-driver@rig", toAccount: "no-such-account", forceUnsafe: false });
    expect(r.outcome).toBe("failed_safely");
    if (r.outcome === "failed_safely") expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("switchAccount with forceUnsafe still cannot succeed — the switch-exec D seam is unwired, so honest failed_safely", async () => {
    const r = await makeSvc().switchAccount({ seat: "dev-driver@rig", toAccount: "no-such-account", forceUnsafe: true });
    expect(r.outcome).toBe("failed_safely");
    if (r.outcome === "failed_safely") expect(r.reasons).toContain("switch_execution_not_yet_wired");
  });

  it("getReadModel surfaces Claude statusline signals from the collectClaudeSignals dep (C3 wiring)", async () => {
    const sig = { provider: "claude" as const, accountRef: "sub", sourceClass: "unknown" as const, authority: "unknown" as const, asOf: ASOF, unknownReason: "claude_no_statusline_cache_yet", automationUse: "do_not_automate" as const };
    const svc = new ProviderServiceImpl({ db: createFullTestDb(), listRigs: () => [], env: emptyCodexHomeEnv(), now: () => ASOF, collectClaudeSignals: () => [sig] });
    const model = await svc.getReadModel();
    expect(model.signals).toEqual([sig]);
  });
});
