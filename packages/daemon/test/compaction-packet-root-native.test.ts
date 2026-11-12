import { afterEach, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { withManagedRestoreReads } from "../src/domain/managed-restore-read-access.js";
import { buildPostCompactRestorePrompt } from "../src/domain/claude-compaction-enforcer.js";

afterEach(() => vi.unstubAllEnvs());
const id = "11111111-1111-4111-8111-111111111111";
it.runIf(process.platform === "win32").each([false, true])("aligns restore read grants and fallback prompts with the native packet directory (override=%s)", (override) => {
  const selected = override ? join(tmpdir(), "synthetic 用户 packet-root") : "";
  vi.stubEnv("OPENRIG_COMPACTION_OUT_ROOT", selected);
  const root = resolve(selected || join(tmpdir(), "claude-compaction-restore"));
  const context = { openrigHome: join(tmpdir(), "synthetic-instance"), session: "owner@rig", cwd: join(tmpdir(), "synthetic-project"), nativeSessionId: id };
  const args = withManagedRestoreReads([], context);
  const allow: string[] = JSON.parse(args[1]!).permissions.allow;
  expect(allow).toContain(`Read(/${root.replaceAll(sep, "/")}/${id}-*/restore-instructions.md)`);
  const prompt = buildPostCompactRestorePrompt({ sessionName: context.session, openrigHome: context.openrigHome, sessionId: id });
  expect(prompt).toContain(`under ${root}${sep} for session id ${id}`);
  expect(buildPostCompactRestorePrompt({ sessionName: context.session, openrigHome: context.openrigHome }))
    .toContain(`under ${root}${sep} for this Claude session`);
  const noId = withManagedRestoreReads([], { ...context, nativeSessionId: "unknown" });
  expect(JSON.parse(noId[1]!).permissions.allow.some((rule: string) => rule.includes("restore-instructions.md"))).toBe(false);
});
