// Slice 20, partial crawl: one seat's PLANNED permission account, from the same decisions its next fresh managed launch makes
// (NativePermissionStore, the posture flags, the team and kernel lists). Planned, not observed: nothing here runs a
// harness, probes Codex or reads native settings files, so what only a launch or the harness knows is listed as unknown.
import type Database from "better-sqlite3";
import { NativePermissionStore, type StoredNativePermissionSelection } from "./native-permission-store.js";
import { claudePostureFlag, codexPostureArg, planModelAliasNotice, yoloEnabled } from "../adapters/yolo-mode.js";
import { codexEnvelopeArgs } from "./codex-rebuild-permissions.js";
import { codexMemberEnvelope } from "./codex-member-permissions.js";
import { KERNEL_CLAUDE_ALLOW, TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK } from "../adapters/kernel-authority.js";
import { RigRepository } from "./rig-repository.js";
import type { NodeBinding } from "./runtime-adapter.js";

export type PermissionAccountSource = "explicit" | "member_policy" | "rig_policy" | "kernel_default" | "team_default" | "floor";

export interface PermissionAccount {
  basis: "planned";
  runtime: string | null;
  /** Null for a runtime OpenRig sets no native permission argument for (Pi, a terminal). */
  source: PermissionAccountSource | null;
  /** The native permission argument a fresh managed launch emits, verbatim (restore and rebuild: see `unknown`). */
  nativeArgument: string | null;
  /** The account in plain words. */
  summary: string;
  explicit?: Pick<StoredNativePermissionSelection, "mode" | "actor" | "reason" | "updatedAt">;
  /** Recorded policies this seat's explicit choice is used instead of. */
  overrides: string[];
  /** What OpenRig adds to the launch beyond the native argument. Claude's lists are passed per launch, never saved. */
  openRigAdds: { claudeAllow: string[]; claudeAsk: string[]; claudeDeny?: string[]; notes: string[] };
  /** What this read can't know. */
  unknown: string[];
  /** The existing controls that change it, for future launches only. */
  controls: string[];
  /** What the harness does with this pairing that the launch arguments don't show (Claude plan mode on the bare `haiku` alias). */
  advisories: string[];
}

const NOT_READ = "Native settings OpenRig doesn't manage still apply and aren't read here: your user, project and managed Claude settings, or your Codex configuration, profiles and requirements.";
const UNVERIFIED = "Whether the harness applies this is unverified until a launch.";

function policyRefs(db: Database.Database, nodeId: string): { member: string | null; rig: string | null; profile: string | null; nonInterruptive: boolean } {
  let refs = { member: null as string | null, rig: null as string | null, profile: null as string | null };
  try {
    const row = db.prepare(`SELECT n.permission_policy AS member, r.permission_policy AS rig, n.codex_config_profile AS profile
      FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?`).get(nodeId) as { member: string | null; rig: string | null; profile: string | null } | undefined;
    refs = { member: row?.member ?? null, rig: row?.rig ?? null, profile: row?.profile?.trim() || null };
  } catch { /* an older database without these columns has nothing recorded */ }
  let nonInterruptive = false;
  try {
    nonInterruptive = (db.prepare("SELECT r.non_interruptive AS v FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?").get(nodeId) as { v: number | null } | undefined)?.v === 1;
  } catch { /* the column predates this database */ }
  return { ...refs, nonInterruptive };
}

export function planPermissionAccount(db: Database.Database, nodeId: string, seat: string, runtime: string | null,
  env: NodeJS.ProcessEnv = process.env): PermissionAccount {
  const controls = [
    `rig seat set-permissions ${seat} --mode <mode> --reason "<why>"`,
    `rig seat set-permissions ${seat} --mode inherit --reason "<why>" (clears the seat's choice)`,
    `rig policy apply <policy> --seat ${seat} --reason "<why>"`,
  ];
  const none = { claudeAllow: [], claudeAsk: [], notes: [] };
  if (runtime !== "claude-code" && runtime !== "codex") {
    return { basis: "planned", runtime, source: null, nativeArgument: null, overrides: [], openRigAdds: none, unknown: [], controls: [], advisories: [],
      summary: runtime === "pi" ? "Pi has no native permission policy; its resource trust is set at launch."
        : runtime === "terminal" ? "A terminal shell; no agent permission argument." : "OpenRig sets no native permission argument for this runtime." };
  }
  const store = new NativePermissionStore(db);
  const explicit = store.read(nodeId);
  const override = store.launchOverride(nodeId, runtime);
  const resolved = store.resolve(nodeId, runtime);
  const refs = policyRefs(db, nodeId);

  const source: PermissionAccountSource = override.kernelAuthority ? "kernel_default" : explicit || override.codexPermissions ? "explicit"
    : resolved.source === "member_spec" ? "member_policy" : resolved.source === "rig_spec" ? "rig_policy"
    : override.teamPermissionDefault ? "team_default" : "floor";

  // The binding a fresh managed launch of this seat starts from, built as the launch builds it: the persisted policy
  // posture, else the explicit floor (an ambient OPENRIG_YOLO never widens a seat with no policy), then the seat's own
  // choice and the team or kernel default through NativePermissionStore.apply.
  const repo = new RigRepository(db);
  const rigId = (db.prepare("SELECT rig_id FROM nodes WHERE id = ?").get(nodeId) as { rig_id: string } | undefined)?.rig_id;
  const bindingPosture = repo.getNodePolicyProvenance(nodeId)?.launchPosture
    ?? (rigId ? repo.getRigPolicyProvenance(rigId)?.launchPosture : undefined) ?? "floor";
  const planned = store.apply({ nodeId, launchPosture: bindingPosture } as NodeBinding, runtime);
  const posture = planned.launchPosture;
  const mode = planned.permissionMode;
  let model: string | null = null;
  try {
    model = (db.prepare("SELECT model FROM nodes WHERE id = ?").get(nodeId) as { model: string | null } | undefined)?.model ?? null;
  } catch { /* the column predates this database */ }
  const planNote = planModelAliasNotice(runtime, { model, permissionMode: mode }, seat);

  const profile = runtime === "codex" ? refs.profile : null;
  // A Codex seat's envelope replaces the posture decision with its own flags, as the launch does.
  const envelope = runtime === "codex" ? planned.codexPermissions : undefined;
  const nativeArgument = runtime === "claude-code" ? claudePostureFlag(env, posture, mode)
    : envelope ? `${profile ? ` -p ${profile}` : ""}${codexEnvelopeArgs(codexMemberEnvelope(envelope))}`.trim()
    : codexPostureArg(profile ? ` -p ${profile}` : "", env, posture).trim();
  const openRigAdds: PermissionAccount["openRigAdds"] = { claudeAllow: [], claudeAsk: [], notes: [] };
  const unknown = [NOT_READ, UNVERIFIED,
    runtime === "codex" && envelope
      ? "This is the saved plan for a fresh launch. Resumes, restores and handovers emit the same envelope."
      : runtime === "codex"
      ? "This is the saved plan for a fresh launch. A restore re-reads a custom policy file, and a rebuild handover can carry the previous occupant's observed Codex sandbox and approvals instead, without the extra roots or network setting."
      : "This is the saved plan for a fresh launch. A restore re-reads a custom policy file, which can differ from what's saved."];
  if (runtime === "claude-code" && planned.kernelAuthority) openRigAdds.claudeAllow = [...KERNEL_CLAUDE_ALLOW];
  else if (runtime === "claude-code" && planned.teamPermissionDefault && !mode && (!posture || posture === "floor")) {
    openRigAdds.claudeAllow = [...TEAM_CLAUDE_ALLOW];
    openRigAdds.claudeAsk = [...TEAM_CLAUDE_ASK];
    openRigAdds.notes.push("A hook asks before the listed lifecycle commands.");
  }
  if (planned.claudePermissions !== undefined) {
    openRigAdds.claudeAllow.push(...planned.claudePermissions.allow);
    openRigAdds.claudeDeny = [...planned.claudePermissions.deny];
    openRigAdds.notes.push("This seat's allow/deny rules are composed into the same launch settings; no shared project settings are changed.",
      "Inherited grants remain. Managed policy, native modes and installed mods can change the effect; this read does not verify enforcement.",
      "Rules are not OS or credential isolation. Older readers may ignore the record; check rollback compatibility and preserve restrictions before downgrading.");
    if (posture === "full_bypass" || mode === "bypassPermissions") openRigAdds.notes.push("In bypassPermissions, allow rules do not constrain access; native deny behavior remains subject to the harness's documented exceptions.");
    controls.push(`rig seat set-permissions ${seat} --rules <file.json> --reason "<why>"`);
  }
  if (envelope) {
    openRigAdds.notes.push(envelope.sandbox === "workspace-write"
      ? "Extra writable roots for OpenRig's queue state, and git metadata folders on a fresh launch, beside the envelope's own roots."
      : "No extra writable roots: the envelope is read-only.",
    `Network access ${envelope.sandbox === "workspace-write" && envelope.network_access ? "on" : "off"}, as the envelope states; OpenRig adds no network setting of its own.`,
    "Codex's own implicit roots (the working directory and temporary folders) still apply; this isn't a complete filesystem or credential-isolation guarantee.",
    "Older readers may ignore the envelope; check rollback compatibility and preserve restrictions before downgrading.");
  } else if (runtime === "codex") {
    openRigAdds.notes.push(planned.teamPermissionDefault && !profile && nativeArgument === "-s workspace-write"
      ? "Extra writable roots: the shared workspace and the pod's state folder; git metadata folders on a fresh launch."
      : "Extra writable roots for OpenRig's queue state, unless a read-only profile rules them out; git metadata folders on a fresh launch.");
    if (nativeArgument === "-s workspace-write") unknown.push("Codex network access: added at launch only if Codex's own configuration allows it; not read here.");
  }
  // The kernel's Codex seats always get them (operationalLaunchArgs); other seats when the rig records non-interruptive.
  if ((runtime === "codex" && planned.kernelAuthority) || (refs.nonInterruptive && posture === "full_bypass")) {
    openRigAdds.notes.push("Non-interruptive: supported harness warnings are accepted or hidden with launch flags.");
  }

  const overrides = explicit || envelope ? [refs.member ? `member policy ${refs.member}` : null, refs.rig ? `rig policy ${refs.rig}` : null].filter((v): v is string => !!v) : [];
  if (runtime === "codex") {
    controls.push(`rig seat set-permissions ${seat} --codex-permissions <file.json> --reason "<why>" (replaces a recorded mode)`,
      `rig seat set-permissions ${seat} --codex-profile <name|inherit> --reason "<why>"`);
    if (profile) {
      // The setter's last check of this profile, as recorded: observation, not a launch pin.
      let recorded: { to?: string | null; observation?: { file?: string; vantage?: string; home?: string | null; observedAt?: string; changedSinceRecorded?: boolean } } | undefined;
      try {
        const last = db.prepare("SELECT payload FROM events WHERE node_id = ? AND type = 'node.codex_profile_changed' ORDER BY seq DESC LIMIT 1").get(nodeId) as { payload: string } | undefined;
        recorded = last ? JSON.parse(last.payload) as typeof recorded : undefined;
      } catch { /* no audit history in this database */ }
      const seen = recorded?.to === profile ? recorded.observation : undefined;
      if (seen) {
        openRigAdds.notes.push(`Profile file ${profile}: ${seen.file ?? "unverified"}${seen.changedSinceRecorded ? " and changed since the record before it" : ""} when the setter checked it at ${seen.observedAt ?? "an unknown time"}${seen.vantage === "configured_codex_home" ? ` in ${seen.home}` : "; the pane's own config home wasn't established"}. It can have changed since; each launch runs the native profile check.`);
      } else unknown.push(`Profile file ${profile}: not checked by the setter; each launch runs the native profile check, and Codex loads a missing file as an empty layer.`);
    }
  }
  // What the envelope replaces for this seat: a policy's posture and an ambient YOLO setting.
  const replacedPosture = envelope ? [bindingPosture !== "floor" ? `the policy's ${bindingPosture} posture` : null,
    yoloEnabled(env, undefined) ? "the ambient OPENRIG_YOLO setting" : null].filter((v): v is string => !!v) : [];
  // The resolver's own fallback (Codex has no auto mode), and a named Codex profile that supplies the argument under a
  // policy or seat choice; the floor's own wording already names its profile.
  const notes = [
    (source === "member_policy" || source === "rig_policy") && resolved.fallbackReason ? resolved.fallbackReason : null,
    profile && source !== "floor" && nativeArgument === `-p ${profile}` ? `the named Codex profile ${profile} governs its sandbox and approvals` : null,
    replacedPosture.length ? `the envelope replaces ${replacedPosture.join(" and ")} for this seat` : null,
    envelope && profile ? `the named Codex profile ${profile} supplies only the settings the envelope doesn't state` : null,
  ].filter((n): n is string => !!n).map((n) => `; ${n}`).join("");
  const where: Record<PermissionAccountSource, string> = {
    explicit: envelope ? "this seat's own permission envelope" : `this seat's own choice (${explicit?.actor ?? "unknown"}: ${explicit?.reason ?? ""})`,
    member_policy: `the member's policy ${refs.member ?? ""}`.trim(),
    rig_policy: `the rig's policy ${refs.rig ?? ""}`.trim(),
    kernel_default: "the kernel's operational default",
    team_default: "OpenRig's team default (no policy or seat choice is recorded)",
    floor: profile ? `no policy or seat choice; the named Codex profile ${profile} governs its sandbox and approvals` : "no policy or seat choice; OpenRig's floor",
  };
  const adds = openRigAdds.claudeAllow.length
    ? `; OpenRig adds ${openRigAdds.claudeAllow.length} allowances${openRigAdds.claudeAsk.length ? ` and asks before ${openRigAdds.claudeAsk.length} lifecycle commands` : ""}`
    : "";
  return {
    basis: "planned", runtime, source, nativeArgument, overrides, openRigAdds, unknown, controls, advisories: planNote ? [planNote] : [],
    ...(explicit ? { explicit: { mode: explicit.mode, actor: explicit.actor, reason: explicit.reason, updatedAt: explicit.updatedAt } } : {}),
    summary: `Next launch: ${nativeArgument}, from ${where[source]}${notes}${adds}.`,
  };
}
