import { describe, expect, it } from "vitest";
import {
  assessNativeResumeProbe,
  buildNativeResumeCommand,
  buildCodexResumeCore,
  isProbeShellReady,
} from "../src/domain/native-resume-probe.js";

import { CLAUDE_BYPASS_CONSENT } from "./fixtures/claude-bypass-consent.js";

describe("default-path consent", () => {
  it.each([CLAUDE_BYPASS_CONSENT, CLAUDE_BYPASS_CONSENT.replace("    No, exit\n  ❯ Yes, I accept", "  ❯ No, exit\n    Yes, I accept")])("recognizes the current consent menu", screen => {
    expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude", paneContent: screen,
      claudeResumeIdentityVerified: true })).toMatchObject({ status: "attention_required", code: "bypass_consent_gate" });
  });
  it.each([
    "I saw Yes, I accept and No, exit in Bypass Permissions mode.",
    CLAUDE_BYPASS_CONSENT + "\n❯ ",
    CLAUDE_BYPASS_CONSENT.split("\n").map(line => "> " + line).join("\n"),
    "```\n" + CLAUDE_BYPASS_CONSENT + "\n```",
    CLAUDE_BYPASS_CONSENT.replace("❯ Yes", "Yes"),
    CLAUDE_BYPASS_CONSENT.replace("in Bypass Permissions mode.", "in another mode."),
  ])("does not treat prose or an inactive menu as consent", screen => {
    expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude", paneContent: screen }).code).not.toBe("bypass_consent_gate");
  });
});

describe("native resume probe", () => {
  describe("headerless Claude auto-mode requires managed identity proof", () => {
    const screen = "Restored conversation\n❯\u00a0\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n";
    it("keeps every screen-only caller conservative", () => {
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "sh", paneContent: screen }))
        .toMatchObject({ status: "inconclusive", code: "claude_auto_identity_required" });
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "sh", paneContent: screen, claudeAutoIdentityVerified: true }))
        .toMatchObject({ status: "resumed", code: "active_runtime" });
    });
    it.each([
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
      "❯\nThe manual says auto mode on (shift+tab to cycle)",
      "❯\n  ⏵⏵ auto mode on",
    ])("still needs the actual prompt/footer shape: %s", (paneContent) => {
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "sh", paneContent, claudeAutoIdentityVerified: true }).status).not.toBe("resumed");
    });
    it.each([
      ["Accessing workspace:\nYes, I trust this folder", "trust_gate"],
      ["new MCP servers found in .mcp.json\nSelect any you wish to enable\nEnter to confirm", "mcp_gate"],
      ["Not logged in · Run /login", "login_required"],
      ["How would you like to resume?\n❯ Resume from summary\n  Resume full session as-is", "claude_resume_selection_prompt"],
      ["No conversation found", "no_conversation_found"],
    ])("does not let identity proof waive prerequisites: %s", (panel, code) => {
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "sh", paneContent: `${screen}\n${panel}`, claudeAutoIdentityVerified: true }).code).toBe(code);
    });
  });
  describe("Claude's exact resume identity can validate the visible composer", () => {
    const screen = "Restored conversation\n❯\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\n";

    it("accepts a headerless prompt only after exact resume-lineage proof", () => {
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "2.1.283", paneContent: screen }))
        .toMatchObject({ status: "inconclusive", code: "awaiting_runtime" });
      expect(assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "2.1.283",
        paneContent: screen,
        claudeResumeIdentityVerified: true,
      })).toMatchObject({ status: "resumed", code: "verified_native_identity" });
    });

    it.each([
      ["Accessing workspace:\nYes, I trust this folder", "inconclusive", "trust_gate"],
      ["new MCP servers found in .mcp.json\nSelect any you wish to enable\nEnter to confirm", "inconclusive", "mcp_gate"],
      ["Not logged in · Run /login", "failed", "login_required"],
      ["How would you like to resume?\n❯ Resume from summary\n  Resume full session as-is", "attention_required", "claude_resume_selection_prompt"],
      ["No conversation found", "failed", "no_conversation_found"],
    ])("keeps known blocking prompt authoritative despite resume identity proof: %s", (panel, status, code) => {
      expect(assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "2.1.283",
        paneContent: `${screen}\n${panel}`,
        claudeResumeIdentityVerified: true,
      })).toMatchObject({ status, code });
    });
  });
  describe("issue116 headerless custom status lines", () => {
    const reportedFooter = "  5h 71% left · weekly 24% left · GPT-6-Astra high · Context 81% left";
    it.each(["›", "»"])("recognizes the reported footer below a %s conversation prompt", (prompt) => {
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "sh",
        paneContent: `Restored conversation\n${prompt} Continue\n${reportedFooter}`,
      })).toMatchObject({ status: "resumed", code: "active_runtime" });
    });
    it.each([
      "  GPT-8-Example medium · /project",
      "  Context 81% left · gPt-8-Example medium",
      "  weekly 24% left · GPT-8-Example · Context 81% left",
    ])("recognizes a delimited model field independently of field order/case: %s", (footer) => {
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "sh",
        paneContent: `› Continue\n${footer}`,
      }).status).toBe("resumed");
    });
    it.each([
      "› Continue",
      "› Continue\n  weekly 24% left · Context 81% left",
      "› Continue\n  Notes · discussing GPT-8-Example medium · more text",
      "› Continue\n  Notes · gpt-like prose · more text",
      "› Continue\n  GPT-8-Example medium",
      reportedFooter,
      `model: loading\n› Continue\n${reportedFooter}`,
    ])("does not promote absent, vague or booting corroboration: %s", (paneContent) => {
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "codex", paneContent }).status)
        .toBe("inconclusive");
    });
    it.each(["›", "»"])("keeps %s menus blocked with the custom footer", (prompt) => {
      for (const [panel, code] of [
        [`${prompt} 1. gpt-8-example\n  2. gpt-8-other`, "model_selection_gate"],
        [`Do you trust the contents of this directory?\n${prompt} 1. Yes, continue\n  2. No`, "trust_gate"],
        [`Hooks need review\n${prompt} 1. Trust all and continue\n  2. Cancel`, "hook_trust_gate"],
      ]) {
        expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "sh",
          paneContent: `${panel}\n${reportedFooter}`,
        })).toMatchObject({ status: "inconclusive", code });
      }
    });
    it.each([
      ["Do you trust the contents of this directory?\n  Yes, continue", "trust_gate"],
      ["Update available!", "update_gate"],
    ])("does not let a custom footer dismiss an unresolved gate: %s", (gate, code) => {
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "sh",
        paneContent: `› Earlier conversation prompt\n${gate}\n${reportedFooter}`,
      })).toMatchObject({ status: "inconclusive", code });
    });
  });
  it("accepts a new input prompt after dismissed hook review without requiring another header", () => {
    const paneContent = "OpenAI Codex (v0.153.4)\n1 hook needs review before it can run.\nPress t to trust; esc to go back\n› Ask Codex to do anything\n  gpt-6-astra xhigh · /work";
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node", paneContent }).status).toBe("resumed");
  });
  it.each(["", "OpenAI Codex (v0.153.4)", "OpenAI Codex (v0.153.4)\nmodel: loading\n› Ask Codex to do anything"])("does not treat process/header startup as an interactive conversation: %s", (paneContent) => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "codex", paneContent }).status).toBe("inconclusive");
  });
  it.each([
    "Hooks need review\n2 hooks are new or changed.\n2. Trust all and continue",
    "Hooks\nLifecycle hooks from config and enabled plugins.\n2 hooks need review before they can run.\nPress t to trust all; enter to review hooks; esc to close",
    "PostCompact hooks\n1 hook needs review before it can run.\nTrust     New hook - review required\nPress t to trust; esc to go back",
  ])("keeps hook review unavailable even with the native header: %s", (panel) => {
    const result = assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: `OpenAI Codex (v0.153.4)\nmodel: gpt-6-astra\n${panel}` });
    expect(result).toMatchObject({ status: "inconclusive", code: "hook_trust_gate" });
  });

  it("does not treat hook review before a newer native header as a current gate", () => {
    const result = assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: "Hooks need review\n2. Trust all and continue\nOpenAI Codex (v0.153.4)\n› Ready" });
    expect(result.status).toBe("resumed");
  });

  it("recognizes the Codex 0.153 composer marker under the OpenRig shell wrapper", () => {
    const paneContent = [
      "╭─────────────────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.153.4)                      │",
      "│ model:     gpt-6-astra ultra   /model to change │",
      "╰─────────────────────────────────────────────────╯",
      "• You have 3 usage limit resets available. Run /usage to use one.",
      "» Ask Codex to do anything",
      "  gpt-6-astra ultra · ~/Documents/openrig",
    ].join("\n");
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "bash", paneContent })).toMatchObject({
      status: "resumed", code: "active_runtime",
    });
  });

  it("clears an old Codex hook-review panel after the newer » conversation prompt", () => {
    const paneContent = [
      "OpenAI Codex (v0.153.4)",
      "Hooks need review",
      "2 hooks are new or changed.",
      "Press t to trust; esc to go back",
      "» Ask Codex to do anything",
      "  gpt-6-astra ultra · ~/Documents/openrig",
    ].join("\n");
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "bash", paneContent })).toMatchObject({
      status: "resumed", code: "active_runtime",
    });
  });

  it("keeps a numbered » model menu classified as a gate, not a conversation", () => {
    const paneContent = [
      "OpenAI Codex (v0.153.4)",
      "» 1. gpt-6-astra",
      "  2. gpt-6-sol",
      "  gpt-6-astra ultra · ~/Documents/openrig",
    ].join("\n");
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "bash", paneContent })).toMatchObject({
      status: "inconclusive", code: "model_selection_gate",
    });
  });

  it("keeps a visible client/model compatibility failure distinct from a usable TUI", () => {
    const result = assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: "OpenAI Codex\n■ The configured model requires a\nnewer version of Codex. Please upgrade.\n› Write tests for @filename" });
    expect(result).toMatchObject({ status: "attention_required", code: "codex_client_incompatible" });
    expect(result.detail).toContain("changing credentials will not repair");
  });
  it("builds a Claude resume command with the canonical session name when provided", () => {
    expect(
      buildNativeResumeCommand("claude-code", "abc-123", "dev-impl@demo-rig")
    ).toBe("claude --resume 'abc-123' --name 'dev-impl@demo-rig'");
  });

  it("builds a Codex no-profile resume with the explicit -s workspace-write floor flag", () => {
    expect(buildNativeResumeCommand("codex", "019d-token")).toBe(
      "codex -s workspace-write resume '019d-token'"
    );
  });

  it("builds a Codex profile resume with -p flag", () => {
    expect(buildNativeResumeCommand("codex", "019d-token", null, "my-profile")).toBe(
      "codex -p 'my-profile' resume '019d-token'"
    );
  });

  it("returns null when runtime or token are missing", () => {
    expect(buildNativeResumeCommand("terminal", "x")).toBeNull();
    expect(buildNativeResumeCommand("claude-code", null)).toBeNull();
  });

  describe("buildCodexResumeCore (shared builder)", () => {
    it("no-profile emits the explicit -s workspace-write floor flag matching fresh launch", () => {
      expect(buildCodexResumeCore("tok-123")).toBe(
        "codex -s workspace-write resume 'tok-123'"
      );
    });

    it("profile emits -p flag, no posture flags", () => {
      expect(buildCodexResumeCore("tok-123", "dev-profile")).toBe(
        "codex -p 'dev-profile' resume 'tok-123'"
      );
    });

    it("useLast emits --last instead of token", () => {
      expect(buildCodexResumeCore("", null, true)).toBe(
        "codex -s workspace-write resume --last"
      );
    });

    it("profile + useLast emits -p + --last", () => {
      expect(buildCodexResumeCore("", "my-prof", true)).toBe(
        "codex -p 'my-prof' resume --last"
      );
    });

    it("0.5.2-07: a SPEC-pinned model emits -m before the resume subcommand (legacy restore carries the model)", () => {
      expect(buildCodexResumeCore("tok-123", null, false, undefined, undefined, "gpt-5.4-cheap")).toBe(
        "codex -s workspace-write -m 'gpt-5.4-cheap' resume 'tok-123'"
      );
    });

    it("#75: reasoning effort emits -c model_reasoning_effort before the resume subcommand", () => {
      expect(buildCodexResumeCore("tok-123", null, false, undefined, undefined, "gpt-5.4-cheap", undefined, false, "high")).toBe(
        "codex -s workspace-write -m 'gpt-5.4-cheap' -c 'model_reasoning_effort=\"high\"' resume 'tok-123'"
      );
    });
  });

  it("classifies Claude no-conversation output as failed", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "zsh",
        paneContent: "No conversation found with session ID: abc123\nuser@example.test %",
      })
    ).toEqual({
      status: "failed",
      code: "no_conversation_found",
      detail: "Claude reported that the requested session no longer exists.",
    });
  });

  it("classifies Claude with an active claude pane as resumed", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent: "Working on it…",
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Claude is the active foreground process in the probe pane.",
    });
  });

  it("classifies a Claude workspace trust prompt as blocked, not resumed", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent: [
          "Accessing workspace:",
          "/some/workspace",
          "",
          "Quick safety check: Is this a project you created or one you trust?",
          "1. Yes, I trust this folder",
          "2. No, exit",
        ].join("\n"),
      })
    ).toEqual({
      status: "inconclusive",
      code: "trust_gate",
      detail: "Claude is waiting for workspace trust approval before the session can become interactive.",
    });
  });

  it("classifies the Claude MCP project-server approval screen as blocked, not failed", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude.exe",
        paneContent: [
          "────────────────────────────────────────────────────────────────────────────────",
          "  2 new MCP servers found in .mcp.json",
          "  Select any you wish to enable.",
          "",
          "  MCP servers may execute code or access system resources. All tool calls",
          "  require approval. Learn more in the MCP documentation.",
          "",
          "  ❯ [✔] exa",
          "    [✔] context7",
          " Space to select · Enter to confirm · Esc to reject all",
        ].join("\n"),
      })
    ).toEqual({
      status: "inconclusive",
      code: "mcp_gate",
      detail: "Claude is waiting for project MCP server approval before the session can become interactive.",
    });
  });

  it("classifies a live Claude TUI as resumed even when tmux reports a version string process", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "2.x",
        paneContent: [
          "Claude Code vX.Y.Z",
          "❯ Working on a task.",
          "────────────────────────────────────────────────────────────────────────────────",
          "  ? for shortcuts                                             ● high · /effort",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Claude is running with an active interactive TUI in the probe pane.",
    });
  });

  it("classifies the current Claude splash TUI as resumed even before the shortcuts footer renders", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "2.x",
        paneContent: [
          " ▐▛███▜▌   Claude Code vX.Y.Z",
          "▝▜█████▛▘  Model details here",
          "  ▘▘ ▝▝    /some/workspace",
          "",
          "────────────────────────────────────────────────────────────────────────────────",
          "❯ ",
          "────────────────────────────────────────────────────────────────────────────────",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Claude is running with an active interactive TUI in the probe pane.",
    });
  });

  it("classifies the current Claude edit-approval footer as resumed", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "2.x",
        paneContent: [
          "Loading startup skills and recovering identity.",
          "",
          "────────────────────────────────────────────────────────────────────────────────",
          "❯ ",
          "────────────────────────────────────────────────────────────────────────────────",
          "  ⏵⏵ accept edits on (shift+tab to cycle)                     ● high · /effort",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Claude is running with an active interactive TUI in the probe pane.",
    });
  });

  it("classifies the Claude login-required screen as failed, not resumed", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "2.x",
        paneContent: [
          " ▐▛███▜▌   Claude Code v2.1.101",
          "▝▜█████▛▘  Sonnet 4.6 · API Usage Billing",
          "  ▘▘ ▝▝    /workspace",
          "",
          "────────────────────────────────────────────────────────────────────────────────",
          "❯ ",
          "────────────────────────────────────────────────────────────────────────────────",
          "                                                    Not logged in · Run /login",
          "  ⏵⏵ accept edits on (shift+tab to cycle)                     ● high · /effort",
        ].join("\n"),
      })
    ).toEqual({
      status: "failed",
      code: "login_required",
      detail: "Claude is running but cannot continue until the user logs in.",
    });
  });

  it("classifies Codex missing-session output as failed", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "zsh",
        paneContent: "ERROR: No saved session found with ID 019d...",
      })
    ).toEqual({
      status: "failed",
      code: "no_saved_session",
      detail: "Codex reported that the requested saved session does not exist.",
    });
  });

  it("classifies a Codex workspace trust prompt as blocked, not resumed", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex",
        paneContent: [
          "> You are in /some/workspace",
          "",
          "  Do you trust the contents of this directory? Working with untrusted contents",
          "  comes with higher risk of prompt injection.",
          "",
          "› 1. Yes, continue",
          "  2. No, quit",
          "",
          "  Press enter to continue",
        ].join("\n"),
      })
    ).toEqual({
      status: "inconclusive",
      code: "trust_gate",
      detail: "Codex is waiting for workspace trust approval before the session can become interactive.",
    });
  });

  it("classifies Codex as active when the current TUI appears below an old trust prompt in scrollback", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex-aarch64-a",
        paneContent: [
          "> You are in /some/workspace",
          "",
          "  Do you trust the contents of this directory? Working with untrusted contents",
          "",
          "› 1. Yes, continue",
          "  2. No, quit",
          "",
          "╭────────────────────────────────────────────────────╮",
          "│ >_ OpenAI Codex (v0.130.0)                         │",
          "╰────────────────────────────────────────────────────╯",
          "",
          "› Write tests for @filename",
          "",
          "  gpt-5.5 xhigh fast · Context 0% used · Fast on",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Codex is running with an active interactive TUI in the probe pane.",
    });
  });

  it("classifies Codex update prompts as inconclusive", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex-aarch64-a",
        paneContent: "✨ Update available! 0.117.0 -> 0.118.0\nPress enter to continue",
      })
    ).toEqual({
      status: "inconclusive",
      code: "update_gate",
      detail: "Codex reached an update flow, so process-alive alone is not proof of a restored conversation.",
    });
  });

  it("classifies a Codex numbered model-selection prompt as blocked before active runtime", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex-aarch64-a",
        paneContent: [
          "╭───────────────────────────────────────╮",
          "│ >_ OpenAI Codex (v0.124.0)            │",
          "╰───────────────────────────────────────╯",
          "",
          "› 1. Switch to gpt-5.1-codex-mini Optimized for codex. Cheaper,",
          "  2. Switch to gpt-5.4-codex Stronger for complex tasks.",
          "  3. Keep current model",
          "",
          "  gpt-5.4 default · ~/code/openrig",
        ].join("\n"),
      })
    ).toEqual({
      status: "inconclusive",
      code: "model_selection_gate",
      detail: "Codex is waiting for model selection before the session can become interactive.",
    });
  });

  it("classifies Codex numbered model options structurally without sampled prompt wording", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex",
        paneContent: [
          "› 1. gpt-5.1-codex-mini",
          "  2. gpt-5.4-codex",
          "",
          "  gpt-5.4 default · ~/code/openrig",
        ].join("\n"),
      }).code
    ).toBe("model_selection_gate");
  });

  it("classifies Codex as resumed when an old update banner remains in scrollback but the live TUI is present", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex-aarch64-a",
        paneContent: [
          "✨ Update available! 0.120.0 -> 0.121.0",
          "Run npm install -g @openai/codex to update.",
          "",
          "╭───────────────────────────────────────╮",
          "│ >_ OpenAI Codex (v0.120.0)            │",
          "│                                       │",
          "│ model:     gpt-5.4   /model to change │",
          "│ directory: ~/code/openrig             │",
          "╰───────────────────────────────────────╯",
          "",
          "› Improve documentation in @filename",
          "",
          "  gpt-5.4 default · ~/code/openrig",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Codex is running with an active interactive TUI in the probe pane.",
    });
  });

  it("classifies Codex as resumed when tmux reports node and the header has scrolled out but the live prompt footer remains", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "node",
        paneContent: [
          "› Without using tools or reading files, reply in exactly one line: CONFIRM",
          "  CODEX2_B_20260418T1431 crimson-delta-pulse. Remember both exact lines for",
          "  later continuity verification.",
          "",
          "",
          "• CONFIRM CODEX2_B_20260418T1431 crimson-delta-pulse",
          "",
          "",
          "› Use /skills to list available skills",
          "",
          "  gpt-5.4 default · ~/code/openrig",
          "",
          "",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Codex is running with an active interactive TUI in the probe pane.",
    });
  });

  // Screen-derived regression contributed by Aummadour in PR120.
  it.each(["codex", "sh"])("classifies a resumed Codex 0.157 TUI with a mixed-case model footer as resumed (pane %s)", (paneCommand) => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand,
        paneContent: [
          "• Ran echo SHELL-CX-5K2",
          "  └ SHELL-CX-5K2",
          "• SHELL-CX-5K2; SKILL-TOKEN-Q7R2; NONCE-CX-8H3",
          "",
          "› Ask Codex to do anything",
          "",
          "  GPT-5.6-Luna max · ~/project · Recovery",
          "  ? for shortcuts                                     ⚠ 2 warnings · f2 to view",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Codex is running with an active interactive TUI in the probe pane.",
    });
  });

  it("keeps a foreground Codex process without a native prompt unverified", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex-aarch64-a",
        paneContent: "Ready.",
      })
    ).toEqual({
      status: "inconclusive",
      code: "awaiting_runtime",
      detail: "Codex did not report an explicit failure, but an interactive conversation has not been observed.",
    });
  });

  it("classifies a shell fallback as failed for known interactive runtimes", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "zsh",
        paneContent: "user@example.test %",
      })
    ).toEqual({
      status: "failed",
      code: "returned_to_shell",
      detail: "The probe pane returned to a shell instead of staying inside the runtime.",
    });
  });

  it("reports a probe shell as ready only after it has rendered prompt content", () => {
    expect(
      isProbeShellReady({
        paneCommand: "zsh",
        paneContent: "",
      })
    ).toBe(false);

    expect(
      isProbeShellReady({
        paneCommand: "zsh",
        paneContent: "user@example.test rigged % ",
      })
    ).toBe(true);

    expect(
      isProbeShellReady({
        paneCommand: "claude",
        paneContent: "Claude Code v2.1.89",
      })
    ).toBe(false);
  });

  // L3: Claude resume-selection prompt → attention_required.
  describe("Claude resume-selection prompt (L3)", () => {
    it("classifies a numbered Claude resume-selection prompt as attention_required", () => {
      const paneContent = [
        "Claude Code v2.1.89",
        "",
        "Choose a conversation to resume:",
        "",
        "  1. project-foo (modified 2h ago)",
        "  2. project-bar (modified yesterday)",
        "  3. project-baz (modified last week)",
        "",
        "Enter a number, or press q to cancel.",
      ].join("\n");

      const result = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent,
      });

      expect(result.status).toBe("attention_required");
      expect(result.code).toBe("claude_resume_selection_prompt");
    });

    it("classifies the › arrow variant of the resume-selection prompt as attention_required", () => {
      const paneContent = [
        "Choose the conversation to resume:",
        "",
        "› 1. recent project",
        "  2. older project",
      ].join("\n");

      const result = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent,
      });

      expect(result.status).toBe("attention_required");
    });

    it("classifies the current two-choice resume-mode prompt as attention_required", () => {
      const paneContent = [
        "How would you like to resume?",
        "",
        "❯ Resume from summary",
        "  Resume full session as-is",
      ].join("\n");

      const result = assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude", paneContent });

      expect(result).toMatchObject({ status: "attention_required", code: "claude_resume_selection_prompt" });
    });

    it("does not classify a prose mention of only one current chooser option", () => {
      const result = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent: "The recovery notes recommend Resume from summary when context is stale.",
      });

      expect(result.status).not.toBe("attention_required");
    });

    it("does not classify both current chooser labels in active-TUI prose", () => {
      const result = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "2.1.89",
        paneContent: [
          "Claude Code v2.1.89",
          "❯ Compare Resume from summary with Resume full session as-is in the recovery notes.",
          "────────────────────────────────────────────────────────────────────────────────",
          "  ⏵⏵ accept edits on (shift+tab to cycle)                     ● high · /effort",
        ].join("\n"),
      });

      expect(result).toMatchObject({ status: "resumed", code: "active_runtime" });
    });

    it("does NOT classify Claude active TUI as resume-selection prompt (regression)", () => {
      const paneContent = [
        "Claude Code v2.1.89",
        "",
        " ❯ accept edits on",
        "",
        "[work in progress]",
      ].join("\n");

      const result = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent,
      });

      // Should NOT be attention_required — this is the active TUI case.
      expect(result.status).toBe("resumed");
      expect(result.code).toBe("active_runtime");
    });

    it("does NOT classify mere mention of 'Choose a conversation' without numbered options", () => {
      const paneContent = "The docs say: 'Choose a conversation to focus on.'";
      const result = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent,
      });

      // Without a numbered option list, this is not a real prompt.
      expect(result.status).not.toBe("attention_required");
    });
  });

  // Codex auth-refusal -> attention_required. Closes the deferral recorded by
  // the lifecycle scenario matrix slice. Pane patterns sourced verbatim from
  // codex-cli 0.125.0 binary strings (token-refresh failure paths).
  describe("Codex auth-refusal recognition", () => {
    it("classifies Codex post-logout token-refresh failure as attention_required", () => {
      const paneContent = [
        "$ codex -s workspace-write resume 019d-token",
        "Error: Your access token could not be refreshed because you have since",
        "logged out or signed in to another account. Please sign in again.",
      ].join("\n");
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "zsh",
        paneContent,
      });
      expect(result).toEqual({
        status: "attention_required",
        code: "codex_auth_refusal",
        detail: "Codex could not refresh the stored access token; an operator must sign in again before the session can resume.",
      });
    });

    it("classifies Codex token-refresh failure with `log out and sign in` guidance as attention_required", () => {
      const paneContent = [
        "$ codex -s workspace-write resume 019d-token",
        "Your access token could not be refreshed.",
        "Please log out and sign in again.",
      ].join("\n");
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "zsh",
        paneContent,
      });
      expect(result.status).toBe("attention_required");
      expect(result.code).toBe("codex_auth_refusal");
    });

    it("requires BOTH the access-token phrase AND operator-instruction phrase (negative)", () => {
      // Access-token phrase alone (without operator instruction) does not
      // qualify — could appear in incidental debug output.
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex",
        paneContent: "debug: access token could not be refreshed (retrying...)",
      });
      expect(result.status).not.toBe("attention_required");
    });

    it("does NOT collide with no_saved_session (different code path)", () => {
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "zsh",
        paneContent: "ERROR: No saved session found with ID 019d...",
      });
      expect(result.code).toBe("no_saved_session");
      expect(result.status).toBe("failed");
    });

    it("does NOT collide with trust_gate", () => {
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex",
        paneContent: [
          "Do you trust the contents of this directory?",
          "› 1. Yes, continue",
          "  2. No, quit",
        ].join("\n"),
      });
      expect(result.code).toBe("trust_gate");
    });

    it("classifies the Codex hook review prompt as hook_trust_gate", () => {
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex",
        paneContent: [
          "Hooks need review",
          "3 hooks are new or changed.",
          "1. Review hooks",
          "2. Trust all and continue",
          "3. Continue without trusting (hooks won't run)",
        ].join("\n"),
      });
      expect(result.code).toBe("hook_trust_gate");
      expect(result.status).toBe("inconclusive");
    });

    it("does NOT collide with active_runtime when codex is foreground without auth-refusal text", () => {
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex",
        paneContent: "OpenAI Codex (v0.125.0)\n  ›  ready\n  gpt-5 · context",
      });
      expect(result.status).toBe("resumed");
      expect(result.code).toBe("active_runtime");
    });
  });

  describe("cursor", () => {
    const FRESH = [
      "  Cursor Agent",
      "  v2026.09.28-64d2043",
      "  Tip: Use /plan to plan execution and reach the right outcome faster.",
      "  → Plan, search, build anything",
      "  Grok 4.7 256K Low                                              Auto-review",
      "  /work/repo",
      "  · main",
    ].join("\n");
    const IDLE_AFTER_TURN = [
      "  $ touch probe.txt 2.5s",
      "  finished",
      "  → Add a follow-up",
      "  Grok 4.7 256K Low · 8.7%                                       Auto-review",
      "  /work/repo · main",
    ].join("\n");
    const TRUST = [
      "  ⚠ Workspace Trust Required",
      "  Cursor Agent can execute code and access files in this directory.",
      "  Do you trust the contents of this directory?",
      "  ▶ [a] Trust this workspace",
      "    [q] Quit",
    ].join("\n");

    it("is ready on the fresh prompt", () => {
      expect(assessNativeResumeProbe({ runtime: "cursor", paneCommand: "cursor-agent", paneContent: FRESH }))
        .toMatchObject({ status: "resumed", code: "active_runtime" });
    });

    it("is ready after a turn, when the header has scrolled away", () => {
      expect(assessNativeResumeProbe({ runtime: "cursor", paneCommand: "cursor-agent", paneContent: IDLE_AFTER_TURN }))
        .toMatchObject({ status: "resumed", code: "active_runtime" });
    });

    it("reports the workspace-trust panel as attention", () => {
      expect(assessNativeResumeProbe({ runtime: "cursor", paneCommand: "cursor-agent", paneContent: TRUST }))
        .toMatchObject({ status: "attention_required", code: "trust_gate" });
    });

    it("reports a shell as returned_to_shell", () => {
      expect(assessNativeResumeProbe({ runtime: "cursor", paneCommand: "zsh", paneContent: "➜  repo " }))
        .toMatchObject({ status: "failed", code: "returned_to_shell" });
    });

    it("waits while nothing recognisable is on screen", () => {
      expect(assessNativeResumeProbe({ runtime: "cursor", paneCommand: "cursor-agent", paneContent: "" }))
        .toMatchObject({ status: "inconclusive", code: "awaiting_runtime" });
    });

    it("does not take a Cursor screen as ready for another runtime", () => {
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "codex", paneContent: FRESH }).status)
        .not.toBe("resumed");
    });

    it("builds the manual resume command", () => {
      expect(buildNativeResumeCommand("cursor", "167733b3-080d-4eb0-a30a-7d22c40b5195"))
        .toBe("cursor-agent --resume '167733b3-080d-4eb0-a30a-7d22c40b5195'");
      expect(buildNativeResumeCommand("cursor", "167733b3-080d-4eb0-a30a-7d22c40b5195", null, null, "/h/state/cursor/node-1"))
        .toBe("CURSOR_CONFIG_DIR='/h/state/cursor/node-1' cursor-agent --resume '167733b3-080d-4eb0-a30a-7d22c40b5195'");
    });

    it("reports a shell pane with residual Cursor output as returned_to_shell", () => {
      expect(
        assessNativeResumeProbe({
          runtime: "cursor",
          paneCommand: "zsh",
          paneContent: "  → Add a follow-up",
        })
      ).toMatchObject({ status: "failed", code: "returned_to_shell" });
    });

    it("does not take an arrow line without the model footer as the chat (sign-in, update or error screens)", () => {
      const signIn = ["  Cursor Agent", "  v2026.09.28-64d2043", "  → Sign in with browser", "    Use an API key"].join("\n");
      expect(assessNativeResumeProbe({ runtime: "cursor", paneCommand: "cursor-agent", paneContent: signIn }))
        .toMatchObject({ status: "inconclusive", code: "awaiting_runtime" });
      const footerAbovePrompt = ["  Grok 4.7 256K Low · 8.7%", "  → Add a follow-up"].join("\n");
      expect(assessNativeResumeProbe({ runtime: "cursor", paneCommand: "cursor-agent", paneContent: footerAbovePrompt }).status)
        .not.toBe("resumed");
    });

    it("reports a screen with both trust-required and Cursor prompt line as trust_gate", () => {
      const mixed = [
        ...TRUST.split("\n"),
        "  → Add a follow-up",
      ].join("\n");
      expect(assessNativeResumeProbe({ runtime: "cursor", paneCommand: "cursor-agent", paneContent: mixed }))
        .toMatchObject({ status: "attention_required", code: "trust_gate" });
    });
  });
});
