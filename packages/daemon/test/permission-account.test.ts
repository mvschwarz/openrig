import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { planPermissionAccount } from "../src/domain/permission-account.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { KERNEL_CLAUDE_ALLOW, TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK } from "../src/adapters/kernel-authority.js";

const dbs: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function seat(runtime: string, rigName = "workshop") {
  const db = createFullTestDb(); dbs.push(db);
  const rigRepo = new RigRepository(db);
  const rig = rigRepo.createRig(rigName);
  const node = rigRepo.addNode(rig.id, "dev.builder", { runtime, cwd: "/inert/project" });
  return { db, rigRepo, rig, node };
}
const env = { OPENRIG_YOLO: "0" } as NodeJS.ProcessEnv;

describe("the planned permission account", () => {
  it("names OpenRig's team default and its lists for a Claude seat with no policy or seat choice, not 'OpenRig default'", () => {
    const { db, node } = seat("claude-code");
    const account = planPermissionAccount(db, node.id, "dev-builder@workshop", "claude-code", env);
    expect(account).toMatchObject({ basis: "planned", source: "team_default", nativeArgument: "--permission-mode acceptEdits", overrides: [] });
    expect(account.openRigAdds.claudeAllow).toEqual(TEAM_CLAUDE_ALLOW);
    expect(account.openRigAdds.claudeAsk).toEqual(TEAM_CLAUDE_ASK);
    expect(account.summary).toContain("OpenRig's team default");
    expect(account.summary).toContain(`OpenRig adds ${TEAM_CLAUDE_ALLOW.length} allowances and asks before ${TEAM_CLAUDE_ASK.length} lifecycle commands`);
    expect(account.unknown.join(" ")).toContain("aren't read here");
    expect(account.controls[0]).toBe('rig seat set-permissions dev-builder@workshop --mode <mode> --reason "<why>"');
  });

  it("names the kernel default and the kernel list for a kernel Claude seat", () => {
    const { db, node } = seat("claude-code", "kernel");
    const account = planPermissionAccount(db, node.id, "kernel-seat", "claude-code", env);
    expect(account).toMatchObject({ source: "kernel_default", nativeArgument: "--permission-mode acceptEdits" });
    expect(account.openRigAdds).toMatchObject({ claudeAllow: KERNEL_CLAUDE_ALLOW, claudeAsk: [] });
  });

  it("shows an explicit seat choice, who made it and why, and the recorded policy it's used instead of", () => {
    const { db, node } = seat("claude-code");
    db.prepare("UPDATE nodes SET permission_policy = ? WHERE id = ?").run("builtin:yolo", node.id);
    new NativePermissionStore(db).write(node.id, { runtime: "claude-code", mode: "plan" }, "person@host", "careful review");
    const account = planPermissionAccount(db, node.id, "dev-builder@workshop", "claude-code", env);
    expect(account).toMatchObject({ source: "explicit", nativeArgument: "--permission-mode plan", overrides: ["member policy builtin:yolo"],
      explicit: { mode: "plan", actor: "person@host", reason: "careful review" } });
    expect(account.openRigAdds.claudeAllow).toEqual([]);
    expect(account.summary).toContain("this seat's own choice (person@host: careful review)");
  });

  it("follows a member's full-bypass policy", () => {
    const { db, node } = seat("claude-code");
    db.prepare("UPDATE nodes SET permission_policy = ? WHERE id = ?").run("builtin:yolo", node.id);
    const account = planPermissionAccount(db, node.id, "dev-builder@workshop", "claude-code", env);
    expect(account).toMatchObject({ source: "member_policy", nativeArgument: "--dangerously-skip-permissions" });
  });

  it("names Codex's team-default roots and leaves its network access unknown", () => {
    const { db, node } = seat("codex");
    const account = planPermissionAccount(db, node.id, "dev-builder@workshop", "codex", env);
    expect(account).toMatchObject({ source: "team_default", nativeArgument: "-s workspace-write" });
    expect(account.openRigAdds.notes.join(" ")).toContain("the shared workspace and the pod's state folder");
    expect(account.unknown.join(" ")).toContain("Codex network access");
  });

  it("names a Codex seat's own profile when no policy or choice is recorded", () => {
    const { db, node } = seat("codex");
    db.prepare("UPDATE nodes SET codex_config_profile = ? WHERE id = ?").run("careful", node.id);
    const account = planPermissionAccount(db, node.id, "dev-builder@workshop", "codex", env);
    expect(account).toMatchObject({ source: "floor", nativeArgument: "-p careful" });
    expect(account.summary).toContain("the named Codex profile careful governs its sandbox and approvals");
  });

  it("says the daemon's OPENRIG_YOLO decides when no policy or choice is recorded", () => {
    const { db, node } = seat("claude-code");
    const account = planPermissionAccount(db, node.id, "dev-builder@workshop", "claude-code", { OPENRIG_YOLO: "1" } as NodeJS.ProcessEnv);
    expect(account).toMatchObject({ source: "environment", nativeArgument: "--dangerously-skip-permissions" });
  });

  it("sets no native argument for Pi", () => {
    const { db, node } = seat("pi");
    expect(planPermissionAccount(db, node.id, "dev-builder@workshop", "pi", env)).toMatchObject({ source: null, nativeArgument: null, controls: [] });
  });

  it("is on rig seat status, beside the existing permission fields", () => {
    const { rigRepo } = seat("claude-code");
    const result = new SeatStatusService({ rigRepo }).getStatus("dev.builder");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.permissions).toMatchObject({ selectionState: "inherit", nativeEffect: "unverified", account: { basis: "planned", runtime: "claude-code" } });
  });
});
