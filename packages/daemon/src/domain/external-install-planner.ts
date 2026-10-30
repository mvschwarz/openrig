import type { ProbeResult } from "./requirements-probe.js";
import { shellQuote } from "../adapters/shell-quote.js";

/** Approval classification for an external install action */
export type ApprovalClassification = "auto_approvable" | "review_required" | "manual_only";

/** A single external install action in the plan */
export interface ExternalInstallAction {
  requirementName: string;
  kind: "cli_tool" | "system_package";
  provider: string | null;
  commandPreview: string | null;
  /** Literal native execution; previews and manifest hints are never parsed into argv. */
  commandArgv?: { file: string; args: string[] };
  classification: ApprovalClassification;
  installHints: Record<string, string> | null;
  reason: string;
}

/** The full external install plan */
export interface ExternalInstallPlan {
  actions: ExternalInstallAction[];
  autoApprovable: ExternalInstallAction[];
  reviewRequired: ExternalInstallAction[];
  manualOnly: ExternalInstallAction[];
  alreadyInstalled: string[];
}

interface PlannerOptions {
  platform?: string;
}

const WINDOWS_TOOL_IDS = new Map([["git", "Git.Git"], ["pwsh", "Microsoft.PowerShell"]]);

/**
 * Maps missing requirements to trusted provider install actions.
 * Homebrew on macOS and a bounded WinGet mapping on Windows.
 * install_hints from manifests are display-only — never executed.
 */
export class ExternalInstallPlanner {
  private platform: string;

  constructor(opts?: PlannerOptions) {
    this.platform = opts?.platform ?? process.platform;
  }

  /**
   * Build an install plan from probe results.
   * @param probeResults - results from RequirementsProbeRegistry.probeAll()
   */
  planInstalls(probeResults: ProbeResult[]): ExternalInstallPlan {
    const actions: ExternalInstallAction[] = [];
    const alreadyInstalled: string[] = [];

    for (const probe of probeResults) {
      if (probe.status === "installed") {
        alreadyInstalled.push(probe.name);
        continue;
      }

      const action = this.mapToAction(probe);
      actions.push(action);
    }

    return {
      actions,
      autoApprovable: actions.filter((a) => a.classification === "auto_approvable"),
      reviewRequired: actions.filter((a) => a.classification === "review_required"),
      manualOnly: actions.filter((a) => a.classification === "manual_only"),
      alreadyInstalled,
    };
  }

  private mapToAction(probe: ProbeResult): ExternalInstallAction {
    // Unsupported platform probe or unknown (probe failed) -> manual_only
    if (probe.status === "unsupported") {
      return {
        requirementName: probe.name,
        kind: probe.kind,
        provider: null,
        commandPreview: null,
        classification: "manual_only",
        installHints: probe.installHints,
        reason: "no trusted provider for this platform",
      };
    }

    if (probe.status === "unknown") {
      return {
        requirementName: probe.name,
        kind: probe.kind,
        provider: null,
        commandPreview: null,
        classification: "manual_only",
        installHints: probe.installHints,
        reason: "probe failed — cannot determine install action",
      };
    }

    // status === "missing" — try to map to a trusted provider
    if (this.platform === "win32" && probe.kind === "cli_tool") {
      // Explicit catalog identities; never treat arbitrary tool names or hints as package IDs.
      const id = WINDOWS_TOOL_IDS.get(probe.name);
      if (id) {
        const args = ["install", "--id", id, "--exact", "--source", "winget", "--scope", "user", "--silent", "--disable-interactivity", "--no-upgrade"];
        return { requirementName: probe.name, kind: probe.kind, provider: "winget",
          commandPreview: ["winget.exe", ...args].join(" "), commandArgv: { file: "winget.exe", args },
          classification: "review_required", installHints: probe.installHints,
          reason: "mapped WinGet user-scope install; source/package agreements must already be accepted" };
      }
    }
    if (this.platform === "darwin") {
      return {
        requirementName: probe.name,
        kind: probe.kind,
        provider: "homebrew",
        commandPreview: `brew install ${shellQuote(probe.name)}`,
        classification: "auto_approvable",
        installHints: probe.installHints,
        reason: "trusted Homebrew install",
      };
    }

    // Non-darwin with missing requirement -> manual_only
    return {
      requirementName: probe.name,
      kind: probe.kind,
      provider: null,
      commandPreview: null,
      classification: "manual_only",
      installHints: probe.installHints,
      reason: "no trusted provider for this platform",
    };
  }
}
