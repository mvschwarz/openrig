import { Command } from "commander";
import { ConfigStore, VALID_KEYS, type ResolvedSetting, type ValidKey } from "../config-store.js";
import { initWorkspaceCommand } from "./config-init-workspace.js";

function formatRow(key: string, value: unknown): string {
  return `${key.padEnd(28)} ${value}`;
}

function summarizeSettings(store: ConfigStore): Record<ValidKey, ResolvedSetting> {
  return store.resolveAllWithSource();
}

export function configCommand(configPath?: string): Command {
  const cmd = new Command("config").description("Inspect and change OpenRig configuration");
  const store = new ConfigStore(configPath);

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
  rig config init-workspace                  # scaffold ~/.openrig/workspace/ with missions + slices

Keys:
  daemon.*               port, host
  db.path
  transcripts.*          enabled, path, lines, poll_interval_seconds
  workspace.*            root, slices_root, steering_path, field_notes_root,
                         specs_root, dogfood_evidence_root, operator_seat_name
  files.allowlist        name:/abs/path,name:/abs/path
  progress.scan_roots    name:/abs/path,name:/abs/path
  ui.preview.*           refresh_interval_seconds, max_pins, default_lines
  recovery.*             auto_drive_provider_prompts, provider_auth_env_allowlist
  agents.*               advisor_session, operator_session
  feed.subscriptions.*   action_required, approvals, shipped, progress, audit_log
  runtime.codex.*        hooks_enabled
  policies.claude_compaction.*
                         enabled, threshold_percent, message_inline, message_file_path

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
    .action((key: string, value: string) => {
      try {
        store.set(key, value);
        console.log(`${key} = ${store.get(key)}`);
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
