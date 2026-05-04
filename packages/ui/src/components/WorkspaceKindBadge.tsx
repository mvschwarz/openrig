// PL-007 Workspace Primitive v0 — shared workspace-kind label component.
//
// Renders a tiny badge for one of the 5 typed workspace kinds:
// user / project / knowledge / lab / delivery. Used across Files,
// Progress, Slices, Specs, and Steering surfaces to give consumers a
// consistent at-a-glance signal of "what kind of workspace is this?".
//
// Visual: small uppercase mono tag, distinct color per kind. Sized to fit
// in dense lists; `compact` prop strips to a single character glyph for
// space-constrained rows.

export type WorkspaceKindLabel = "user" | "project" | "knowledge" | "lab" | "delivery";

const KIND_META: Record<WorkspaceKindLabel, { label: string; glyph: string; bg: string; fg: string; border: string }> = {
  user:      { label: "USER",     glyph: "U", bg: "bg-violet-50",  fg: "text-violet-700",  border: "border-violet-200" },
  project:   { label: "PROJECT",  glyph: "P", bg: "bg-blue-50",    fg: "text-blue-700",    border: "border-blue-200" },
  knowledge: { label: "KNOW",     glyph: "K", bg: "bg-emerald-50", fg: "text-emerald-700", border: "border-emerald-200" },
  lab:       { label: "LAB",      glyph: "L", bg: "bg-amber-50",   fg: "text-amber-700",   border: "border-amber-200" },
  delivery:  { label: "DELIVERY", glyph: "D", bg: "bg-rose-50",    fg: "text-rose-700",    border: "border-rose-200" },
};

interface Props {
  kind: WorkspaceKindLabel;
  compact?: boolean;
  className?: string;
}

export function WorkspaceKindBadge({ kind, compact, className }: Props) {
  const meta = KIND_META[kind];
  if (!meta) return null;
  const base = `inline-block border ${meta.border} ${meta.bg} ${meta.fg} font-mono text-[8px] uppercase tracking-[0.14em] leading-none rounded-sm`;
  const sized = compact ? "px-1 py-[2px]" : "px-1.5 py-0.5";
  return (
    <span
      data-testid={`workspace-kind-badge-${kind}`}
      title={`workspace kind: ${kind}`}
      className={`${base} ${sized} ${className ?? ""}`.trim()}
    >
      {compact ? meta.glyph : meta.label}
    </span>
  );
}

/** Resolve a workspace kind for a given absolute path against a typed
 *  workspace block. Returns null when no match (the path is outside any
 *  declared repo or knowledge_root). Longest-prefix wins, mirroring the
 *  daemon-side resolveNodeWorkspace logic. */
export function resolveKindForPath(
  absolutePath: string | null | undefined,
  workspace: {
    repos: Array<{ name: string; path: string; kind: WorkspaceKindLabel }>;
    knowledgeRoot: string | null;
  } | null | undefined,
): WorkspaceKindLabel | null {
  if (!absolutePath || !workspace) return null;
  let best: { kind: WorkspaceKindLabel; len: number } | null = null;
  for (const r of workspace.repos) {
    if (isInsideOrEq(absolutePath, r.path) && r.path.length > (best?.len ?? -1)) {
      best = { kind: r.kind, len: r.path.length };
    }
  }
  if (best) return best.kind;
  if (workspace.knowledgeRoot && isInsideOrEq(absolutePath, workspace.knowledgeRoot)) {
    return "knowledge";
  }
  return null;
}

function isInsideOrEq(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}
