import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

interface SpecsPanelProps {
  onClose: () => void;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-stone-300/28 bg-white/10 px-3 py-3">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-stone-500">{title}</div>
      <p className="mt-2 text-[11px] leading-5 text-stone-600">{description}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {children}
      </div>
    </section>
  );
}

export function SpecsPanel({ onClose }: SpecsPanelProps) {
  const navigate = useNavigate();

  const openSurface = async (to: "/import" | "/bootstrap" | "/agents/validate") => {
    await navigate({ to });
    onClose();
  };

  return (
    <aside
      data-testid="specs-panel"
      className="absolute inset-y-0 right-0 z-20 w-80 border-l border-stone-300/25 bg-[rgba(250,249,245,0.035)] supports-[backdrop-filter]:bg-[rgba(250,249,245,0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[-6px_0_14px_rgba(46,52,46,0.04)] flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between border-b border-stone-300/35 px-4 py-3 shrink-0">
        <h2 className="min-w-0 truncate font-mono text-xs font-bold text-stone-900">specs</h2>
        <button
          data-testid="specs-close"
          onClick={onClose}
          className="text-stone-400 hover:text-stone-900 text-sm"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <Section
          title="Rig Specs"
          description="Import a rig spec, review it in the workspace, then instantiate or bootstrap it."
        >
          <Button variant="outline" size="sm" onClick={() => openSurface("/import")}>
            Import RigSpec
          </Button>
          <Button variant="outline" size="sm" onClick={() => openSurface("/bootstrap")}>
            Bootstrap
          </Button>
        </Section>

        <Section
          title="Agent Specs"
          description="Validate agent specs and use the workspace for spec-level review surfaces."
        >
          <Button variant="outline" size="sm" onClick={() => openSurface("/agents/validate")}>
            Validate AgentSpec
          </Button>
        </Section>
      </div>
    </aside>
  );
}
