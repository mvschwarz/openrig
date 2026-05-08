export type ToolBrandId = "cmux" | "tmux" | "vscode" | "terminal" | "file" | "screenshot" | "unknown";

export interface ToolBrand {
  id: ToolBrandId;
  label: string;
  shortLabel: string;
  actionLabel: string;
  tone: "cyan" | "green" | "blue" | "amber" | "slate" | "neutral";
}

const TOOL_BRANDS: Record<ToolBrandId, ToolBrand> = {
  cmux: {
    id: "cmux",
    label: "CMUX",
    shortLabel: "CMUX",
    actionLabel: "Open in CMUX",
    tone: "cyan",
  },
  tmux: {
    id: "tmux",
    label: "tmux",
    shortLabel: "tmux",
    actionLabel: "Attach tmux",
    tone: "green",
  },
  vscode: {
    id: "vscode",
    label: "VS Code",
    shortLabel: "VS Code",
    actionLabel: "Open in VS Code",
    tone: "blue",
  },
  terminal: {
    id: "terminal",
    label: "Terminal",
    shortLabel: "TTY",
    actionLabel: "Preview terminal",
    tone: "slate",
  },
  file: {
    id: "file",
    label: "File",
    shortLabel: "File",
    actionLabel: "Open file",
    tone: "neutral",
  },
  screenshot: {
    id: "screenshot",
    label: "Screenshot",
    shortLabel: "Shot",
    actionLabel: "Open screenshot",
    tone: "amber",
  },
  unknown: {
    id: "unknown",
    label: "Unknown tool",
    shortLabel: "Unknown",
    actionLabel: "Open",
    tone: "neutral",
  },
};

export function normalizeToolBrandId(tool: string | null | undefined): ToolBrandId {
  const normalized = tool?.toLowerCase().trim() ?? "";
  if (normalized === "cmux" || normalized.includes("cmux")) return "cmux";
  if (normalized === "tmux" || normalized.includes("tmux")) return "tmux";
  if (
    normalized === "vscode" ||
    normalized === "vs-code" ||
    normalized === "vs code" ||
    normalized.includes("visual studio code")
  ) return "vscode";
  if (normalized === "terminal" || normalized === "tty" || normalized === "shell") return "terminal";
  if (
    normalized === "screenshot" ||
    normalized === "image" ||
    normalized === "proof-image" ||
    normalized.endsWith(".png") ||
    normalized.endsWith(".jpg") ||
    normalized.endsWith(".jpeg") ||
    normalized.includes("screenshot")
  ) return "screenshot";
  if (normalized === "file" || normalized === "path" || normalized.includes("artifact")) return "file";
  return "unknown";
}

export function toolBrand(tool: string | null | undefined): ToolBrand {
  return TOOL_BRANDS[normalizeToolBrandId(tool)];
}
