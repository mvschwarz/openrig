import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import nodePath from "node:path";
import { ConfigStore } from "../config-store.js";
import {
  reconcileSkillLoadout,
  resolveSkillLoadout,
  type SkillRuntime,
} from "@openrig/daemon/skill-loadout";
import { seatLaunchAdditionLines, type SeatLaunchAdditionsView } from "../seat-launch-additions-lines.js";

interface AuditFinding {
  class: string;
  file: string;
  reason: string;
  remediation: string;
}

interface AuditEntry {
  id: string;
  path: string;
  sourceKind: string;
  shadowed: boolean;
  stage: string | null;
  verified: { status: string; date?: string; source?: string; plugin?: string; version?: string };
  contentHash: string;
  state: string;
  owner: string | null;
  sourceRef: string | null;
  bundledFrom?: { plugin: string; version: string } | null;
  findings: AuditFinding[];
}

interface AuditResponse {
  ok: boolean;
  entries: AuditEntry[];
  totalFindings: number;
  mirrorDriftError?: string;
  mirrorDriftSkipped?: string;
  error?: string;
}

interface SeatInspection {
  seat: { sessionName: string; runtime: string };
  storage: string | null;
  skills: Array<{ id: string; trigger: string; path: string }>;
  catalogDigest: string | null;
  occupant: string | null;
  delivery: { outcome: string; at: string; deliveryId: string } | null;
  confirmed?: { outcome: string; at: string; deliveryId: string } | null;
  /** OPR.0.7.0.13 (router): absent from an older daemon. */
  router?: { id: string; path: string; written: boolean; kept?: "edited" | "linked" } | null;
  bootstrapLine?: { state: "unasked" | "unknown" } | { state: "yes" | "no"; by: "saved" | "environment" } | null;
  /** OPR.0.7.0.9: what the seat's launch passes of its own additions; absent from an older daemon. */
  launchAdditions?: SeatLaunchAdditionsView | null;
}

interface SeatApplyResponse {
  inspection: SeatInspection;
  disk: { ok: boolean; selection?: "reconciled" | "none" | "unreadable"; receipts: Array<{ status: string; id: string; target: string }>; removed: string[]; errors: string[] };
  delivery:
    | { state: "sent"; record: { outcome: string; deliveryId: string }; transportOutcome?: string; detail?: string }
    | { state: "already-delivered"; record: { outcome: string; deliveryId: string } }
    | { state: "earlier-attempt-unconfirmed"; record: { outcome: string; deliveryId: string } }
    | { state: "attempt-in-flight"; record: { outcome: string; deliveryId: string } }
    | { state: "not-sent"; reason: string };
}

export function skillCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("skill").description("Skill management and audit");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .command("loadout")
    .description("Inspect or reconcile the composed managed skill loadout for one Claude/Codex working directory, or (with --seat) one seat's own skills")
    .option("--runtime <runtime>", "Target runtime: claude-code or codex (folder mode; required there)")
    .option("--seat <session>", "Seat mode: a seat's own skills, kept outside the project. `self` is this seat (its OPENRIG_SESSION_NAME)")
    .option("--wait-for-idle <ms>", "Seat mode with --apply: wait up to this long for the seat to be idle before telling it")
    .option("--resend", "Seat mode with --apply: send this list again after an earlier attempt that failed or wasn't confirmed, once you've checked the seat")
    .option("--cwd <path>", "Target working directory (default: current directory)")
    .option("--project-root <path>", "Project root whose project.yaml supplies install.skills (default: cwd)")
    .option("--topology <ids>", "Comma-separated topology/profile skill identities")
    .option("--apply", "Apply the reconciled loadout; default is read-only inspection")
    .option("--json", "JSON output")
    .action(async (opts: {
      runtime?: string;
      seat?: string;
      waitForIdle?: string;
      resend?: boolean;
      cwd?: string;
      projectRoot?: string;
      topology?: string;
      apply?: boolean;
      json?: boolean;
    }) => {
      if (opts.seat !== undefined) {
        await seatLoadout(opts as SeatLoadoutOpts);
        return;
      }
      if (opts.runtime === undefined) {
        console.error("error: required option '--runtime <runtime>' not specified (or use --seat for a seat's own skills)");
        process.exitCode = 1;
        return;
      }
      if (opts.runtime !== "claude-code" && opts.runtime !== "codex") {
        console.error("invalid_runtime: --runtime must be claude-code or codex");
        process.exitCode = 1;
        return;
      }
      const runtime = opts.runtime as SkillRuntime;
      const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
      const projectRoot = nodePath.resolve(opts.projectRoot ?? cwd);
      const topologySkills = (opts.topology ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const catalogRoot = String(new ConfigStore().resolveWithSource("skills.root").value);
      const resolved = resolveSkillLoadout({ catalogRoot, topologySkills, projectRoot });
      if (!resolved.ok) {
        if (opts.json) console.log(JSON.stringify(resolved, null, 2));
        else for (const error of resolved.errors) console.error(`${error.code}: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      const skippedSkills = resolved.loadout.skipped ?? [];
      if (!opts.json) for (const skip of skippedSkills) console.error(`Warning: ${skip.message}`);
      if (skippedSkills.some((skip) => skip.selectedBy.length > 0)) process.exitCode = 1;
      const projection = reconcileSkillLoadout({ loadout: resolved.loadout, runtime, cwd, apply: opts.apply === true });
      if (opts.json) {
        console.log(JSON.stringify({ ...resolved, projection }, null, 2));
      } else {
        console.log(`catalog ${resolved.loadout.catalogRoot} @ ${resolved.loadout.catalogRevision ?? "unused"}`);
        for (const receipt of projection.receipts) {
          console.log(`${receipt.status.padEnd(11)} ${receipt.id} <- ${receipt.selectedBy.join("+")} -> ${receipt.target}`);
          console.log(`  ${receipt.revision} ${receipt.digest} ${receipt.detail}`);
        }
        for (const id of projection.removed) console.log(`removed     ${id} (deselected, owned, unchanged)`);
        if (projection.freshLaunchRequired) {
          console.log("restart     start a fresh seat process before expecting the changed ambient skill set");
        }
        if (resolved.loadout.entries.length === 0 && projection.removed.length === 0) console.log("empty       no managed skills selected");
        if (!opts.apply) console.log("read-only   re-run with --apply to reconcile");
        for (const error of projection.errors) console.error(`${error.code}: ${error.message}`);
      }
      if (!projection.ok) process.exitCode = 1;
    });

  // OPR.0.7.0.13 (B): the seat mode. It never changes folder mode, and it never guesses a seat: `self` is this shell's
  // OPENRIG_SESSION_NAME, and without one it says so instead of showing anyone else's skills.
  interface SeatLoadoutOpts { seat: string; runtime?: string; cwd?: string; projectRoot?: string; topology?: string; apply?: boolean; json?: boolean; waitForIdle?: string; resend?: boolean }
  async function seatLoadout(opts: SeatLoadoutOpts): Promise<void> {
    const mixed = (["runtime", "cwd", "projectRoot", "topology"] as const).filter((key) => opts[key] !== undefined);
    if (mixed.length > 0) {
      console.error(`--seat can't be combined with ${mixed.map((k) => `--${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`).join(", ")}: those choose a working folder`);
      process.exitCode = 1;
      return;
    }
    if (opts.resend && !opts.apply) {
      console.error("--resend needs --apply");
      process.exitCode = 1;
      return;
    }
    const session = opts.seat === "self" ? process.env["OPENRIG_SESSION_NAME"]?.trim() : opts.seat.trim();
    if (!session) {
      console.error("not an OpenRig seat: OPENRIG_SESSION_NAME isn't set in this shell, so there's no seat to show; no other seat's skills are used");
      process.exitCode = 1;
      return;
    }
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return;
    const client = deps.clientFactory(getDaemonUrl(status));
    const wait = opts.waitForIdle !== undefined ? Number(opts.waitForIdle) : undefined;
    const res = opts.apply
      ? await client.post<SeatApplyResponse>("/api/skills/seat/apply", { session, ...(wait && wait > 0 ? { waitForIdleMs: wait } : {}), ...(opts.resend ? { resend: true } : {}) })
      : await client.get<SeatInspection>(`/api/skills/seat?session=${encodeURIComponent(session)}`);
    const data = res.data as SeatApplyResponse & SeatInspection;
    const failure = (res.data as { error?: string }).error;
    if (opts.json) console.log(JSON.stringify(data, null, 2));
    if (res.status >= 400 && !("disk" in data)) {
      if (!opts.json) console.error(failure ?? `seat loadout failed (HTTP ${res.status})`);
      process.exitCode = 1;
      return;
    }
    const inspection = opts.apply ? data.inspection : data;
    if (!opts.json) printSeat(inspection);
    if (!opts.apply) {
      if (!opts.json) console.log("read-only   re-run with --apply to reconcile this seat's selection and tell it");
      return;
    }
    if (!opts.json) {
      for (const receipt of data.disk.receipts) console.log(`${receipt.status.padEnd(11)} ${receipt.id} -> ${receipt.target}`);
      for (const id of data.disk.removed) console.log(`removed     ${id} (deselected, owned, unchanged)`);
      for (const error of data.disk.errors) console.error(error);
      console.log(`on disk     ${data.disk.ok ? (data.disk.selection === "none" ? "no stored selection" : "reconciled") : data.disk.selection === "unreadable" ? "not reconciled: the stored selection couldn't be read" : "not reconciled"}`);
      console.log(describeDelivery(data.delivery, session));
    }
    if (!data.disk.ok || (data.delivery.state === "sent" && data.delivery.record.outcome === "failed")) process.exitCode = 1;
  }

  function printSeat(seat: SeatInspection): void {
    console.log(`seat        ${seat.seat.sessionName} (${seat.seat.runtime})`);
    console.log(`storage     ${seat.storage ?? "none: OpenRig keeps no skills for this seat"}`);
    for (const skill of seat.skills) {
      console.log(`skill       ${skill.id}: ${skill.trigger}`);
      console.log(`            ${skill.path}`);
    }
    if (seat.router) {
      const state = seat.router.written ? "" : seat.router.kept === "edited" ? " (kept as it is: it differs from what OpenRig wrote)"
        : seat.router.kept === "linked" ? " (not written: a link on the way into this seat's storage)" : " (not written yet)";
      console.log(`router      ${seat.router.id}: ${seat.router.path}${state}`);
    }
    if (seat.bootstrapLine) {
      const line = seat.bootstrapLine;
      const said = line.state === "unasked" ? "off: not asked yet" : line.state === "unknown" ? "unknown: the setting couldn't be read"
        : "by" in line && line.by === "environment" ? `${line.state === "yes" ? "on" : "off"}: set by the environment, not the person's saved answer`
          : line.state === "yes" ? "on: the person's saved yes" : "off: the person's saved no";
      console.log(`bootstrap   ${said} (skills.router_line.enabled)`);
    }
    for (const line of seatLaunchAdditionLines(seat.launchAdditions)) console.log(line);
    if (seat.delivery) console.log(`last sent   ${seat.delivery.outcome} at ${seat.delivery.at} (${seat.delivery.deliveryId}), to this occupant`);
    if (seat.confirmed && seat.confirmed.deliveryId !== seat.delivery?.deliveryId) console.log(`last confirmed delivered at ${seat.confirmed.at} (${seat.confirmed.deliveryId})`);
  }

  function describeDelivery(delivery: SeatApplyResponse["delivery"], session: string): string {
    switch (delivery.state) {
      case "sent": {
        const outcome = delivery.transportOutcome ?? delivery.record.outcome;
        const what = outcome === "delivered" ? "delivered: the text landed and the transport re-confirmed it"
          : outcome === "rendered-unconfirmed" ? "rendered-unconfirmed: the text and Enter landed, but the transport couldn't re-confirm it"
          : outcome === "retained" ? "retained: held by the typing guard, not yet sent"
          : `${outcome}${delivery.detail ? `: ${delivery.detail}` : ""}`;
        return `told seat   ${what}. This is what the transport saw, not the agent reading it. (${delivery.record.deliveryId})`;
      }
      case "already-delivered": return `told seat   already delivered to this occupant (${delivery.record.deliveryId}); nothing sent`;
      case "earlier-attempt-unconfirmed": return `told seat   an earlier attempt for this same list came back ${delivery.record.outcome} (${delivery.record.deliveryId}); not resent. Check the seat with: rig capture ${session}${delivery.record.outcome === "failed" || delivery.record.outcome === "unconfirmed" ? ", then add --resend to send it again" : ""}`;
      case "attempt-in-flight": return `told seat   an attempt for this same list is in flight, or was interrupted and is recovered at the daemon's next start (${delivery.record.deliveryId}); not sent again`;
      case "not-sent": return `told seat   not sent: ${delivery.reason}`;
    }
  }

  cmd
    .command("audit")
    .description("Read-only skill provenance and freshness audit")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));

      const res = await client.get<AuditResponse>("/api/skills/audit");
      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `Audit failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      const { entries, totalFindings, mirrorDriftError, mirrorDriftSkipped } = res.data;
      const hasFail = totalFindings > 0 || !!mirrorDriftError;

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (hasFail) process.exitCode = 1;
        return;
      }

      const active = entries.filter((e) => !e.shadowed);
      const shadowed = entries.filter((e) => e.shadowed);
      const withFindings = active.filter((e) => e.findings.length > 0);

      console.log(`Skill audit: ${active.length} active, ${shadowed.length} shadowed, ${totalFindings} findings\n`);

      if (withFindings.length > 0) {
        console.log("FINDINGS:");
        for (const entry of withFindings) {
          for (const f of entry.findings) {
            console.log(`  [${f.class}] ${entry.id}`);
            console.log(`    file: ${f.file}`);
            console.log(`    reason: ${f.reason}`);
            console.log(`    fix: ${f.remediation}`);
          }
        }
        console.log("");
      }

      if (mirrorDriftError) {
        console.log(`MIRROR DRIFT CHECK UNAVAILABLE: ${mirrorDriftError}`);
        console.log("");
      } else if (mirrorDriftSkipped) {
        // Informational: an installed package has no source mirror to compare.
        console.log(`MIRROR DRIFT CHECK SKIPPED: ${mirrorDriftSkipped}`);
        console.log("");
      }

      if (shadowed.length > 0) {
        console.log("SHADOWED:");
        for (const s of shadowed) {
          console.log(`  ${s.id} at ${s.path} (${s.sourceKind}) -- shadowed by precedence winner`);
        }
        console.log("");
      }

      if (hasFail) {
        const parts: string[] = [];
        if (totalFindings > 0) parts.push(`${totalFindings} finding(s) on active skills`);
        if (mirrorDriftError) parts.push("mirror drift check unavailable");
        console.log(`FAIL: ${parts.join("; ")}`);
        process.exitCode = 1;
      } else {
        console.log("PASS: all active skills have provenance and verified freshness");
      }
    });

  return cmd;
}
