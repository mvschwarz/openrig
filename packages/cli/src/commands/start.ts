// OPR.0.3.4.1 — rig start: one-command recovery orchestrator.
// Sequences existing primitives: daemon-start -> kernel auto-boot observe ->
// candidate listing (restore-usable snapshots) -> picker/flags ->
// per-rig restore (slice-02 /api/up) + reconcile (slice-03). Re-codes nothing.

import { Command } from "commander";
import { DaemonClient, DaemonConnectionError } from "../client.js";
import {
  getDaemonStatus,
  getDaemonUrl,
  startDaemon,
  waitForKernelReady,
  type LifecycleDeps,
} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const LONG_RUNNING_UP_TIMEOUT_MS = 120_000;
const KERNEL_WAIT_MS = 60_000;

interface RigSummary {
  id: string;
  name: string;
  nodeCount?: number;
  lifecycleState?: string;
}

interface PlanPreviewNode {
  logicalId: string;
  intendedAction: string;
  reason?: string;
}

interface PlanPreviewResponse {
  status: string;
  mode: string;
  rigId: string;
  rigName: string;
  snapshot: { id: string; kind: string; createdAt: string } | null;
  wouldCaptureCurrentState: boolean;
  nodes: PlanPreviewNode[];
  mutated: boolean;
}

export interface StartCandidate {
  rigId: string;
  rigName: string;
  lifecycleState: string;
  nodeCount: number;
  lastActivity: string | null;
  preview: PlanPreviewResponse | null;
}

/** Default interactive [y/N] prompt (same shape as up.ts, reused for the TTY path). */
async function defaultPromptYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Minimal spacebar multi-select picker for TTY (NET-NEW, lightweight). */
async function multiSelectPicker(items: Array<{ label: string; value: string; checked: boolean }>): Promise<string[]> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.close();

  const { createInterface } = readline;
  return new Promise<string[]>((resolve) => {
    const state = items.map((item) => ({ ...item }));
    let cursor = 0;

    const render = () => {
      process.stdout.write("\x1b[?25l");
      for (let i = 0; i < state.length; i++) {
        const prefix = i === cursor ? ">" : " ";
        const check = state[i]!.checked ? "[x]" : "[ ]";
        process.stdout.write(`\r${prefix} ${check} ${state[i]!.label}\n`);
      }
      process.stdout.write(`\r  (space=toggle, enter=confirm, a=all, n=none)\n`);
      process.stdout.write(`\x1b[${state.length + 1}A`);
    };

    render();

    if (!process.stdin.isTTY) {
      resolve(state.filter((s) => s.checked).map((s) => s.value));
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write(`\x1b[${state.length + 1}B\r`);
      process.stdout.write("\x1b[?25h");
    };

    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === " ") {
        state[cursor]!.checked = !state[cursor]!.checked;
        render();
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(state.filter((s) => s.checked).map((s) => s.value));
      } else if (key === "\x1b[A" || key === "k") {
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = Math.min(state.length - 1, cursor + 1);
        render();
      } else if (key === "a") {
        state.forEach((s) => { s.checked = true; });
        render();
      } else if (key === "n") {
        state.forEach((s) => { s.checked = false; });
        render();
      } else if (key === "\x03") {
        cleanup();
        process.exitCode = 130;
        resolve([]);
      }
    };
    process.stdin.on("data", onData);
  });
}

export interface StartDeps extends StatusDeps {
  promptYesNo?: (question: string) => Promise<boolean>;
}

export function startCommand(depsOverride?: StartDeps): Command {
  const cmd = new Command("start")
    .description("Start the daemon, verify kernel, and restore rigs that were last running")
    .addHelpText("after", `
Examples:
  rig start                         Interactive: daemon + kernel + pick-and-restore
  rig start --last                  Headless: restore everything that was running
  rig start --all                   Headless: restore all rigs with restore-usable snapshots
  rig start --rigs prod-rig dev-rig Headless: restore only the named rigs
`);
  const getDepsF = (): StartDeps =>
    depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--last", "Headless: restore all rigs that were last running (zero prompts)")
    .option("--all", "Headless: restore all rigs with restore-usable snapshots (zero prompts)")
    .option("--rigs <names...>", "Headless: restore only the named rigs (zero prompts)")
    .option("--json", "JSON output for agents")
    .action(async (opts: { last?: boolean; all?: boolean; rigs?: string[]; json?: boolean }) => {
      const deps = getDepsF();

      // ---- PHASE 1: ensure daemon is running ----
      let status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running") {
        if (!opts.json) console.log("Starting daemon...");
        try {
          const { ConfigStore } = await import("../config-store.js");
          const configStore = new ConfigStore();
          const resolvedConfig = configStore.resolve();
          const hostResolution = configStore.resolveWithSource("daemon.host");
          const hostForDaemon = hostResolution.source === "default"
            ? undefined
            : resolvedConfig.daemon.host;
          const { SystemPreflight } = await import("../system-preflight.js");
          const { execSync } = await import("node:child_process");
          const { OPENRIG_DIR } = await import("../daemon-lifecycle.js");
          const preflight = new SystemPreflight({
            exec: async (cmd: string) =>
              execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }),
            configStore,
            getDaemonStatus: () => getDaemonStatus(deps.lifecycleDeps),
            openrigHome: OPENRIG_DIR,
          });
          const preflightResult = await preflight.run();
          if (!preflightResult.ready) {
            for (const check of preflightResult.checks.filter((c) => !c.ok)) {
              console.error(`  ${check.name}: ${check.error}`);
              if (check.fix) console.error(`    Fix: ${check.fix}`);
            }
            process.exitCode = 1;
            return;
          }
          await startDaemon({
            port: resolvedConfig.daemon.port,
            host: hostForDaemon,
            db: resolvedConfig.db.path,
            transcriptsEnabled: resolvedConfig.transcripts.enabled,
            transcriptsPath: resolvedConfig.transcripts.path,
            transcriptsLines: resolvedConfig.transcripts.lines,
            transcriptsPollIntervalSeconds: resolvedConfig.transcripts.pollIntervalSeconds,
            workspaceRoot: resolvedConfig.workspace.root,
          }, deps.lifecycleDeps);
          status = await getDaemonStatus(deps.lifecycleDeps);
        } catch (err) {
          console.error(`Daemon start failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 2;
          return;
        }
      }

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon is not healthy. Check with: rig daemon status");
        process.exitCode = 1;
        return;
      }

      const baseUrl = getDaemonUrl(status);
      const client = deps.clientFactory(baseUrl);

      // ---- PHASE 2: kernel invariant — verify/await kernel readiness ----
      if (!opts.json) console.log("Waiting for kernel...");
      const kernelResult = await waitForKernelReady(baseUrl, KERNEL_WAIT_MS);
      if (!kernelResult.ok) {
        if (kernelResult.kernelState === "skipped") {
          if (!opts.json) console.log("Kernel auto-boot skipped (--no-kernel or test mode).");
        } else {
          console.error(`Kernel failed to start: state=${kernelResult.kernelState ?? "unknown"}, detail=${kernelResult.detail ?? "none"}`);
          console.error("Cannot proceed to rig restore without a working kernel.");
          console.error("Fix: resolve the kernel issue, then rerun: rig start");
          process.exitCode = 1;
          return;
        }
      } else if (!opts.json) {
        console.log("Kernel ready.");
      }

      // Verify UI is actually serving before announcing the URL.
      let uiUrl: string | null = null;
      try {
        const healthRes = await fetch(`${baseUrl}/healthz`);
        if (healthRes.ok) {
          uiUrl = baseUrl;
        }
      } catch { /* UI not serving yet — degrade gracefully */ }
      if (uiUrl && !opts.json) {
        console.log(`UI: ${uiUrl}`);
      }

      // ---- PHASE 3: list last-running candidates ----
      let allSummaries: RigSummary[];
      try {
        const res = await client.get<RigSummary[]>("/api/rigs/summary");
        allSummaries = res.data ?? [];
      } catch {
        console.error("Failed to list rigs. Daemon may not be ready.");
        process.exitCode = 1;
        return;
      }

      // Guard BLOCKING f359e3a3: use the id-based Explorer route for candidate
      // preview (POST /api/rigs/:id/up with plan:true) instead of the name-based
      // POST /api/up which 409s on same-name rigs and silently drops them.
      const candidates: StartCandidate[] = [];
      // Guard BLOCKING bfed4ce3: track preview errors so they are not collapsed
      // into a clean empty-candidate result.
      const previewErrors: Array<{ rigId: string; rigName: string; code: string; message: string }> = [];
      for (const rig of allSummaries) {
        if (rig.name === "kernel") continue;
        if (rig.lifecycleState === "running") continue;

        try {
          const planRes = await client.post<Record<string, unknown>>(
            `/api/rigs/${encodeURIComponent(rig.id)}/up`,
            { plan: true },
          );
          if (planRes.status === 200 && planRes.data["status"] === "plan") {
            const preview = planRes.data as unknown as PlanPreviewResponse;

            let lastActivity: string | null = null;
            try {
              const rigDetail = await client.get<{ sessions?: Array<{ lastSeenAt?: string | null }> }>(`/api/rigs/${rig.id}`);
              const sessions = rigDetail.data?.sessions ?? [];
              const dates = sessions.map((s) => s.lastSeenAt).filter((d): d is string => !!d).sort();
              lastActivity = dates.length > 0 ? dates[dates.length - 1]! : null;
            } catch { /* degrade: lastActivity stays null */ }

            candidates.push({
              rigId: rig.id,
              rigName: rig.name,
              lifecycleState: rig.lifecycleState ?? "unknown",
              nodeCount: rig.nodeCount ?? 0,
              lastActivity,
              preview,
            });
          } else if (planRes.status === 404) {
            // no_snapshot or not found — this rig is not a candidate (expected exclusion).
          } else {
            const code = String(planRes.data["code"] ?? `http_${planRes.status}`);
            const errorText = String(planRes.data["error"] ?? "preview failed");
            previewErrors.push({ rigId: rig.id, rigName: rig.name, code, message: errorText });
            if (!opts.json) console.error(`  ${rig.name}: candidate preview failed -- ${errorText} (${code})`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          previewErrors.push({ rigId: rig.id, rigName: rig.name, code: "transport_error", message: msg });
          if (!opts.json) console.error(`  ${rig.name}: candidate preview unavailable (transport error)`);
        }
      }

      if (candidates.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({
            status: previewErrors.length > 0 ? "started_with_errors" : "started",
            candidates: [],
            restoredRigs: [],
            previewErrors: previewErrors.length > 0 ? previewErrors : undefined,
          }));
        } else {
          if (previewErrors.length > 0) {
            console.error(`${previewErrors.length} rig(s) failed preview (see errors above). Some candidates may be missing.`);
          } else {
            console.log("Daemon and kernel are up. No rigs to restore.");
          }
        }
        if (previewErrors.length > 0) process.exitCode = 1;
        return;
      }

      // ---- PHASE 4: selection (id-grounded, rev1 BLOCKING b4c6ada4) ----
      let selectedCandidates: StartCandidate[];
      if (opts.all || opts.last) {
        selectedCandidates = [...candidates];
      } else if (opts.rigs) {
        selectedCandidates = candidates.filter((c) => opts.rigs!.includes(c.rigName));
        const missing = opts.rigs.filter((n) => !candidates.some((c) => c.rigName === n));
        if (missing.length > 0) {
          console.error(`Rig(s) not found in candidate set: ${missing.join(", ")}`);
          console.error(`Available candidates: ${candidates.map((c) => c.rigName).join(", ")}`);
          process.exitCode = 1;
          return;
        }
      } else {
        // TTY interactive: offer fast default + picker
        const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
        if (!interactive) {
          console.error("No TTY available. Use --last, --all, or --rigs <names> for headless mode.");
          if (opts.json) {
            console.log(JSON.stringify({ status: "started", candidates: candidates.map((c) => ({ rigName: c.rigName, lifecycleState: c.lifecycleState })), restoredRigs: [] }));
          }
          process.exitCode = 1;
          return;
        }

        console.log(`\n${candidates.length} rig(s) were last running:\n`);
        for (const c of candidates) {
          const readiness = summarizeReadiness(c);
          const activity = c.lastActivity ? `last active ${c.lastActivity}` : "";
          console.log(`  ${c.rigName}  (${c.nodeCount} seats, ${c.lifecycleState}${activity ? ", " + activity : ""})  ${readiness}`);
        }
        console.log("");

        const ask = depsOverride?.promptYesNo ?? defaultPromptYesNo;
        const restoreAll = await ask(`Restore all ${candidates.length} rig(s)? [Y/pick] `);

        if (restoreAll) {
          selectedCandidates = [...candidates];
        } else {
          const pickedIds = await multiSelectPicker(
            candidates.map((c) => ({
              label: `${c.rigName}  (${c.nodeCount} seats, ${c.lifecycleState})  ${summarizeReadiness(c)}`,
              value: c.rigId,
              checked: true,
            })),
          );
          selectedCandidates = candidates.filter((c) => pickedIds.includes(c.rigId));
        }
      }

      if (selectedCandidates.length === 0) {
        if (!opts.json) console.log("No rigs selected for restore.");
        return;
      }

      // ---- PHASE 5: restore each selected rig via id-based route (compose slice-02 path) ----
      if (!opts.json) console.log(`\nRestoring ${selectedCandidates.length} rig(s)...\n`);

      const results: Array<{ rigName: string; status: string; nodes: Array<{ logicalId: string; status: string; error?: string }> }> = [];

      for (const candidate of selectedCandidates) {
        const rigName = candidate.rigName;
        const rigId = candidate.rigId;

        // Check if the rig is already running (idempotent rerun: reconcile, don't relaunch).
        try {
          const freshSummary = await client.get<RigSummary[]>("/api/rigs/summary");
          const current = (freshSummary.data ?? []).find((r) => r.id === rigId);
          if (current?.lifecycleState === "running") {
            if (!opts.json) console.log(`  ${rigName}: already running (skipping)`);
            results.push({ rigName, status: "already_running", nodes: [] });
            continue;
          }
        } catch { /* proceed with restore attempt */ }

        try {
          // Rev1 BLOCKING b4c6ada4: use id-based route for restore too (not
          // name-based /api/up which 409s on same-name rigs).
          const res = await client.post<Record<string, unknown>>(
            `/api/rigs/${encodeURIComponent(rigId)}/up`,
            { plan: false },
            { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS },
          );

          // Guard BLOCKING 25661f72: check HTTP status before treating the response
          // as a success. The daemon returns non-2xx JSON payloads (rig_not_stopped,
          // pre_restore_validation_failed, ambiguous_name) without throwing.
          if (res.status >= 400) {
            const code = res.data["code"] as string | undefined;
            const errorText = String(res.data["error"] ?? "restore failed");
            if (code === "pre_restore_validation_failed") {
              console.error(`  ${rigName}: restore blocked (pre-validation failed)`);
              const blockers = (res.data["blockers"] as Array<{ message: string; remediation: string }>) ?? [];
              for (const b of blockers) {
                console.error(`    ${b.message}`);
                console.error(`      fix: ${b.remediation}`);
              }
            } else {
              console.error(`  ${rigName}: ${errorText} (${code ?? `HTTP ${res.status}`})`);
            }
            results.push({ rigName, status: code ?? "error", nodes: [] });
            continue;
          }

          const resStatus = res.data["status"] as string;
          const nodes = (res.data["nodes"] as Array<{ logicalId: string; status: string; error?: string }>) ?? [];
          const rigResult = res.data["rigResult"] as string | undefined;

          if (!opts.json) {
            console.log(`  ${rigName}: ${rigResult ?? resStatus}`);
            for (const n of nodes) {
              if (n.status === "awaiting-decision" && n.error) {
                console.log(`    ${n.logicalId}: awaiting-decision -- ${n.error}`);
              } else {
                console.log(`    ${n.logicalId}: ${n.status}`);
              }
            }
          }

          // Handle the awaiting-decision ASK (compose the slice-02 TTY flow).
          const awaiting = nodes.filter((n) => n.status === "awaiting-decision");
          if (awaiting.length > 0) {
            const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) || Boolean(depsOverride?.promptYesNo);
            if (interactive) {
              const ask = depsOverride?.promptYesNo ?? defaultPromptYesNo;
              const accepted: string[] = [];
              for (const n of awaiting) {
                const reason = n.error ?? "original session unresumable";
                const yes = await ask(`    Couldn't resume ${n.logicalId} (reason: ${reason}). Fresh-prime? [y/N] `);
                if (yes) accepted.push(n.logicalId);
              }
              if (accepted.length > 0) {
                try {
                  const freshRes = await client.post<Record<string, unknown>>(
                    `/api/rigs/${encodeURIComponent(rigId)}/up`,
                    { plan: false, freshLogicalIds: accepted },
                    { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS },
                  );
                  if (freshRes.status >= 400) {
                    const freshError = String(freshRes.data["error"] ?? "fresh-prime failed");
                    console.error(`    Fresh-prime for ${rigName}: ${freshError} (HTTP ${freshRes.status})`);
                  } else {
                    const freshNodes = (freshRes.data["nodes"] as Array<{ logicalId: string; status: string }>) ?? [];
                    for (const fn of freshNodes.filter((fn) => accepted.includes(fn.logicalId))) {
                      if (!opts.json) console.log(`    ${fn.logicalId}: ${fn.status}`);
                    }
                  }
                } catch (err) {
                  if (err instanceof DaemonConnectionError) {
                    console.error(`    Fresh-prime timed out for ${rigName}; the daemon may still be processing. Verify with: rig ps`);
                  } else {
                    throw err;
                  }
                }
              } else if (!opts.json) {
                console.log(`    No fresh sessions started for ${rigName}.`);
              }
            } else {
              // Headless: report honestly, no auto-substitute.
              for (const n of awaiting) {
                if (!opts.json) console.error(`    ${n.logicalId}: awaiting-decision -- to fresh-prime: rig up --existing ${rigName} --fresh ${n.logicalId}`);
              }
            }
          }

          results.push({ rigName, status: rigResult ?? resStatus, nodes });
        } catch (err) {
          if (err instanceof DaemonConnectionError) {
            console.error(`  ${rigName}: timed out; the daemon may still be processing. Verify with: rig ps`);
            results.push({ rigName, status: "timeout", nodes: [] });
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  ${rigName}: ${msg}`);
            results.push({ rigName, status: "error", nodes: [] });
          }
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({
          status: previewErrors.length > 0 ? "started_with_errors" : "started",
          uiUrl,
          candidates: candidates.map((c) => ({ rigName: c.rigName, lifecycleState: c.lifecycleState })),
          restoredRigs: results,
          previewErrors: previewErrors.length > 0 ? previewErrors : undefined,
        }));
      }

      // Exit code: 1 if any rig has non-clean outcome. Include HTTP error codes
      // and non-clean rigResult values (partially_restored, failed, not_attempted).
      const NON_CLEAN_STATUSES = new Set(["timeout", "error", "skipped", "partially_restored", "failed", "not_attempted", "rig_not_stopped", "ambiguous_name", "pre_restore_validation_failed"]);
      const hasFailure = previewErrors.length > 0 || results.some((r) =>
        NON_CLEAN_STATUSES.has(r.status) ||
        r.nodes.some((n) => n.status === "failed" || n.status === "awaiting-decision"),
      );
      if (hasFailure) process.exitCode = 1;
    });

  return cmd;
}

function summarizeReadiness(c: StartCandidate): string {
  if (!c.preview) return "";
  const actions = c.preview.nodes.map((n) => n.intendedAction);
  if (actions.every((a) => a === "resume-original")) return "[ready to resume]";
  if (actions.some((a) => a === "awaiting-decision")) return "[will ask before fresh]";
  if (actions.every((a) => a === "fresh-primed")) return "[fresh start]";
  return "[mixed]";
}
