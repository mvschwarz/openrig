export type RuntimeBrandId = "claude-code" | "codex" | "terminal" | "unknown";

export interface RuntimeBrand {
  id: RuntimeBrandId;
  label: string;
  shortLabel: string;
  tone: "sand" | "green" | "slate" | "neutral";
}

const RUNTIME_BRANDS: Record<RuntimeBrandId, RuntimeBrand> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude",
    shortLabel: "Claude",
    tone: "sand",
  },
  codex: {
    id: "codex",
    label: "Codex",
    shortLabel: "Codex",
    tone: "green",
  },
  terminal: {
    id: "terminal",
    label: "Terminal",
    shortLabel: "TTY",
    tone: "slate",
  },
  unknown: {
    id: "unknown",
    label: "Unknown",
    shortLabel: "Unknown",
    tone: "neutral",
  },
};

export function normalizeRuntimeBrandId(runtime: string | null | undefined): RuntimeBrandId {
  const normalized = runtime?.toLowerCase().trim() ?? "";
  if (normalized === "claude" || normalized === "claude-code" || normalized.includes("claude")) return "claude-code";
  if (normalized === "codex" || normalized.includes("codex") || normalized.includes("openai")) return "codex";
  if (normalized === "terminal" || normalized === "tmux" || normalized === "shell") return "terminal";
  return "unknown";
}

export function runtimeBrand(runtime: string | null | undefined): RuntimeBrand {
  return RUNTIME_BRANDS[normalizeRuntimeBrandId(runtime)];
}

export function formatRuntimeModel(runtime: string | null | undefined, model?: string | null): string {
  const brand = runtimeBrand(runtime);
  if (brand.id === "unknown") return model ?? "Runtime unknown";
  return model ? `${brand.label} / ${model}` : brand.label;
}
