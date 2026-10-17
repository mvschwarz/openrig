// Scratch diagnostic for issue #1405 (not for merge). Synthetic panes only; their layout follows the
// existing login fixture in native-resume-probe.test.ts. The refusal string is Claude's documented
// "Not logged in · Please run /login"; its on-screen placement here is assumed, not captured.
import { describe, expect, it, vi } from "vitest";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";
import { isAttentionRequiredReadinessCode } from "../src/domain/runtime-adapter.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const header = [" ▐▛███▜▌   Claude Code v2.1.302", "▝▜█████▛▘  Opus 4.7 · API Usage Billing", "  ▘▘ ▝▝    /work/project", ""];
const border = "─".repeat(80);
const statusFooter = "                                                    Not logged in · Run /login";
const bar = "  ⏵⏵ accept edits on (shift+tab to cycle)";
const frame = (footer: boolean) => [border, "❯ ", border, ...(footer ? [statusFooter] : []), bar];

export const panes: Record<string, string> = {
  A_gateway_before_turn: [...header, ...frame(true)].join("\n"),
  B_existing_402_fixture: [
    " ▐▛███▜▌   Claude Code v2.1.101", "▝▜█████▛▘  Sonnet 4.6 · API Usage Billing", "  ▘▘ ▝▝    /workspace", "",
    border, "❯ ", border, statusFooter, "  ⏵⏵ accept edits on (shift+tab to cycle)                     ● high · /effort",
  ].join("\n"),
  C_gateway_after_successful_turn: [...header, "> hello", "", "● Hello. What would you like to work on?", "", ...frame(true)].join("\n"),
  D_no_credential_after_refused_turn: [...header, "> hello", "  ⎿  Not logged in · Please run /login", "", ...frame(true)].join("\n"),
  E_headerless_bypass_with_footer: ["Restored conversation", "❯ ", "  ⏵⏵ bypass permissions on (shift+tab to cycle)", statusFooter].join("\n"),
  F_refusal_without_footer: [...header, "> hello", "  ⎿  Login expired · Please run /login", "", ...frame(false)].join("\n"),
  G_stale_refusal_then_success: [...header, "> hello", "  ⎿  Not logged in · Please run /login", "", "> again", "", "● Hi.", "", ...frame(false)].join("\n"),
  H_login_method_chooser_text_unverified: [
    "Select login method:", "",
    " ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise", "",
    "   2. Anthropic Console account · API usage billing", "",
    "   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI",
  ].join("\n"),
};

const commands = ["claude", "2.1.302", "sh"] as const;
const identities = {
  none: {},
  resumeVerified: { claudeResumeIdentityVerified: true },
  autoVerified: { claudeAutoIdentityVerified: true },
} as const;

describe("issue 1405 diagnostic", () => {
  it("records the shared classifier's result for every pane, command and identity input", () => {
    const rows: string[] = [];
    for (const [name, paneContent] of Object.entries(panes)) {
      for (const paneCommand of commands) {
        for (const [identity, flags] of Object.entries(identities)) {
          const r = assessNativeResumeProbe({ runtime: "claude-code", paneCommand, paneContent, ...flags });
          rows.push(`DIAG1405 classifier ${name} cmd=${paneCommand} id=${identity} -> ${r.status}/${r.code}`);
        }
      }
    }
    console.log(rows.join("\n"));
    for (const name of ["A_gateway_before_turn", "B_existing_402_fixture", "C_gateway_after_successful_turn", "D_no_credential_after_refused_turn"]) {
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude", paneContent: panes[name]! }))
        .toMatchObject({ status: "failed", code: "login_required" });
    }
  });

  it("records the adapter readiness a startup caller sees", async () => {
    const rows: string[] = [];
    for (const [name, paneContent] of Object.entries(panes)) {
      for (const paneCommand of ["claude", "2.1.302"]) {
        const tmux = {
          hasSession: vi.fn(async () => true),
          getPaneCommand: vi.fn(async () => paneCommand),
          capturePaneContent: vi.fn(async () => paneContent),
          listPanes: vi.fn(async () => []),
          getPanePid: vi.fn(async () => null),
        } as unknown as TmuxAdapter;
        const fsOps = { readFile: () => { throw new Error("none"); }, writeFile: () => {}, exists: () => false,
          mkdirp: () => {}, copyFile: () => {}, listFiles: () => [] } as unknown as ClaudeAdapterFsOps;
        const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {} });
        const binding: NodeBinding = { id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null,
          cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/work/project" };
        const result = await adapter.checkReady(binding);
        rows.push(`DIAG1405 checkReady ${name} cmd=${paneCommand} -> ready=${result.ready} code=${result.code ?? "-"} attention=${isAttentionRequiredReadinessCode(result.code)}`);
      }
    }
    console.log(rows.join("\n"));
  });
});
