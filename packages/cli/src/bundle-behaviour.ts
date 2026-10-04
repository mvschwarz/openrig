import type { BundleBehaviour } from "@openrig/daemon/bundle-behaviour";

/** Archive text is data, including terminal escape sequences. */
const plain = (value: unknown): string => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function formatBundleBehaviour(view: BundleBehaviour): string[] {
  const lines = ["What this bundle declares before installation:"];
  const identity = view.identity;
  lines.push(`Source (bundle-stated): ${identity.source ? plain(JSON.stringify(identity.source)) : "not recorded"}`);
  lines.push(`Assembler (bundle-stated): ${identity.assembler ? plain(JSON.stringify(identity.assembler)) : "not recorded"}; view generator: ${plain(identity.generator.openrigVersion)}`);
  if (identity.compatibility && Object.keys(identity.compatibility).length) lines.push(`Declared compatibility: ${plain(JSON.stringify(identity.compatibility))}`);
  if (identity.statedProvenance && Object.keys(identity.statedProvenance).length) lines.push(`Bundle-stated provenance (not verified): ${plain(JSON.stringify(identity.statedProvenance))}`);
  lines.push(`Integrity checks: archive digest ${identity.integrity.digestValid ? "matches" : "not confirmed"}; packaged files ${identity.integrity.filesVerified ? "match" : "not confirmed"}.`);
  if (view.state === "not_generated") {
    lines.push(`View not generated: ${plain(view.reason)}`, `Inspect locally: ${plain(view.localInspectCommand)}`);
  } else {
    lines.push(`Configuration: ${plain(view.identity.configurationId ?? "not recorded in the archive")}`);
    for (const member of view.team) lines.push(`  ${plain(member.seat)}: ${plain(member.runtime)}, profile ${plain(member.profile)}, declared working folder ${plain(member.cwd)}${member.model ? `, configured model ${plain(member.model)}` : ""}`);
    lines.push("Permission posture:");
    if (view.posture.length > 0 && view.posture.length === view.team.length && view.posture.every(item => item.permissionPrompts === "off")) {
      lines.push("Permission prompts: off for all seats (archive declaration).");
    }
    for (const item of view.posture) lines.push(`  ${plain(item.seat)}: ${plain(item.selection)} (${item.basis}); effective native settings unknown.`);
    lines.push("Access: agents can run shell commands using your account, subject to runtime and host policy.");
    lines.push("Told files:", ...view.toldFiles.map(f => `  ${f.seat ? plain(f.seat) + ": " : ""}${plain(f.pathOrRef)} [${f.resolution}${f.delivery ? `; ${plain(f.delivery)}` : ""}]`));
    lines.push("Also declared to run:", ...view.alsoRuns.map(f => `  ${plain(f.kind)}: ${plain(f.pathOrRef)} [${f.resolution}${f.trigger ? `; ${plain(f.trigger)}` : ""}]`));
    lines.push("Writes and library additions (destinations, runtime support and conflicts resolved at launch):", ...view.writes.map(w => `  ${w.seat ? plain(w.seat) + ": " : ""}${plain(w.destinationBase)}/${plain(w.path)} — ${plain(w.operation)}, ${plain(w.phase)}`));
    lines.push(`Outside domains found in files (not predicted traffic): ${view.outsideAddresses.map(a => plain(a.domain)).join(", ") || "none found"}`);
    lines.push("Needs (not checked):", ...view.needs.map(n => `  ${plain(n.name)}${n.versionConstraint ? ` ${plain(n.versionConstraint)}` : ""}`));
    lines.push("Unknown before launch:", ...view.unknownBeforeLaunch.map(u => `  ${plain(u.subject)}: ${plain(u.reason)}`));
  }
  if (view.identity.packageDigest) lines.push(`Package digest: ${plain(view.identity.packageDigest.value)} (${plain(view.identity.packageDigest.coverage)}). Coverage: packaged content bytes; excludes bundle.yaml, .DS_Store, Thumbs.db, .gitkeep, file modes and host-resolved resources.`);
  lines.push("Integrity means the archive is self-consistent, not who made it.", "Provenance is stated by the bundle and not verified.");
  return lines;
}

interface InspectionResponse { status: number; data: Record<string, unknown> }

/** Diagnostic only: this helper must not change an install/up request, prompt or exit code. */
export async function showBundleBehaviourBeforeAction(
  inspect: () => Promise<InspectionResponse>,
  output: (line: string) => void = console.error,
): Promise<BundleBehaviour | undefined> {
  try {
    const response = await inspect();
    const view = response.data.behaviour as BundleBehaviour | undefined;
    if (response.status < 400 && view?.schema === "openrig.bundle-behaviour/v1") {
      for (const line of formatBundleBehaviour(view)) output(line);
      return view;
    }
    output(`Bundle view not generated: ${plain(response.data.error ?? "the daemon did not provide a behaviour view")}. Existing installation checks still apply.`);
  } catch (error) {
    output(`Bundle view not generated: ${plain(error instanceof Error ? error.message : error)}. Existing installation checks still apply.`);
  }
  return undefined;
}
