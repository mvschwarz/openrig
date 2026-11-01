import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { parse as parseToml } from "smol-toml";
import { shellWords } from "../src/domain/seat-restart-in-place.js";
import { codexEnvelopeArgs, parseCodexPermissionEnvelope, observeCodexRebuildPermissions } from "../src/domain/codex-rebuild-permissions.js";
import { provenCodexResume } from "./helpers/codex-resume-proof.js";

const payload = { cwd: "/project", approval_policy: "on-request", sandbox_policy: { type: "workspace-write",
  network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: true, writable_roots: ["/kept dir", "/kept'quote"] } };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("emits all observed workspace fields, with native TOML values and exact quoted roots", () => {
  const envelope = parseCodexPermissionEnvelope(payload)!;
  const args = shellWords(codexEnvelopeArgs(envelope));
  expect(args.slice(0, 4)).toEqual(["-s", "workspace-write", "-a", "on-request"]);
  // Each override is a dotted path; reconstruct their native table values without reading any user config.
  const fields: Record<string, unknown> = {};
  for (let at = 4; at < args.length; at += 2) Object.assign(fields, parseToml(args[at + 1]!).sandbox_workspace_write);
  expect(fields).toEqual({ writable_roots: payload.sandbox_policy.writable_roots, network_access: false,
    exclude_tmpdir_env_var: false, exclude_slash_tmp: true });
  const absent = parseCodexPermissionEnvelope({ ...payload, sandbox_policy: { ...payload.sandbox_policy, writable_roots: undefined } })!;
  expect(codexEnvelopeArgs(absent)).toContain("writable_roots=[]");
});

it.each(["read-only", "danger-full-access"] as const)("emits a supported %s policy with its approval choice", type => {
  const envelope = parseCodexPermissionEnvelope({ approval_policy: "never", sandbox_policy: { type } })!;
  expect(shellWords(codexEnvelopeArgs(envelope))).toEqual(["-s", type, "-a", "never"]);
});

it.each([
  { ...payload, approval_policy: { granular: {} } },
  { ...payload, sandbox_policy: { ...payload.sandbox_policy, network_access: undefined } },
  { ...payload, sandbox_policy: { ...payload.sandbox_policy, extra_policy: true } },
  { ...payload, sandbox_policy: { type: "external-sandbox", network_access: "enabled" } },
  { ...payload, sandbox_policy: { type: "read-only", network_access: true } },
])("does not turn a partial or unsupported policy into preservation: %j", input => {
  expect(parseCodexPermissionEnvelope(input)).toBeNull();
});

describe("the live predecessor record", () => {
  function fixture(options: { wrongThread?: boolean; stale?: boolean; incompleteLatest?: boolean; turnover?: boolean; argv?: string[] | null } = {}) {
    const root = mkdtempSync(join(tmpdir(), "codex-rebuild-")); roots.push(root);
    const path = join(root, "record.jsonl");
    writeFileSync(path, [
      { type: "session_meta", payload: { id: options.wrongThread ? "another" : "fixture-thread", base_instructions: "x".repeat(40_000) } },
      { type: "turn_context", timestamp: options.stale ? "2026-10-20T04:59:59Z" : "2026-10-20T05:01:00Z", payload },
      ...(options.incompleteLatest ? [{ type: "turn_context", timestamp: "2026-10-20T05:02:00Z", payload: { cwd: "/project", approval_policy: "never" } }] : []),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const native = provenCodexResume("fixture-thread");
    let reads = 0;
    const listProcesses = vi.fn(() => {
      const rows = native.listProcesses().map(row => row.executableName === "codex" && options.argv !== undefined
        ? { ...row, command: options.argv?.join(" ") ?? row.command, argv: options.argv } : row);
      if (options.turnover && reads++ > 0) return rows.map(row => ({ ...row, startedAt: "Tue Oct 20 05:02:01 2026" }));
      return rows;
    });
    return { nodeId: "seat", sessionName: "member@team", cwd: "/project", path,
      tmux: { getPanePid: native.getPanePid }, listProcesses,
      readThreadId: vi.fn(async () => "fixture-thread"), rollout: vi.fn(() => path),
      sessions: { currentOccupantTenure: () => ({ generationUuid: "generation", bootAt: "2026-10-20T05:00:00Z" }),
        getBindingForNode: () => ({ tmuxSession: "member@team", tmuxPane: "%1" }),
        currentOccupantGenerationForSession: () => "generation" } as never };
  }
  it("joins the process, thread header, current working directory and post-launch context", async () => {
    const result = await observeCodexRebuildPermissions(fixture());
    expect(result).toMatchObject({ state: "observed", observedAt: "2026-10-20T05:01:00.000Z",
      envelope: { approvalPolicy: "on-request", sandboxPolicy: payload.sandbox_policy } });
  });
  it("reports a managed profile containing spaces from the selected process's exact argv", async () => {
    const argv = ["codex", "-p", "openrig desktop work", "resume", "fixture-thread"];
    expect(await observeCodexRebuildPermissions(fixture({ argv }))).toMatchObject({ state: "observed", profile: "openrig desktop work" });
  });
  it("retains the native-log join for a valid fresh Codex process", async () => {
    expect(await observeCodexRebuildPermissions(fixture({ argv: ["codex", "-p", "managed work"] })))
      .toMatchObject({ state: "observed", profile: "managed work" });
  });
  it.each([null, [], ["codex", "resume", "fixture-thread", "bad\0argument"], ["node", "resume", "fixture-thread"]])(
    "does not inspect native records for an opaque or malformed predecessor argv: %j", async argv => {
      const input = fixture({ argv });
      expect(await observeCodexRebuildPermissions(input)).toMatchObject({ state: "unverified" });
      expect(input.readThreadId).not.toHaveBeenCalled();
      expect(input.rollout).not.toHaveBeenCalled();
    });
  it("refuses a thread named only inside a spaced option value", async () => {
    const argv = ["codex", "resume", "--add-dir", "/tmp/fixture-thread", "another-thread"];
    expect(await observeCodexRebuildPermissions(fixture({ argv }))).toMatchObject({ state: "unverified" });
  });
  it.each(["wrongThread", "stale", "incompleteLatest", "turnover"] as const)(
    "discloses unverified observation on %s, rather than using an older/different policy", async reason => {
      expect(await observeCodexRebuildPermissions(fixture({ [reason]: true }))).toMatchObject({ state: "unverified" });
    });
});
