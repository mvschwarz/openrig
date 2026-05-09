export type ToolBrandId =
  | "cmux"
  | "tmux"
  | "vscode"
  | "terminal"
  | "file"
  | "markdown"
  | "config"
  | "code"
  | "screenshot"
  | "proof"
  | "transcript"
  | "commit"
  | "folder"
  | "skill"
  | "video"
  | "trace"
  | "unknown";

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
  markdown: {
    id: "markdown",
    label: "Markdown",
    shortLabel: "MD",
    actionLabel: "Open markdown",
    tone: "neutral",
  },
  config: {
    id: "config",
    label: "Config",
    shortLabel: "YAML",
    actionLabel: "Open config",
    tone: "blue",
  },
  code: {
    id: "code",
    label: "Code",
    shortLabel: "Code",
    actionLabel: "Open code",
    tone: "slate",
  },
  screenshot: {
    id: "screenshot",
    label: "Screenshot",
    shortLabel: "Shot",
    actionLabel: "Open screenshot",
    tone: "amber",
  },
  proof: {
    id: "proof",
    label: "Proof",
    shortLabel: "Proof",
    actionLabel: "Open proof packet",
    tone: "green",
  },
  transcript: {
    id: "transcript",
    label: "Transcript",
    shortLabel: "Log",
    actionLabel: "Open transcript",
    tone: "slate",
  },
  commit: {
    id: "commit",
    label: "Commit",
    shortLabel: "Git",
    actionLabel: "Open commit",
    tone: "green",
  },
  folder: {
    id: "folder",
    label: "Folder",
    shortLabel: "Dir",
    actionLabel: "Open folder",
    tone: "neutral",
  },
  skill: {
    id: "skill",
    label: "Skill",
    shortLabel: "Skill",
    actionLabel: "Open skill",
    tone: "amber",
  },
  video: {
    id: "video",
    label: "Video",
    shortLabel: "Video",
    actionLabel: "Open video",
    tone: "blue",
  },
  trace: {
    id: "trace",
    label: "Trace",
    shortLabel: "Trace",
    actionLabel: "Open trace",
    tone: "neutral",
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
    normalized.endsWith(".gif") ||
    normalized.endsWith(".webp") ||
    normalized.endsWith(".svg") ||
    normalized.includes("screenshot")
  ) return "screenshot";
  if (
    normalized === "proof" ||
    normalized === "proof-packet" ||
    normalized.includes("proof packet") ||
    normalized.endsWith("proof.md")
  ) return "proof";
  if (
    normalized === "skill" ||
    normalized === "skill-folder" ||
    normalized === "skill.md" ||
    normalized.endsWith("/skill.md")
  ) return "skill";
  if (
    normalized === "folder" ||
    normalized === "directory" ||
    normalized === "dir"
  ) return "folder";
  if (
    normalized === "commit" ||
    normalized === "git" ||
    normalized.includes("commit") ||
    /^[a-f0-9]{7,40}$/.test(normalized)
  ) return "commit";
  if (
    normalized === "transcript" ||
    normalized.includes("transcript") ||
    normalized.endsWith(".log")
  ) return "transcript";
  if (
    normalized === "video" ||
    normalized.endsWith(".mp4") ||
    normalized.endsWith(".webm") ||
    normalized.endsWith(".mov")
  ) return "video";
  if (
    normalized === "trace" ||
    normalized.endsWith(".zip") ||
    normalized.endsWith(".har") ||
    normalized.endsWith(".trace")
  ) return "trace";
  if (
    normalized.endsWith(".md") ||
    normalized.endsWith(".mdx")
  ) return "markdown";
  if (
    normalized.endsWith(".yaml") ||
    normalized.endsWith(".yml") ||
    normalized.endsWith(".json") ||
    normalized.endsWith(".jsonl") ||
    normalized.endsWith(".toml")
  ) return "config";
  if (
    normalized.endsWith(".ts") ||
    normalized.endsWith(".tsx") ||
    normalized.endsWith(".js") ||
    normalized.endsWith(".jsx") ||
    normalized.endsWith(".py") ||
    normalized.endsWith(".rs") ||
    normalized.endsWith(".go") ||
    normalized.endsWith(".sh")
  ) return "code";
  if (
    normalized === "file" ||
    normalized === "path" ||
    normalized.includes("artifact") ||
    normalized.endsWith(".txt")
  ) return "file";
  return "unknown";
}

export function toolBrand(tool: string | null | undefined): ToolBrand {
  return TOOL_BRANDS[normalizeToolBrandId(tool)];
}
