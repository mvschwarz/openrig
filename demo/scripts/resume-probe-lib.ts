import {
  assessNativeResumeProbe,
  buildNativeResumeCommand,
  isProbeShellReady,
} from "../../packages/daemon/src/domain/native-resume-probe.js";
import type { DemoNodeEntry } from "./common.js";
import {
  resolveNodeCwd,
  runTmux,
  sanitizeName,
  sleep,
} from "./common.js";

export interface ProbeOptions {
  pollMs?: number;
  maxWaitMs?: number;
}

export interface ProbeResult {
  logicalId: string;
  runtime: string | null;
  sessionName: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  command: string | null;
  status: "resumed" | "failed" | "inconclusive";
  code: string;
  detail: string;
  paneCommand: string | null;
  paneExcerpt: string;
}

export async function probeNodeResume(
  node: DemoNodeEntry,
  opts: ProbeOptions = {}
): Promise<ProbeResult> {
  const command = buildNativeResumeCommand(
    node.runtime,
    node.resumeToken ?? null,
    node.canonicalSessionName ?? undefined
  );

  if (!command) {
    return {
      logicalId: node.logicalId,
      runtime: node.runtime,
      sessionName: node.canonicalSessionName,
      resumeType: node.resumeType ?? null,
      resumeToken: node.resumeToken ?? null,
      command: null,
      status: "failed",
      code: "missing_resume_metadata",
      detail: "No native resume command could be built from the stored metadata.",
      paneCommand: null,
      paneExcerpt: "",
    };
  }

  const pollMs = opts.pollMs ?? 500;
  const maxWaitMs = opts.maxWaitMs ?? 6_000;
  const attempts = Math.max(1, Math.floor(maxWaitMs / pollMs));
  const sessionName = `rigged-probe-${sanitizeName(node.logicalId)}-${Date.now().toString(36)}`;

  try {
    runTmux(["new-session", "-d", "-s", sessionName, "-c", resolveNodeCwd(node.cwd ?? ".")]);
    await waitForProbeShellReady(sessionName, pollMs);
    runTmux(["send-keys", "-t", sessionName, "-l", command]);
    runTmux(["send-keys", "-t", sessionName, "Enter"]);

    let lastPaneCommand = "";
    let lastPaneContent = "";
    let lastResult = assessNativeResumeProbe({
      runtime: node.runtime,
      paneCommand: "",
      paneContent: "",
    });

    for (let attempt = 0; attempt < attempts; attempt++) {
      lastPaneCommand = runTmux(["display-message", "-p", "-t", sessionName, "#{pane_current_command}"]);
      lastPaneContent = runTmux(["capture-pane", "-t", sessionName, "-p", "-S", "-80"]);
      lastResult = assessNativeResumeProbe({
        runtime: node.runtime,
        paneCommand: lastPaneCommand,
        paneContent: lastPaneContent,
      });

      if (lastResult.status !== "inconclusive") {
        break;
      }

      if (attempt < attempts - 1) {
        await sleep(pollMs);
      }
    }

    return {
      logicalId: node.logicalId,
      runtime: node.runtime,
      sessionName: node.canonicalSessionName,
      resumeType: node.resumeType ?? null,
      resumeToken: node.resumeToken ?? null,
      command,
      status: lastResult.status,
      code: lastResult.code,
      detail: lastResult.detail,
      paneCommand: lastPaneCommand || null,
      paneExcerpt: trimPaneExcerpt(lastPaneContent),
    };
  } finally {
    try {
      runTmux(["kill-session", "-t", sessionName]);
    } catch {
      // Best-effort cleanup.
    }
  }
}

function trimPaneExcerpt(content: string): string {
  const lines = content.split("\n").slice(-20);
  return lines.join("\n").trim();
}

async function waitForProbeShellReady(sessionName: string, pollMs: number): Promise<void> {
  const attempts = Math.max(4, Math.floor(4_000 / Math.max(pollMs, 100)));

  for (let attempt = 0; attempt < attempts; attempt++) {
    const paneCommand = runTmux(["display-message", "-p", "-t", sessionName, "#{pane_current_command}"]);
    const paneContent = runTmux(["capture-pane", "-t", sessionName, "-p", "-S", "-20"]);

    if (isProbeShellReady({ paneCommand, paneContent })) {
      return;
    }

    if (attempt < attempts - 1) {
      await sleep(pollMs);
    }
  }

  await sleep(250);
}
