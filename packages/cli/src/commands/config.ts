import { Command } from "commander";
import { ConfigStore, VALID_KEYS, type ResolvedSetting, type ValidKey } from "../config-store.js";
import { initWorkspaceCommand } from "./config-init-workspace.js";

function formatRow(key: string, value: unknown): string {
  return `${key.padEnd(28)} ${value}`;
}

function summarizeSettings(store: ConfigStore): Record<ValidKey, ResolvedSetting> {
  return store.resolveAllWithSource();
}

// SWEEP-c (shape f2576102) — keys the daemon reads ONLY at boot: a set while it runs
// is stale-until-restart; the honest floor is the loud notice (live-reload = its own
// arch item, not built here).
const BOOT_ONLY_KEYS = ["daemon.port", "daemon.host", "db.path"];
const BOOT_ONLY_PREFIXES = ["transcripts."];

function isBootOnlyKey(key: string): boolean {
  return BOOT_ONLY_KEYS.includes(key) || BOOT_ONLY_PREFIXES.some((p) => key.startsWith(p));
}

export function configCommand(
  configPath?: string,
  deps?: {
    /** SWEEP-c test seam: is a daemon currently running? Production probes healthz. */
    probeDaemonRunning?: () => Promise<boolean>;
  },
): Command {
  const cmd = new Command("config").description("Inspect and change OpenRig configuration");
  const store = new ConfigStore(configPath);
  const probeDaemonRunning = deps?.probeDaemonRunning ?? (async () => {
    try {
      const { getDaemonStatus } = await import("../daemon-lifecycle.js");
      const { realDeps } = await import("./daemon.js");
      const status = await getDaemonStatus(realDeps());
      return status.state === "running";
    } catch {
      return false; // probe failure = no notice (never a false claim)
    }
  });

  cmd
    .option("--json", "JSON output for agents (resolved RiggedConfig)")
    .option("--with-source", "Include source/default per key (honest provenance)")
    .addHelpText("after", `
Examples:
  rig config                                 # show all resolved config
  rig config --json                          # JSON RiggedConfig (structured)
  rig config --json --with-source            # JSON per-key with source + default
  rig config get daemon.port                 # read a single key
  rig config get workspace.slices_root --show-source
  rig config set daemon.port 7434            # change a value
  rig config set workspace.slices_root /path # configure a workspace path
  rig config reset                           # delete config file, revert all to defaults
  rig config reset workspace.slices_root     # clear one key, revert to default
  rig config init-workspace                  # scaffold a repo-ready project workspace

Keys:
  daemon.*               port, host
  db.path
  transcripts.*          enabled, path, lines, poll_interval_seconds
                         (lines/poll_interval set scrollback CAPTURE depth + cadence.
                         Thin CLAUDE transcripts usually are NOT these — they mean the
                         seat's fullscreen renderer, whose alternate screen emits no
                         scrollback. OpenRig launches Claude with
                         CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 by default; set
                         OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN=0 to opt back into fullscreen.)
  workspace.*            root, slices_root, steering_path, specs_root,
                         projects_root, catalog_path, operator_seat_name
  topology.root          the topology tree root (instance altitude at its top; default $OPENRIG_HOME/topology)
  context.root           addressable context library for 'rig context add' (default $OPENRIG_HOME/context)
  context.system_world   default System World, replacement manifest path, or disabled
  skills.root            versioned skill catalog (default $OPENRIG_HOME/skills)
  onboarding.default_pack.enabled  deliver the two-part fresh-seat mental-model pack (default on)
  files.allowlist        name:/abs/path,name:/abs/path
  progress.scan_roots    name:/abs/path,name:/abs/path
  ui.preview.*           refresh_interval_seconds, max_pins, default_lines
  recovery.*             auto_drive_provider_prompts, provider_auth_env_allowlist
  agents.*               advisor_session, operator_session
  feed.subscriptions.*   action_required, approvals, shipped, progress, audit_log
  runtime.codex.*        hooks_enabled
  workflow.*             exception_routing (orchestrator | human_only — the maturity-dial host default)
  policies.claude_compaction.*
                         enabled, threshold_percent, compact_instruction,
                         message_inline, message_file_path
  policies.idle_gate_qitem.scan_interval_seconds
  policies.idle_gate_qitem.active_wake_interval_seconds
  snapshots.periodic.*   enabled, interval_seconds, retention_keep
  queue.*                pickup_stall_threshold_minutes (S04 pickup-receipt stall threshold),
                         stuck_sweep_interval_seconds, stuck_sweep_unclaimed_age_minutes (S02 standing stuck sweep),
                         wake_retry_interval_seconds, wake_retry_cap, wake_unconfirmed_window_minutes,
                         wake_swap_grace_seconds (S01 wake-or-escalate ladder)
  retention.*            enabled, transitions_days, watchdog_days,
                         watchdog_keep_per_job, batch_size
  terminal.status_bar    show the inner tmux status bar on launch (default off)

Precedence: CLI flag > environment variable > config file > default`)
    .action((opts: { json?: boolean; withSource?: boolean }) => {
      try {
        if (opts.withSource) {
          const all = summarizeSettings(store);
          if (opts.json) {
            console.log(JSON.stringify(all, null, 2));
          } else {
            for (const key of VALID_KEYS) {
              const r = all[key];
              console.log(formatRow(key, `${r.value}  (source: ${r.source})`));
            }
          }
          return;
        }
        // Default: structured RiggedConfig output (preserves pre-v0
        // bare-action shape so existing scripts / tests keep working).
        const config = store.resolve();
        if (opts.json) {
          console.log(JSON.stringify(config, null, 2));
        } else {
          const all = summarizeSettings(store);
          for (const key of VALID_KEYS) {
            const r = all[key];
            console.log(formatRow(key, `${r.value}  (source: ${r.source})`));
          }
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  const getCmd = new Command("get")
    .argument("<key>", "Config key (e.g. daemon.port)")
    .option("--json", "JSON output with value + source + default")
    .option("--show-source", "Print value + source on a single line")
    .description("Read a single config value")
    .action((key: string, opts: { json?: boolean; showSource?: boolean }) => {
      try {
        if (opts.json || cmd.opts<{ json?: boolean }>().json) {
          console.log(JSON.stringify(store.resolveWithSource(key), null, 2));
          return;
        }
        if (opts.showSource) {
          const r = store.resolveWithSource(key);
          console.log(`${r.value}\t(source: ${r.source})`);
          return;
        }
        console.log(String(store.get(key)));
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  const setCmd = new Command("set")
    .argument("<key>", "Config key (e.g. daemon.port)")
    .argument("<value>", "Value to set")
    .description("Set a config value")
    .action(async (key: string, value: string) => {
      try {
        store.set(key, value);
        console.log(`${key} = ${store.get(key)}`);
        // SWEEP-c: boot-only key + running daemon = stale-until-restart; say so loudly.
        if (isBootOnlyKey(key) && (await probeDaemonRunning())) {
          console.error(`note: '${key}' is read at daemon BOOT — the running daemon keeps its current value; this takes effect on the next daemon restart (rig daemon stop && rig daemon start).`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  const resetCmd = new Command("reset")
    .argument("[key]", "Optional config key to reset (omit to reset entire file)")
    .description("Clear a config override (or delete the entire file when no key given)")
    .action((key: string | undefined) => {
      try {
        store.reset(key);
        if (key) {
          console.log(`${key} reset to default (${store.get(key)}).`);
        } else {
          console.log("Config reset to defaults.");
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.addCommand(getCmd);
  cmd.addCommand(setCmd);
  cmd.addCommand(resetCmd);
  cmd.addCommand(initWorkspaceCommand(configPath));

  return cmd;
}
