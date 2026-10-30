import { Command, Option } from "commander";
import { execFileSync } from "node:child_process";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

type TmuxExecFn = (cmd: string) => string;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function attachEnvironmentLines(nodeId: string, sessionName: string, shell: "sh" | "powershell"): string[] {
  return Object.entries({ OPENRIG_NODE_ID: nodeId, OPENRIG_SESSION_NAME: sessionName }).map(([key, value]) =>
    shell === "powershell" ? `$env:${key} = '${value.replace(/'/g, "''")}'` : `export ${key}=${shellQuote(value)}`);
}

type TmuxFileExecFn = (file: string, args: string[]) => string;
const defaultTmuxFileExec: TmuxFileExecFn = (file, args) =>
  execFileSync(file, args, { encoding: "utf-8", windowsHide: true }).trim();

// tmux writes a control character in its output as "_", so a newline between fields can't separate them, and a
// session name may hold spaces or underscores. Ask for the two fixed-shape ids first; the rest of the line is the name.
const TMUX_CONTEXT_FORMAT = "#{pane_id} #{window_id} #{session_name}";
const TMUX_CONTEXT_LINE = /^(%\d+) (@\d+) (.+)$/;

export function resolveAttachContext(tmuxExec?: TmuxExecFn, fileExec: TmuxFileExecFn = defaultTmuxFileExec):
  | { attachmentType: "external_cli" }
  | { attachmentType: "tmux"; tmuxSession: string; tmuxWindow?: string; tmuxPane: string } {
  const tmuxPane = process.env["TMUX_PANE"];
  if (!tmuxPane) {
    return { attachmentType: "external_cli" };
  }

  try {
    const output = tmuxExec
      ? tmuxExec(`tmux display-message -p -t ${shellQuote(tmuxPane)} ${shellQuote(TMUX_CONTEXT_FORMAT)}`)
      : fileExec("tmux", ["display-message", "-p", "-t", tmuxPane, TMUX_CONTEXT_FORMAT]);
    const match = TMUX_CONTEXT_LINE.exec(output.trim());
    if (match) {
      const [, resolvedPane, tmuxWindow, tmuxSession] = match;
      return { attachmentType: "tmux", tmuxSession: tmuxSession!, tmuxWindow, tmuxPane: resolvedPane! };
    }
  } catch {
    // Fall back to external_cli if tmux metadata cannot be resolved.
  }

  return { attachmentType: "external_cli" };
}

export function attachCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("attach").description("Attach the current shell or agent into a rig node");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .requiredOption("--self", "Attach the current shell/agent (required in v1)")
    .requiredOption("--rig <rigId>", "Target rig ID")
    .option("--node <logicalId>", "Attach to an existing logical node")
    .option("--pod <namespace>", "Attach by creating a new member in an existing pod")
    .option("--member <name>", "Member name for pod attach mode")
    .option("--runtime <runtime>", "Runtime for pod attach mode; optional guard for node mode")
    .option("--cwd <path>", "Working directory to record", process.cwd())
    .option("--display-name <name>", "Display label inside tmux; external session name outside tmux")
    .option("--print-env", "Print shell assignments for OPENRIG_NODE_ID and OPENRIG_SESSION_NAME")
    .addOption(new Option("--shell <shell>", "Shell syntax for --print-env").choices(["sh", "powershell"]).default(process.platform === "win32" ? "powershell" : "sh"))
    .option("--json", "JSON output, including the activity env the attached app needs. Its token is a credential: don't print or paste it, and use rig whoami for identity")
    .action(async (opts: {
      self?: boolean;
      rig: string;
      node?: string;
      pod?: string;
      member?: string;
      runtime?: string;
      cwd?: string;
      displayName?: string;
      printEnv?: boolean;
      shell: "sh" | "powershell";
      json?: boolean;
    }) => {
      if (!opts.self) {
        console.error("Only --self is supported right now. Use: rig attach --self ...");
        process.exitCode = 1;
        return;
      }
      if (opts.json && opts.printEnv) {
        console.error("Use either --json or --print-env, not both.");
        process.exitCode = 1;
        return;
      }

      const hasNode = !!opts.node;
      const hasPodFields = !!opts.pod || !!opts.member;
      if (hasNode && hasPodFields) {
        console.error("Specify either --node or --pod + --member + --runtime, not both.");
        process.exitCode = 1;
        return;
      }
      if (!hasNode && !hasPodFields) {
        console.error("Specify --node <logicalId> or --pod <namespace> --member <name> --runtime <runtime>.");
        process.exitCode = 1;
        return;
      }
      if (!hasNode && (!opts.pod || !opts.member || !opts.runtime)) {
        console.error("Pod attach requires --pod <namespace> --member <name> --runtime <runtime>.");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const body: Record<string, unknown> = {
        cwd: opts.cwd ?? process.cwd(),
      };
      if (opts.runtime) body["runtime"] = opts.runtime;

      const attachContext = resolveAttachContext();
      body["attachmentType"] = attachContext.attachmentType;
      if (attachContext.attachmentType === "tmux") {
        body["tmuxSession"] = attachContext.tmuxSession;
        if (attachContext.tmuxWindow) body["tmuxWindow"] = attachContext.tmuxWindow;
        body["tmuxPane"] = attachContext.tmuxPane;
      }
      if (opts.displayName) body["displayName"] = opts.displayName;

      if (hasNode) {
        body["logicalId"] = opts.node;
      } else {
        body["podNamespace"] = opts.pod;
        body["memberName"] = opts.member;
      }

      const res = await client.post<Record<string, unknown>>(`/api/rigs/${encodeURIComponent(opts.rig)}/attach-self`, body);

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        console.error(res.data["error"] ?? `Attach failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      const env = (res.data["env"] ?? {}) as Record<string, unknown>;
      const nodeId = typeof env["OPENRIG_NODE_ID"] === "string" ? env["OPENRIG_NODE_ID"] : "";
      const sessionName = typeof env["OPENRIG_SESSION_NAME"] === "string" ? env["OPENRIG_SESSION_NAME"] : "";

      if (opts.printEnv) {
        for (const line of attachEnvironmentLines(nodeId, sessionName, opts.shell)) console.log(line);
        return;
      }

      const logicalId = String(res.data["logicalId"] ?? opts.node ?? `${opts.pod}.${opts.member}`);
      if (hasNode) {
        console.log(`Attached this shell to node ${logicalId} in rig ${opts.rig}`);
      } else {
        console.log(`Created node ${logicalId} and attached this shell in rig ${opts.rig}`);
      }
      console.log(`Sender:     ${sessionName}`);
      const physicalSession = res.data["sessionName"];
      if (typeof physicalSession === "string" && physicalSession !== sessionName) console.log(`Tmux:       ${physicalSession}`);
      console.log(`Transport:  ${
        res.data["attachmentType"] === "tmux"
          ? "tmux"
          : "external_cli (outbound rig commands available; inbound tmux transport unavailable)"
      }`);
      console.log(`Identity:   rerun with --print-env --shell ${opts.shell} and apply the output in your current shell to persist OPENRIG_NODE_ID/OPENRIG_SESSION_NAME`);
    });

  return cmd;
}
