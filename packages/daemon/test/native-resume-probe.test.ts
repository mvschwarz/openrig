import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessNativeResumeProbe,
  buildNativeResumeCommand,
  buildCodexResumeCore,
  isProbeShellReady,
} from "../src/domain/native-resume-probe.js";

import { CLAUDE_BYPASS_CONSENT } from "./fixtures/claude-bypass-consent.js";

const currentUpdatePrompt = fs.readFileSync(new URL("./fixtures/codex-update-0.160.0.txt", import.meta.url), "utf8");
// Codex's own rust-v0.156.1 snapshot at b412ff32c417f855c2b2d1581b77058eed87c84b:
// https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/tui/src/onboarding/snapshots/codex_tui__onboarding__trust_directory__tests__renders_snapshot_for_git_repo.snap
const currentTrustPrompt = fs.readFileSync(new URL("./fixtures/codex-trust-0.156.1.txt", import.meta.url), "utf8");

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
      ["● Not logged in · Please run /login\n❯\u00a0", "login_required"],
      ["How would you like to resume?\n❯ Resume from summary\n  Resume full session as-is", "claude_resume_selection_prompt"],
      ["No conversation found", "no_conversation_found"],
    ])("does not let identity proof waive prerequisites: %s", (panel, code) => {
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "sh", paneContent: `${screen}\n${panel}`, claudeAutoIdentityVerified: true }).code).toBe(code);
    });
    it("lets identity proof decide when only the not-logged-in footer shows", () => {
      const paneContent = `${screen}                                   Not logged in · Run /login\n`;
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "sh", paneContent }))
        .toMatchObject({ status: "inconclusive", code: "claude_auto_identity_required" });
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "sh", paneContent, claudeAutoIdentityVerified: true }))
        .toMatchObject({ status: "resumed", code: "active_runtime" });
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
      ["● Not logged in · Please run /login\n❯\u00a0", "failed", "login_required"],
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

    it("lets resume identity decide when only the not-logged-in footer shows", () => {
      const paneContent = `${screen}                                   Not logged in · Run /login\n`;
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "2.1.283", paneContent }))
        .toMatchObject({ status: "inconclusive", code: "awaiting_runtime" });
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "2.1.283", paneContent, claudeResumeIdentityVerified: true }))
        .toMatchObject({ status: "resumed", code: "verified_native_identity" });
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
    // george661's footer on closed #1764: Codex renders "{display name} {effort}{ tier}", so a GPT-6.1 footer has two
    // or three words after the id once the header has scrolled off.
    it.each([
      "  GPT-6.1 Sol medium · /data/workspaces/proof-a · …",
      "  Context 81% left · GPT-6.1 Luna xhigh · /project",
      "  GPT-6.1 Sol medium Fast · /project",
      "  GPT-6.1 Sol medium fast · /project",
      "  GPT-6-Astra xhigh · /project",
    ])("recognizes a model name with its effort label as a resumed conversation: %s", (footer) => {
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "sh",
        paneContent: `Restored conversation\n› Continue\n${footer}`,
      })).toMatchObject({ status: "resumed", code: "active_runtime" });
    });
    // Short prose after a model id must not let a shell or log capture read as a ready Codex screen.
    describe.each([false, true])("status prose that starts with a model name, process verified=%s", (codexProcessVerified) => {
      it.each([
        "  GPT-6.1 is not ready · retry later",
        "  GPT-6.1 is default · see the docs",
        "  GPT-6.1 Sol failed · retry later",
        "  Notes · GPT-6.1 is unavailable · retry later",
        "  GPT-6.1 Sol was picked for this run because it costs less · see the plan",
        "  GPT-6.1 Sol medium plus more words · /project",
        "  local-model-7b is not ready · retry later",
      ])("is not read as a footer: %s", (line) => {
        expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: codexProcessVerified ? "codex" : "sh",
          paneContent: `› Continue\n${line}`, codexProcessVerified,
        }).status).not.toBe("resumed");
      });
    });
    it.each([
      "  local-model-7b medium · /project",
      "  anthropic/claude-3.5-sonnet · /project",
      "  local-model-7b Coder high · /project",
    ])("recognizes a versioned non-gpt model identifier after process verification: %s", (footer) => {
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "sh",
        paneContent: `› Continue\n${footer}`,
        codexProcessVerified: true,
      }).status).toBe("resumed");
    });
    it("recognizes the issue 1764 warning footer after process verification", () => {
      const paneContent = [
        "› ",
        "  Ready · Context 13% used · anthropic/claude-3.5-sonnet         ⚠ 2 warnings · f2 to view",
      ].join("\n");
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "zsh", paneContent,
        codexProcessVerified: true,
      })).toMatchObject({ status: "resumed", code: "active_runtime" });
    });
    it("does not promote a verified Codex process while the captured screen is still a shell", () => {
      const paneContent = [
        "  project2 · main",
        "› codex resume 019a136b-0000-7000-8000-000000000001",
      ].join("\n");
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "zsh", paneContent,
        codexProcessVerified: true,
      }).status).not.toBe("resumed");
    });
    it.each([
      "› Continue",
      "› Continue\n  weekly 24% left · Context 81% left",
      "› Continue\n  Context81 · /project",
      "› Continue\n  Notes · discussing GPT-8-Example medium · more text",
      "› Continue\n  Notes · gpt-like prose · more text",
      "› Continue\n  GPT-8-Example medium",
      "› Continue\n  local-model medium · /project",
      "› \n  Ready · Context 13% used · anthropic/claude-3.5-sonnet         ⚠ 2 warnings · f2 to view",
      "  project2 · main\n› ",
      "  project2 · main\n› codex resume 019a136b-0000-7000-8000-000000000001",
      reportedFooter,
      `model: loading\n› Continue\n${reportedFooter}`,
    ])("does not promote absent, vague or booting corroboration: %s", (paneContent) => {
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "codex", paneContent }).status)
        .toBe("inconclusive");
    });
    it("keeps a trust panel authoritative over a look-alike non-gpt footer", () => {
      const paneContent = [
        "Do you trust the contents of this directory?",
        "› 1. Yes, continue",
        "  2. No, quit",
        "  Ready · Context 13% used · anthropic/claude-3.5-sonnet         ⚠ 2 warnings · f2 to view",
      ].join("\n");
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "zsh", paneContent,
        codexProcessVerified: true,
      })).toMatchObject({ status: "inconclusive", code: "trust_gate" });
    });
    it("accepts a verified custom footer after a legacy trust panel has been dismissed", () => {
      const paneContent = [
        "Do you trust the contents of this directory?",
        "› 1. Yes, continue",
        "  2. No, quit",
        "› Continue",
        "  Ready · Context 13% used · anthropic/claude-3.5-sonnet         ⚠ 2 warnings · f2 to view",
      ].join("\n");
      expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "zsh", paneContent,
        codexProcessVerified: true,
      })).toMatchObject({ status: "resumed", code: "active_runtime" });
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
      [currentUpdatePrompt.trimEnd(), "update_gate"],
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
    ).toBe("claude --permission-mode acceptEdits --resume 'abc-123' --name 'dev-impl@demo-rig'");
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

  it("reads the persistent not-logged-in footer on a live Claude TUI as input readiness, not a login refusal", () => {
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
    ).toMatchObject({ status: "resumed", code: "active_runtime" });
  });

  // #1405. The frame is a native Claude Code 2.1.296 capture: header, `❯` prompt row, `●` reply, input box, mode
  // bar. The refusal strings are Claude's documented ones (code.claude.com/docs/en/errors); where Claude draws a
  // refusal was not captured, so both a `●` reply row and a `⎿` result row are covered.
  describe("a Claude login refusal counts only as the latest response", () => {
    const native = fs.readFileSync(new URL("./fixtures/input-box/claude-code-2.1.296/after-enter-15s.J.txt", import.meta.url), "utf8").split("\n");
    const head = native.slice(0, native.findIndex((line) => line.startsWith("❯ Reply with")));
    const tail = native.slice(native.findIndex((line) => line.startsWith("✻ Cooked")) + 1);
    const lastRule = tail.findLastIndex((line) => line.startsWith("────"));
    const footerTail = [...tail.slice(0, lastRule + 1), "                                                    Not logged in · Run /login", ...tail.slice(lastRule + 1)];
    const pane = (history: string[], footer = false) => [...head, ...history, ...(footer ? footerTail : tail)].join("\n");
    const refusal = "Not logged in · Please run /login";

    it.each([
      ["the footer before any turn", pane([], true), "resumed"],
      ["the footer after a completed turn", pane(["❯ Reply with OK.", "", "● OK", ""], true), "resumed"],
      ["a current refusal as a reply row, with the footer", pane(["❯ hello", "", `● ${refusal}`, ""], true), "failed"],
      ["a current refusal as a result row, without the footer", pane(["❯ hello", `  ⎿  ${refusal}`, ""]), "failed"],
      ["a current expired-login refusal", pane(["❯ hello", "", "● Login expired · Please run /login", ""]), "failed"],
      ["a refusal followed by a newer reply", pane(["❯ hello", "", `● ${refusal}`, "", "❯ again", "", "● OK", ""]), "resumed"],
      ["a refusal followed by /login", pane(["❯ hello", "", `● ${refusal}`, "", "❯ /login", "  ⎿  Login successful", ""]), "resumed"],
      ["a refusal quoted in a prompt", pane([`❯ What does "${refusal}" mean?`, "", "● It means Claude has no login of its own.", ""]), "resumed"],
      ["a refusal on a prompt's own row while the turn runs", pane(["❯ Explain this message:", `  ${refusal}`, "", "✶ Thinking… (2s)", ""]), "resumed"],
      ["a refusal quoted on its own row inside a reply", pane(["❯ hello", "", "● Claude shows this when it has no login:", "", `  ${refusal}`, "", "  Run /login to fix it.", ""]), "resumed"],
      ["a refusal quoted inline in a reply", pane(["❯ hello", "", `● The message "${refusal}" means no login.`, ""]), "resumed"],
    ])("%s", (_name, paneContent, status) => {
      const result = assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude", paneContent });
      expect(result.status).toBe(status);
      if (status === "failed") expect(result.code).toBe("login_required");
    });

    // Only the three exact strings count. A real 401 reads ready for input, with or without the footer: no rule on
    // this input tells it from a reply or tool output that starts with the same words.
    it.each([
      ["OAuth token revoked · Please run /login", false, "failed"],
      ["OAuth token revoked · Please run /login", true, "failed"],
      ["Please run /login · API Error: 401 OAuth token has expired", false, "resumed"],
      ["Please run /login · API Error: 401 OAuth token has expired", true, "resumed"],
      ["Please run /login · API Error: 401 Invalid authentication credentials", false, "resumed"],
      ["The error Please run /login · API Error: 401 means the token was rejected.", false, "resumed"],
    ])("reads the revoked refusal as current and a 401 as ready for input: %s (footer %s)", (reply, footer, status) => {
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude",
        paneContent: pane(["❯ hello", "", `● ${reply}`, ""], footer) }).status).toBe(status);
    });

    it.each([
      ["a refusal Claude wraps in a narrow pane", ["● Not logged in · Please run", "  /login"], "failed"],
      ["a revoked refusal Claude wraps", ["● OAuth token revoked · Please", "  run /login"], "failed"],
      ["a refusal with the right-aligned footer right below it", [`● ${refusal}`, "                    Not logged in · Run /login"], "failed"],
    ])("joins Claude's own wrapped rows: %s", (_name, rows, status) => {
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude",
        paneContent: pane(["❯ hello", "", ...rows, ""]) }).status).toBe(status);
    });

    // Review inputs (#1417): a submitted prompt with no input box drawn below it, quoted marker rows, and replies or
    // tool output that start like a 401.
    it.each([
      ["F1-current-no-box", `Claude Code v2.1.296\n❯ hello\n● ${refusal}\nNot logged in · Run /login`, "failed"],
      ["F1-recovered-no-box", `Claude Code v2.1.296\n❯ hello\n● ${refusal}\n❯ /login\n  ⎿ Login successful`, "resumed"],
      ["F2-quoted-reply-marker", `Claude Code v2.1.296\n❯ Explain this log.\n● Here is the quoted log line:\n\n  ● ${refusal}\n\n  That is an example, not this turn failing.\n\n${"─".repeat(40)}\n❯ \n${"─".repeat(40)}\n  ⏵⏵ accept edits on (shift+tab to cycle)`, "resumed"],
      ["R2-prefix-explanation", `Claude Code v2.1.296\n❯ Explain this output.\n● Please run /login · API Error: 401 is an example from the manual, not this request failing.\n\n${"─".repeat(40)}\n❯ \n${"─".repeat(40)}\n  ⏵⏵ accept edits on (shift+tab to cycle)`, "resumed"],
      ["R2-prefix-multiline-tool", `Claude Code v2.1.296\n❯ Explain this output.\n● Bash(print recorded fixture)\n  ⎿  Please run /login · API Error: 401 Invalid authentication credentials\n     This is recorded fixture output; the request succeeded.\n\n${"─".repeat(40)}\n❯ \n${"─".repeat(40)}\n  ⏵⏵ accept edits on (shift+tab to cycle)`, "resumed"],
      ["F2-quoted-prompt-marker", `Claude Code v2.1.296\n❯ Explain this log:\n  ● ${refusal}\n\n✶ Thinking… (2s)\n\n${"─".repeat(40)}\n❯ \n${"─".repeat(40)}\n  ⏵⏵ accept edits on (shift+tab to cycle)`, "resumed"],
    ])("%s", (_name, paneContent, status) => {
      const result = assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude", paneContent });
      expect(result.status).toBe(status);
      if (status === "failed") expect(result.code).toBe("login_required");
    });

    it("keeps the earlier native gates ahead of a current refusal", () => {
      const refused = pane(["❯ hello", "", `● ${refusal}`, ""], true);
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude",
        paneContent: `${refused}\nAccessing workspace:\nYes, I trust this folder` }).code).toBe("trust_gate");
      expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude",
        paneContent: `No conversation found\n${refused}` }).code).toBe("no_conversation_found");
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

  it.each(["codex", "node", "bash"])("recognizes the Codex 0.156.1 trust snapshot under %s", (paneCommand) => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand, paneContent: currentTrustPrompt }))
      .toMatchObject({ status: "inconclusive", code: "trust_gate" });
  });

  it.each(["›", "»"])("keeps the current trust panel below an earlier %s composer and custom footer gated", (prompt) => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: `${prompt} Earlier conversation prompt\n  Context 81% left · GPT-6-Astra high\n${currentTrustPrompt}`,
    })).toMatchObject({ status: "inconclusive", code: "trust_gate" });
  });

  it.each(["›", "»"])("accepts a headerless %s composer and custom footer after an old trust panel", (prompt) => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: `${currentTrustPrompt}\n${prompt} Continue\n  5h 71% left · GPT-6-Astra high · Context 81% left`,
    })).toMatchObject({ status: "resumed", code: "active_runtime" });
  });

  it.each([
    "  5h 71% left · GPT-6-Astra high · Context 81% left",
    "  gpt-6-astra high · /work",
    "  gpt-5.5 xhigh fast · Context 0% used · Fast on",
  ])("does not treat an old panel before a later model footer as current: %s", (footer) => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: `› Earlier conversation prompt\n${currentTrustPrompt}\n${footer}`,
    })).toMatchObject({ status: "resumed", code: "active_runtime" });
  });

  it.each(["", " ", "  ", "\t\t"])("preserves the whole-text default-footer match after blank lines with indentation %j", (indent) => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: `› Earlier conversation prompt\n${currentTrustPrompt}\n\n${indent}gpt-5.5 xhigh fast · Context 0% used · Fast on`,
    })).toMatchObject({ status: "resumed", code: "active_runtime" });
  });

  it("does not keep trust pending after a later composer without readiness corroboration", () => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: `${currentTrustPrompt}\n› Continue`,
    })).toMatchObject({ status: "inconclusive", code: "awaiting_runtime" });
  });

  it("keeps the latest panel current after an older panel was dismissed", () => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: `${currentTrustPrompt}\n› Continue\n  Context 81% left · GPT-6-Astra high\n${currentTrustPrompt}`,
    })).toMatchObject({ status: "inconclusive", code: "trust_gate" });
  });

  it.each([
    ["earlier custom footer", "› Earlier conversation prompt\n  Context 81% left · GPT-6-Astra high\n"],
    ["no earlier readiness evidence", ""],
  ])("retains a complete live trust panel before a trailing heading fragment: %s", (_label, before) => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: `${before}${currentTrustPrompt}\n  Trust this folder?`,
    })).toMatchObject({ status: "inconclusive", code: "trust_gate" });
  });

  it.each([
    ["default footer", "› Earlier conversation prompt\n  gpt-5.6-sol high · ~/work"],
    ["Codex header", "OpenAI Codex (v0.156.1)\n› Earlier conversation prompt"],
  ])("keeps a complete live trust panel ahead of earlier TUI evidence: %s", (_label, before) => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: `${before}\n${currentTrustPrompt}`,
    })).toMatchObject({ status: "inconclusive", code: "trust_gate" });
  });

  it.each(["›", "»"])("keeps a stale panel dismissed after a %s composer, footer and trailing heading fragment", (prompt) => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: `${currentTrustPrompt}\n${prompt} Continue\n  Context 81% left · GPT-6-Astra high\n  Trust this folder?`,
    })).toMatchObject({ status: "resumed", code: "active_runtime" });
  });

  it("recognizes the live trust panel when Quit is selected", () => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: currentTrustPrompt.replace("› 1. Trust and continue", "  1. Trust and continue").replace("  2. Quit", "› 2. Quit"),
    })).toMatchObject({ status: "inconclusive", code: "trust_gate" });
  });

  it("preserves the legacy branch even with a later headerless composer and custom footer", () => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No\n› Continue\n  Context 81% left · GPT-6-Astra high",
    })).toMatchObject({ status: "inconclusive", code: "trust_gate" });
  });

  it.each([
    "Trust this folder?",
    "› 1. Trust and continue\n  2. Quit",
    'The guide asks "Trust this folder?" and offers Trust and continue.',
  ])("does not classify incomplete or quoted current trust wording: %s", paneContent => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "codex", paneContent }).code)
      .not.toBe("trust_gate");
  });

  it("accepts the current TUI after a dismissed current trust snapshot", () => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: `${currentTrustPrompt}\nOpenAI Codex (v0.156.1)\n› Ask Codex to do anything`,
    })).toMatchObject({ status: "resumed", code: "active_runtime" });
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

  it("keeps a current update menu after an earlier composer gated", () => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "codex",
      paneContent: `› Earlier conversation prompt\n${currentUpdatePrompt}`,
    })).toMatchObject({ status: "inconclusive", code: "update_gate" });
  });

  it.each(["›", "»"])("ignores a copied current menu before a later %s composer and custom footer", (prompt) => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "codex",
      paneContent: `${currentUpdatePrompt.trimEnd()}\n${prompt} Continue\n  5h 71% left · GPT-6-Astra high · Context 81% left`,
    })).toMatchObject({ status: "resumed", code: "active_runtime" });
  });

  it.each([
    ["legacy", "✨ Update available! 0.117.0 -> 0.118.0\nPress enter to continue"],
    ["current", currentUpdatePrompt],
  ])("classifies %s Codex update prompts as inconclusive", (_layout, paneContent) => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex-aarch64-a",
        paneContent,
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
});
