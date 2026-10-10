import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";

const stamp = "2026-10-10T12:00:00.000Z";
const info = { last_token_usage: { input_tokens: 400, output_tokens: 100, total_tokens: 500 }, model_context_window: 1000 };
function read(events: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "codex-rate-only-"));
  const home = join(root, ".codex");
  mkdirSync(home);
  const rollout = join(home, "rollout.jsonl");
  const db = new BetterSqlite3(":memory:");
  const native = new BetterSqlite3(join(home, "state_5.sqlite"));
  try {
    native.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    native.prepare("INSERT INTO threads VALUES (?, ?)").run("thread", rollout);
    writeFileSync(rollout, events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const store = new ContextUsageStore(db, { stateDir: root, codexHomeDir: root });
    return store.readCodexAndNormalize({ threadId: "thread", sessionName: "seat@rig" });
  } finally { native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
}
const event = (data: unknown, timestamp = stamp) => ({ timestamp, type: "event_msg", payload: { type: "token_count", info: data } });
describe("Codex context samples amid independent quota updates", () => {
  it.each([null, undefined])("retains latest measured sample when quota record info is %s", absent => {
    const quota = { timestamp: "2026-10-10T12:05:00.000Z", type: "event_msg", payload: { type: "token_count", info: absent, rate_limits: { primary: { used_percent: 10 } } } };
    expect(read([event(info), quota])).toMatchObject({ availability: "known", usedPercentage: 50, sampledAt: stamp, totalInputTokens: 400 });
  });
  it("keeps a missing-info event without quota data unknown", () => {
    expect(read([event(info), event(null)])).toMatchObject({ availability: "unknown", reason: "parse_error" });
  });
  it("uses the newest actual sample", () => {
    expect(read([event(info), event({ ...info, last_token_usage: { total_tokens: 750 } }, "2026-10-10T12:04:00.000Z")])).toMatchObject({ availability: "known", usedPercentage: 75, sampledAt: "2026-10-10T12:04:00.000Z" });
  });
  it("keeps malformed present usage unknown rather than hiding it behind older data", () => {
    expect(read([event(info), event({})])).toMatchObject({ availability: "unknown", reason: "parse_error" });
  });
});
