// V0.3.1 dashboard — thin composition over the vellum primitives.
// Single source of truth: this file and /lab/vellum-lab import the
// SAME components from ./vellum, so the production dashboard tracks
// the design lab exactly.
//
// Real-data wiring:
//   useRigSummary   → totalRigs, totalAgents
//   usePsEntries    → activeAgents
//   useSpecLibrary  → librarySize (Library card body)
//   window.location → hostname (classification eyebrow + Field Report)

import {
  MidLayerContent,
  TopLayerContent,
  DestinationsLayer,
} from "./vellum/index.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { usePsEntries } from "../../hooks/usePsEntries.js";
import { useSpecLibrary } from "../../hooks/useSpecLibrary.js";

// Simplified per founder dispatch 2026-05-15: removed BackLayerContent
// (the bold-black OPERATOR / OS·Ø tactical anchors) and BackVellumSheet
// (the heavy translucent paper sheet). Dashboard now sits on the
// page-level cream paper-grid background. Cards + top chrome + mid
// marginalia carry the tactical character without the heavy back-layer
// production. Matches the rest of the site better while preserving the
// vellum vocabulary (corner brackets, glitch marks, inky display, etc).
export function Dashboard() {
  const { data: rigs } = useRigSummary();
  const { data: psEntries } = usePsEntries();
  const { data: library } = useSpecLibrary();

  const totalRigs = rigs?.length ?? 0;
  const totalAgents = rigs?.reduce((acc, r) => acc + r.nodeCount, 0) ?? 0;
  const activeAgents = psEntries?.reduce((acc, p) => acc + p.runningCount, 0) ?? 0;
  const librarySize = library?.length ?? 0;
  const hostname =
    typeof window === "undefined" ? "localhost" : window.location.hostname || "localhost";

  return (
    <div data-testid="dashboard-surface" className="relative min-h-screen overflow-hidden">
      <MidLayerContent hostname={hostname} />
      <TopLayerContent
        hostname={hostname}
        totalRigs={totalRigs}
        totalAgents={totalAgents}
        activeAgents={activeAgents}
      />
      <DestinationsLayer librarySize={librarySize} />
    </div>
  );
}
