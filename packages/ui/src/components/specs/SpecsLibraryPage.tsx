// V1 attempt-3 Phase 3 — Specs library top-level page per specs-tree.md L51–L82 + SC-28.

import { Link } from "@tanstack/react-router";
import { SectionHeader } from "../ui/section-header.js";
import { SpecsTable } from "./SpecsTable.js";

const TOOLBAR_ACTIONS: Array<{
  label: string;
  to: string;
  testId: string;
}> = [
  { label: "+ Add spec", to: "/specs/rig", testId: "specs-toolbar-add" },
  { label: "Discover", to: "/discovery", testId: "specs-toolbar-discover" },
  { label: "Import bundle", to: "/import", testId: "specs-toolbar-import" },
  { label: "Create rig", to: "/specs/rig", testId: "specs-toolbar-create-rig" },
  { label: "Generate workflow", to: "/specs/agent", testId: "specs-toolbar-gen-workflow" },
  { label: "Audit", to: "/search", testId: "specs-toolbar-audit" },
];

export function SpecsLibraryPage() {
  return (
    <div
      data-testid="specs-library-page"
      className="mx-auto w-full max-w-[1200px] px-6 py-8"
    >
      <header className="border-b border-outline-variant pb-4 mb-6">
        <SectionHeader tone="muted">Library</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-stone-900 mt-1">
          Specs
        </h1>
      </header>

      <div
        data-testid="specs-toolbar"
        role="toolbar"
        aria-label="Specs library actions"
        className="flex flex-wrap gap-2 mb-6"
      >
        {TOOLBAR_ACTIONS.map((a) => (
          <Link
            key={a.testId}
            to={a.to}
            data-testid={a.testId}
            className="inline-flex items-center px-3 py-1.5 border border-outline-variant bg-white font-mono text-[10px] uppercase tracking-[0.18em] text-stone-900 hover:bg-stone-100"
          >
            {a.label}
          </Link>
        ))}
      </div>

      <SpecsTable />
    </div>
  );
}
