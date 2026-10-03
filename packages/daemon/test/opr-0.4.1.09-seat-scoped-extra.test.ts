// OPR.0.4.1.09 — the post-compaction restore prompt must NEVER inject another seat's
// extra ("post-compact-extra"). The 2026-06-20 defect: the SINGLE global
// post-compact-extra.md held advisor-lead@kernel state and BOTH a delivery seat and a
// pm seat were told to read it. Fix: resolve the extra FOR THIS SEAT — prefer a per-seat
// file; refuse a global that declares a DIFFERENT seat. A generic/undeclared extra is
// still allowed (valid for any seat); only an explicit seat MISMATCH is refused.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import type { SessionTransport } from "../src/domain/session-transport.js";
import type { ClaudeCompactionPolicy, SettingsStore } from "../src/domain/user-settings/settings-store.js";

function makeSettingsStore(policy: ClaudeCompactionPolicy): SettingsStore {
  return { resolveClaudeCompactionPolicy: vi.fn(() => policy) } as unknown as SettingsStore;
}
function makeSessionTransport() {
  const send = vi.fn(async () => ({ ok: true }));
  return { transport: { send } as unknown as SessionTransport, send };
}
function policyWithExtra(messageFilePath: string): ClaudeCompactionPolicy {
  return {
    enabled: true, thresholdPercent: 80,
    preCompactInstruction: "prep", compactInstruction: "",
    messageInline: "", messageFilePath,
    postRestoreAuditInstruction: "audit",
  };
}
function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "opr0419-")); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ } });

// Drive prep -> /compact -> turn_boundary -> restore_prompt; return the restore prompt text.
async function restorePromptFor(messageFilePath: string, seat: string): Promise<string> {
  const settings = makeSettingsStore(policyWithExtra(messageFilePath));
  const { transport, send } = makeSessionTransport();
  const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
    dedupWindowMs: 60_000, postCompactRestoreCooldownMs: 0, openrigHome: home,
    resolveOccupantGeneration: () => "test-generation",
  });
  let now = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await enforcer.maybeAutoCompact({ sessionName: seat, runtime: "claude-code", usedPercentage: 90 }); // prep
  const attempt = enforcer.getPreparationState(seat)!;
  expect(attempt).toMatchObject({ status: "waiting", occupantGeneration: "test-generation" });
  writeFile(attempt.mapPath + ".tmp", `# Restore map\n${attempt.marker}\n`);
  fs.renameSync(attempt.mapPath + ".tmp", attempt.mapPath);
  now += 61_000;
  expect(await enforcer.maybeAutoCompact({ sessionName: seat, runtime: "claude-code", usedPercentage: 95 })).toMatchObject({ triggered: true }); // /compact
  expect(send.mock.calls.at(-1)![1]).toMatch(/^\/compact/);
  await enforcer.maybeAutoCompact({ sessionName: seat, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/t.jsonl" }); // turn_boundary
  await enforcer.maybeAutoCompact({ sessionName: seat, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/t.jsonl" }); // restore_prompt
  expect(send).toHaveBeenCalledTimes(4);
  return send.mock.calls[send.mock.calls.length - 1]![1] as string;
}

describe("OPR.0.4.1.09 — seat-scoped post-compaction extra (never inject wrong-seat state)", () => {
  it("REFUSES a global extra that declares a DIFFERENT seat (the 2026-06-20 defect)", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, "---\nseat: advisor-lead@kernel\n---\nAdvisor restore map: read X, Y, Z.");
    const prompt = await restorePromptFor(globalPath, "dev2-driver@openrig-delivery");
    // The wrong-seat file path is NOT injected ...
    expect(prompt).not.toContain(globalPath);
    expect(prompt).not.toContain("Additional post-compaction instruction file");
    // ... and the seat is told it was ignored.
    expect(prompt).toContain("declaring a DIFFERENT seat");
    expect(prompt).toContain("IGNORED");
  });

  it("INJECTS a per-seat extra (compaction/post-compact-extra/<seat>.md) over the global", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, "---\nseat: someone-else@rig\n---\nnot mine");
    const seat = "dev2-driver@openrig-delivery";
    const perSeatPath = path.join(home, "compaction", "post-compact-extra", `${seat}.md`);
    writeFile(perSeatPath, "my own restore extra");
    const prompt = await restorePromptFor(globalPath, seat);
    expect(prompt).toContain(perSeatPath);
    expect(prompt).not.toContain(globalPath); // the wrong-seat global is not used
  });

  it("ALLOWS a generic global extra that declares NO seat (valid for any seat)", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, "Generic operator note for all seats: prefer rig queue list --as you.");
    const prompt = await restorePromptFor(globalPath, "dev2-driver@openrig-delivery");
    expect(prompt).toContain(globalPath);
    expect(prompt).toContain("Additional post-compaction instruction file");
  });

  it("ALLOWS a global extra that declares THIS seat", async () => {
    const seat = "dev2-driver@openrig-delivery";
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, `---\ntarget_seat: ${seat}\n---\nmine`);
    const prompt = await restorePromptFor(globalPath, seat);
    expect(prompt).toContain(globalPath);
  });
});

// rev1-r2 (42654c58 blocker): a seat is authoritative ONLY inside a WELL-FORMED leading
// frontmatter fence (opened AND closed `---`). The body is never scanned, so a GENERIC
// operator extra whose `---` fence is broken, or which mentions a "seat:" in prose, must
// still INJECT — not be misclassified as a foreign-seat declaration and silently
// suppressed in the recovery path. Well-formed foreign-seat refusal is preserved.
describe("OPR.0.4.1.09 — rev1-r2 regression: only well-formed frontmatter declares a seat", () => {
  const SEAT = "dev2-driver@openrig-delivery";

  it("(1) INJECTS a MALFORMED-frontmatter extra (opened `---`, no close) with a foreign-looking seat: line", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    // Opened frontmatter, NO closing `---` => not well-formed => generic => inject.
    writeFile(globalPath, "---\nseat: advisor-lead@kernel\n# missing closing delimiter\nGeneric restore instructions for any seat.");
    const prompt = await restorePromptFor(globalPath, SEAT);
    expect(prompt).toContain(globalPath);
    expect(prompt).toContain("Additional post-compaction instruction file");
    expect(prompt).not.toContain("IGNORED");
    expect(prompt).not.toContain("declaring a DIFFERENT seat");
  });

  it("(2) INJECTS a generic extra with a prose 'seat:' line and NO frontmatter (body is never scanned)", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, "Operator note for all seats: ask the seat: advisor-lead@kernel for the dashboard link.\nGeneric guidance.");
    const prompt = await restorePromptFor(globalPath, SEAT);
    expect(prompt).toContain(globalPath);
    expect(prompt).toContain("Additional post-compaction instruction file");
    expect(prompt).not.toContain("IGNORED");
    expect(prompt).not.toContain("declaring a DIFFERENT seat");
  });

  it("(3) REFUSES a WELL-FORMED frontmatter declaring a DIFFERENT seat (preserved anti-contamination)", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, "---\nseat: advisor-lead@kernel\n---\nNot this seat's state.");
    const prompt = await restorePromptFor(globalPath, SEAT);
    expect(prompt).not.toContain(globalPath);
    expect(prompt).not.toContain("Additional post-compaction instruction file");
    expect(prompt).toContain("declaring a DIFFERENT seat");
    expect(prompt).toContain("IGNORED");
  });

  it("(4) INJECTS a WELL-FORMED frontmatter declaring THIS seat", async () => {
    const globalPath = path.join(home, "compaction", "post-compact-extra.md");
    writeFile(globalPath, `---\ntarget_seat: ${SEAT}\n---\nmine`);
    const prompt = await restorePromptFor(globalPath, SEAT);
    expect(prompt).toContain(globalPath);
    expect(prompt).toContain("Additional post-compaction instruction file");
    expect(prompt).not.toContain("IGNORED");
  });
});
