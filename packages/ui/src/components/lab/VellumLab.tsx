// Vellum Lab — design experiment surface at /lab/vellum-lab.
//
// Post-refactor (2026-05-14): thin composition over the shared vellum
// primitives in ../dashboard/vellum. The lab and the production
// /dashboard surface render the SAME components — single source of
// truth for the visual system.
//
// The optional override props (backLayerOverride / vellumSheetOverride)
// stay so the /lab/vellum-bg/* background experiment routes keep
// working without forking the whole lab page.

import type { ReactNode } from "react";
import {
  MidLayerContent,
  TopLayerContent,
  DestinationsLayer,
} from "../dashboard/vellum/index.js";

interface VellumLabProps {
  /** Optional back-content override — only renders if provided.
   *  Default lab page is the SIMPLIFIED version (no back layer). The
   *  /lab/vellum-bg/* experiment routes pass overrides to test
   *  alternative back-layer compositions (topo lines / line art / etc). */
  backLayerOverride?: ReactNode;
  /** Optional back-vellum-sheet override — only renders if provided.
   *  Default lab page has no back sheet; experiment routes use this
   *  to test diffusion levels paired with their back-layer override. */
  vellumSheetOverride?: ReactNode;
}

export function VellumLab({
  backLayerOverride,
  vellumSheetOverride,
}: VellumLabProps = {}) {
  return (
    <div
      data-testid="vellum-lab"
      className="relative min-h-screen overflow-hidden"
    >
      {/* Optional back layers — render only if explicitly provided */}
      {backLayerOverride}
      {vellumSheetOverride}

      {/* Mid content (marginalia + scattered marks) */}
      <MidLayerContent />

      {/* Top chrome (eyebrow, hero, footer, EYES EVERYWHERE, marks) */}
      <TopLayerContent />

      {/* Destinations (clickable launcher cards) */}
      <DestinationsLayer />
    </div>
  );
}
